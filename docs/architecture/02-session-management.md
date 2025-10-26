# CLI Shell Integration: Session Management Architecture

**Version:** 1.0.0
**Component:** Enhanced Task Session Manager
**Date:** 2025-10-22
**Architect:** System Architect

---

## Executive Summary

The Task Session Manager is enhanced to support the `flume-agent` wrapper integration, providing robust session lifecycle management, state tracking, recovery mechanisms, and integration with terminal multiplexers (tmux/zellij).

**Key Enhancements:**
- Wrapper invocation instead of direct agent CLI execution
- Persistent session state tracking with recovery support
- Session health monitoring and cleanup automation
- Integration with existing Go session manager codebase

---

## Architecture Overview

### Current State (Existing)

The task-session-manager already implements:
- RabbitMQ consumer for `task.lifecycle.assigned` events
- Basic tmux/zellij session creation
- Agent CLI invocation
- Health check endpoint

**Location:** `/task-session-manager/`

### Required Enhancements

1. **Wrapper Integration:** Invoke `flume-agent` instead of raw agent CLI
2. **State Persistence:** Track sessions in SQLite for recovery
3. **Health Monitoring:** Detect stale/zombie sessions
4. **Cleanup Automation:** Scheduled cleanup of completed sessions
5. **Session Registry:** In-memory cache with disk persistence

---

## Detailed Design

### 1. Session State Schema

#### 1.1 Session State Model

```go
package session

import (
    "time"
)

// SessionStatus represents the current state of a session
type SessionStatus string

const (
    SessionStatusPending    SessionStatus = "pending"
    SessionStatusStarting   SessionStatus = "starting"
    SessionStatusRunning    SessionStatus = "running"
    SessionStatusCompleted  SessionStatus = "completed"
    SessionStatusFailed     SessionStatus = "failed"
    SessionStatusStale      SessionStatus = "stale"
    SessionStatusCleaning   SessionStatus = "cleaning"
)

// SessionRecord represents a managed terminal session
type SessionRecord struct {
    // Identity
    SessionID      string        `json:"session_id" db:"session_id"`
    TaskID         string        `json:"task_id" db:"task_id"`

    // Configuration
    AgentType      string        `json:"agent_type" db:"agent_type"`
    WorkingDir     string        `json:"working_dir" db:"working_dir"`

    // Runtime state
    SessionName    string        `json:"session_name" db:"session_name"`
    SessionManager ManagerType   `json:"session_manager" db:"session_manager"` // "tmux" or "zellij"
    AgentPID       int           `json:"agent_pid" db:"agent_pid"`
    WrapperPID     int           `json:"wrapper_pid" db:"wrapper_pid"`
    Status         SessionStatus `json:"status" db:"status"`

    // Timestamps
    CreatedAt      time.Time     `json:"created_at" db:"created_at"`
    StartedAt      *time.Time    `json:"started_at,omitempty" db:"started_at"`
    LastHeartbeat  *time.Time    `json:"last_heartbeat,omitempty" db:"last_heartbeat"`
    CompletedAt    *time.Time    `json:"completed_at,omitempty" db:"completed_at"`

    // Event correlation
    CorrelationID  string        `json:"correlation_id" db:"correlation_id"`
    ParentEventID  string        `json:"parent_event_id" db:"parent_event_id"`

    // Cleanup
    CleanupAt      *time.Time    `json:"cleanup_at,omitempty" db:"cleanup_at"`

    // Metadata
    ExitCode       *int          `json:"exit_code,omitempty" db:"exit_code"`
    ErrorMessage   string        `json:"error_message,omitempty" db:"error_message"`
    Metadata       string        `json:"metadata,omitempty" db:"metadata"` // JSON blob
}

// IsStale checks if session is stale based on last heartbeat
func (s *SessionRecord) IsStale(threshold time.Duration) bool {
    if s.Status != SessionStatusRunning {
        return false
    }

    if s.LastHeartbeat == nil {
        // No heartbeat yet, check started time
        if s.StartedAt == nil {
            return false
        }
        return time.Since(*s.StartedAt) > threshold
    }

    return time.Since(*s.LastHeartbeat) > threshold
}

// ShouldCleanup checks if session should be cleaned up
func (s *SessionRecord) ShouldCleanup() bool {
    if s.CleanupAt == nil {
        return false
    }
    return time.Now().After(*s.CleanupAt)
}
```

#### 1.2 Database Schema (SQLite)

```sql
-- migrations/001_create_sessions_table.sql

CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    agent_type      TEXT NOT NULL,
    working_dir     TEXT NOT NULL,
    session_name    TEXT NOT NULL,
    session_manager TEXT NOT NULL,
    agent_pid       INTEGER,
    wrapper_pid     INTEGER,
    status          TEXT NOT NULL,

    created_at      DATETIME NOT NULL,
    started_at      DATETIME,
    last_heartbeat  DATETIME,
    completed_at    DATETIME,
    cleanup_at      DATETIME,

    correlation_id  TEXT NOT NULL,
    parent_event_id TEXT,

    exit_code       INTEGER,
    error_message   TEXT,
    metadata        TEXT,

    CONSTRAINT valid_status CHECK (status IN (
        'pending', 'starting', 'running', 'completed', 'failed', 'stale', 'cleaning'
    ))
);

CREATE INDEX idx_sessions_task_id ON sessions(task_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_created_at ON sessions(created_at);
CREATE INDEX idx_sessions_cleanup_at ON sessions(cleanup_at);
```

---

### 2. Session Registry

#### 2.1 In-Memory Cache with Persistence

**Purpose:** Fast lookups with durability

```go
package session

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
    "time"

    _ "github.com/mattn/go-sqlite3"
    "github.com/rs/zerolog"
)

// Registry manages session state with in-memory cache and persistent storage
type Registry struct {
    db      *sql.DB
    cache   map[string]*SessionRecord
    mu      sync.RWMutex
    logger  zerolog.Logger
}

// NewRegistry creates a new session registry
func NewRegistry(dbPath string, logger zerolog.Logger) (*Registry, error) {
    db, err := sql.Open("sqlite3", dbPath)
    if err != nil {
        return nil, fmt.Errorf("failed to open database: %w", err)
    }

    // Run migrations
    if err := runMigrations(db); err != nil {
        db.Close()
        return nil, fmt.Errorf("failed to run migrations: %w", err)
    }

    r := &Registry{
        db:     db,
        cache:  make(map[string]*SessionRecord),
        logger: logger.With().Str("component", "session_registry").Logger(),
    }

    // Load existing sessions into cache
    if err := r.loadCache(); err != nil {
        db.Close()
        return nil, fmt.Errorf("failed to load cache: %w", err)
    }

    return r, nil
}

// Create creates a new session record
func (r *Registry) Create(ctx context.Context, record *SessionRecord) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    // Insert into database
    query := `
        INSERT INTO sessions (
            session_id, task_id, agent_type, working_dir, session_name, session_manager,
            status, created_at, correlation_id, parent_event_id, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    _, err := r.db.ExecContext(ctx, query,
        record.SessionID,
        record.TaskID,
        record.AgentType,
        record.WorkingDir,
        record.SessionName,
        record.SessionManager,
        record.Status,
        record.CreatedAt,
        record.CorrelationID,
        record.ParentEventID,
        record.Metadata,
    )

    if err != nil {
        return fmt.Errorf("failed to insert session: %w", err)
    }

    // Update cache
    r.cache[record.SessionID] = record

    r.logger.Info().
        Str("session_id", record.SessionID).
        Str("task_id", record.TaskID).
        Msg("Session created")

    return nil
}

// Update updates an existing session record
func (r *Registry) Update(ctx context.Context, record *SessionRecord) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    query := `
        UPDATE sessions SET
            agent_pid = ?,
            wrapper_pid = ?,
            status = ?,
            started_at = ?,
            last_heartbeat = ?,
            completed_at = ?,
            cleanup_at = ?,
            exit_code = ?,
            error_message = ?,
            metadata = ?
        WHERE session_id = ?
    `

    _, err := r.db.ExecContext(ctx, query,
        record.AgentPID,
        record.WrapperPID,
        record.Status,
        record.StartedAt,
        record.LastHeartbeat,
        record.CompletedAt,
        record.CleanupAt,
        record.ExitCode,
        record.ErrorMessage,
        record.Metadata,
        record.SessionID,
    )

    if err != nil {
        return fmt.Errorf("failed to update session: %w", err)
    }

    // Update cache
    r.cache[record.SessionID] = record

    return nil
}

// Get retrieves a session by ID
func (r *Registry) Get(sessionID string) (*SessionRecord, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    record, ok := r.cache[sessionID]
    if !ok {
        return nil, fmt.Errorf("session not found: %s", sessionID)
    }

    return record, nil
}

// GetByTaskID retrieves a session by task ID
func (r *Registry) GetByTaskID(taskID string) (*SessionRecord, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    for _, record := range r.cache {
        if record.TaskID == taskID {
            return record, nil
        }
    }

    return nil, fmt.Errorf("session not found for task: %s", taskID)
}

// List returns all sessions matching the filter
func (r *Registry) List(filter SessionFilter) ([]*SessionRecord, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    results := make([]*SessionRecord, 0)

    for _, record := range r.cache {
        if filter.Matches(record) {
            results = append(results, record)
        }
    }

    return results, nil
}

// UpdateHeartbeat updates the last heartbeat timestamp
func (r *Registry) UpdateHeartbeat(ctx context.Context, sessionID string) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    record, ok := r.cache[sessionID]
    if !ok {
        return fmt.Errorf("session not found: %s", sessionID)
    }

    now := time.Now()
    record.LastHeartbeat = &now

    query := `UPDATE sessions SET last_heartbeat = ? WHERE session_id = ?`
    _, err := r.db.ExecContext(ctx, query, now, sessionID)

    return err
}

// MarkForCleanup marks a session for cleanup after delay
func (r *Registry) MarkForCleanup(ctx context.Context, sessionID string, delay time.Duration) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    record, ok := r.cache[sessionID]
    if !ok {
        return fmt.Errorf("session not found: %s", sessionID)
    }

    cleanupAt := time.Now().Add(delay)
    record.CleanupAt = &cleanupAt
    record.Status = SessionStatusCleaning

    query := `UPDATE sessions SET cleanup_at = ?, status = ? WHERE session_id = ?`
    _, err := r.db.ExecContext(ctx, query, cleanupAt, SessionStatusCleaning, sessionID)

    return err
}

// Delete removes a session from registry
func (r *Registry) Delete(ctx context.Context, sessionID string) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    query := `DELETE FROM sessions WHERE session_id = ?`
    _, err := r.db.ExecContext(ctx, query, sessionID)

    if err != nil {
        return err
    }

    delete(r.cache, sessionID)

    r.logger.Info().Str("session_id", sessionID).Msg("Session deleted")

    return nil
}

// loadCache loads all sessions from database into memory
func (r *Registry) loadCache() error {
    rows, err := r.db.Query(`SELECT * FROM sessions`)
    if err != nil {
        return err
    }
    defer rows.Close()

    count := 0
    for rows.Next() {
        record := &SessionRecord{}
        err := rows.Scan(
            &record.SessionID,
            &record.TaskID,
            &record.AgentType,
            &record.WorkingDir,
            &record.SessionName,
            &record.SessionManager,
            &record.AgentPID,
            &record.WrapperPID,
            &record.Status,
            &record.CreatedAt,
            &record.StartedAt,
            &record.LastHeartbeat,
            &record.CompletedAt,
            &record.CleanupAt,
            &record.CorrelationID,
            &record.ParentEventID,
            &record.ExitCode,
            &record.ErrorMessage,
            &record.Metadata,
        )

        if err != nil {
            return err
        }

        r.cache[record.SessionID] = record
        count++
    }

    r.logger.Info().Int("count", count).Msg("Loaded sessions into cache")

    return nil
}

// Close closes the database connection
func (r *Registry) Close() error {
    return r.db.Close()
}

// SessionFilter for querying sessions
type SessionFilter struct {
    Status     *SessionStatus
    MinAge     *time.Duration
    MaxAge     *time.Duration
    StaleOnly  bool
}

func (f SessionFilter) Matches(record *SessionRecord) bool {
    if f.Status != nil && record.Status != *f.Status {
        return false
    }

    if f.MinAge != nil {
        age := time.Since(record.CreatedAt)
        if age < *f.MinAge {
            return false
        }
    }

    if f.MaxAge != nil {
        age := time.Since(record.CreatedAt)
        if age > *f.MaxAge {
            return false
        }
    }

    if f.StaleOnly && !record.IsStale(5 * time.Minute) {
        return false
    }

    return true
}
```

---

### 3. Enhanced Session Manager

#### 3.1 Wrapper Integration

**Modified CreateSession method:**

```go
// CreateSession creates a new terminal session with wrapper
func (m *Manager) CreateSession(ctx context.Context, event *events.TaskLifecycleAssigned) (*SessionInfo, error) {
    log := m.logger.With().
        Str("task_id", event.TaskID).
        Str("agent_type", event.AgentType).
        Logger()

    log.Info().Msg("Creating terminal session with wrapper")

    // Generate session ID
    sessionID := fmt.Sprintf("sess_%s_%d", event.TaskID, time.Now().Unix())
    sessionName := fmt.Sprintf("task-%s", event.TaskID)

    // Create session record
    record := &SessionRecord{
        SessionID:     sessionID,
        TaskID:        event.TaskID,
        AgentType:     event.AgentType,
        WorkingDir:    event.WorkingDir,
        SessionName:   sessionName,
        Status:        SessionStatusStarting,
        CreatedAt:     time.Now(),
        CorrelationID: event.CorrelationID,
        ParentEventID: event.CorrelationID, // From assigned event
    }

    // Register session
    if err := m.registry.Create(ctx, record); err != nil {
        return nil, fmt.Errorf("failed to create session record: %w", err)
    }

    // Prepare wrapper command
    wrapperCmd := m.buildWrapperCommand(event, sessionID)

    // Create terminal session based on manager type
    var info *SessionInfo
    var err error

    switch m.managerType {
    case Zellij:
        info, err = m.createZellijSessionWithWrapper(ctx, sessionName, event.WorkingDir, wrapperCmd)
    case Tmux:
        info, err = m.createTmuxSessionWithWrapper(ctx, sessionName, event.WorkingDir, wrapperCmd)
    default:
        return nil, fmt.Errorf("unsupported session manager: %s", m.managerType)
    }

    if err != nil {
        // Update record to failed
        record.Status = SessionStatusFailed
        record.ErrorMessage = err.Error()
        m.registry.Update(ctx, record)

        return nil, err
    }

    // Update record with runtime info
    now := time.Now()
    record.SessionManager = info.SessionManager
    record.WrapperPID = info.WrapperPID
    record.AgentPID = info.AgentPID
    record.Status = SessionStatusRunning
    record.StartedAt = &now

    if err := m.registry.Update(ctx, record); err != nil {
        log.Warn().Err(err).Msg("Failed to update session record")
    }

    log.Info().
        Str("session_id", sessionID).
        Int("wrapper_pid", info.WrapperPID).
        Msg("Session created successfully")

    return info, nil
}

// buildWrapperCommand constructs the flume-agent wrapper command
func (m *Manager) buildWrapperCommand(event *events.TaskLifecycleAssigned, sessionID string) string {
    // Write TASK.md to temp file
    taskFilePath := fmt.Sprintf("/tmp/flume_task_%s.md", event.TaskID)

    // Build wrapper command
    cmd := fmt.Sprintf(
        "flume-agent --task-id %s --agent %s --working-dir %s --task-file %s --event-source %s",
        event.TaskID,
        event.AgentType,
        event.WorkingDir,
        taskFilePath,
        event.CorrelationID,
    )

    return cmd
}

// createTmuxSessionWithWrapper creates tmux session and runs wrapper
func (m *Manager) createTmuxSessionWithWrapper(
    ctx context.Context,
    name string,
    workDir string,
    wrapperCmd string,
) (*SessionInfo, error) {
    // Create tmux session in detached mode
    cmd := exec.CommandContext(ctx, "tmux",
        "new-session",
        "-d",
        "-s", name,
        "-c", workDir,
        wrapperCmd,
    )

    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr

    if err := cmd.Run(); err != nil {
        return nil, fmt.Errorf("failed to create tmux session: %w (stderr: %s)", err, stderr.String())
    }

    // Get the PID of wrapper process
    time.Sleep(500 * time.Millisecond)
    wrapperPID, err := m.getTmuxPanePID(name)
    if err != nil {
        m.logger.Warn().Err(err).Msg("Could not get wrapper PID")
        wrapperPID = 0
    }

    return &SessionInfo{
        SessionID:      name,
        SessionManager: Tmux,
        WrapperPID:     wrapperPID,
        AgentPID:       0, // Will be populated by wrapper via events
        Command:        wrapperCmd,
        WorkingDir:     workDir,
    }, nil
}

// createZellijSessionWithWrapper creates zellij session and runs wrapper
func (m *Manager) createZellijSessionWithWrapper(
    ctx context.Context,
    name string,
    workDir string,
    wrapperCmd string,
) (*SessionInfo, error) {
    // Create zellij session
    cmd := exec.CommandContext(ctx, "zellij",
        "--session", name,
        "options", "--default-cwd", workDir,
    )

    if err := cmd.Run(); err != nil {
        return nil, fmt.Errorf("failed to create zellij session: %w", err)
    }

    // Run wrapper command in session
    runCmd := exec.CommandContext(ctx, "zellij",
        "--session", name,
        "run", "--",
        "sh", "-c", wrapperCmd,
    )
    runCmd.Dir = workDir

    if err := runCmd.Start(); err != nil {
        return nil, fmt.Errorf("failed to start wrapper in zellij: %w", err)
    }

    wrapperPID := runCmd.Process.Pid

    return &SessionInfo{
        SessionID:      name,
        SessionManager: Zellij,
        WrapperPID:     wrapperPID,
        AgentPID:       0,
        Command:        wrapperCmd,
        WorkingDir:     workDir,
    }, nil
}
```

---

### 4. Session Health Monitoring

#### 4.1 Heartbeat Consumer

**Listen to in_progress events to update heartbeat:**

```go
// HeartbeatProcessor processes heartbeat events
type HeartbeatProcessor struct {
    registry *Registry
    logger   zerolog.Logger
}

func (p *HeartbeatProcessor) ProcessInProgressEvent(event *events.TaskLifecycleInProgress) error {
    // Find session by task ID
    record, err := p.registry.GetByTaskID(event.TaskID)
    if err != nil {
        return fmt.Errorf("session not found for task %s: %w", event.TaskID, err)
    }

    // Update heartbeat timestamp
    ctx := context.Background()
    if err := p.registry.UpdateHeartbeat(ctx, record.SessionID); err != nil {
        return fmt.Errorf("failed to update heartbeat: %w", err)
    }

    p.logger.Debug().
        Str("session_id", record.SessionID).
        Str("task_id", event.TaskID).
        Msg("Heartbeat updated")

    return nil
}
```

#### 4.2 Stale Session Detection

**Background goroutine to detect stale sessions:**

```go
// StaleDetector runs periodic checks for stale sessions
type StaleDetector struct {
    registry       *Registry
    publisher      *events.Publisher
    interval       time.Duration
    staleThreshold time.Duration
    logger         zerolog.Logger
    stopCh         chan struct{}
}

func NewStaleDetector(
    registry *Registry,
    publisher *events.Publisher,
    interval time.Duration,
    staleThreshold time.Duration,
    logger zerolog.Logger,
) *StaleDetector {
    return &StaleDetector{
        registry:       registry,
        publisher:      publisher,
        interval:       interval,
        staleThreshold: staleThreshold,
        logger:         logger,
        stopCh:         make(chan struct{}),
    }
}

func (d *StaleDetector) Start() {
    go func() {
        ticker := time.NewTicker(d.interval)
        defer ticker.Stop()

        for {
            select {
            case <-ticker.C:
                d.checkStaleSessions()
            case <-d.stopCh:
                return
            }
        }
    }()
}

func (d *StaleDetector) Stop() {
    close(d.stopCh)
}

func (d *StaleDetector) checkStaleSessions() {
    ctx := context.Background()

    // Get all running sessions
    statusRunning := SessionStatusRunning
    filter := SessionFilter{Status: &statusRunning}

    sessions, err := d.registry.List(filter)
    if err != nil {
        d.logger.Error().Err(err).Msg("Failed to list sessions")
        return
    }

    for _, record := range sessions {
        if record.IsStale(d.staleThreshold) {
            d.handleStaleSession(ctx, record)
        }
    }
}

func (d *StaleDetector) handleStaleSession(ctx context.Context, record *SessionRecord) {
    d.logger.Warn().
        Str("session_id", record.SessionID).
        Str("task_id", record.TaskID).
        Msg("Detected stale session")

    // Update status to stale
    record.Status = SessionStatusStale
    if err := d.registry.Update(ctx, record); err != nil {
        d.logger.Error().Err(err).Msg("Failed to update stale session")
    }

    // Emit alert event
    d.publisher.PublishAlert(record.TaskID, "stale", "Session has not sent heartbeat", nil)
}
```

---

### 5. Session Cleanup Automation

#### 5.1 Cleanup Scheduler

```go
// CleanupScheduler handles automated session cleanup
type CleanupScheduler struct {
    registry *Registry
    manager  *Manager
    interval time.Duration
    logger   zerolog.Logger
    stopCh   chan struct{}
}

func NewCleanupScheduler(
    registry *Registry,
    manager *Manager,
    interval time.Duration,
    logger zerolog.Logger,
) *CleanupScheduler {
    return &CleanupScheduler{
        registry: registry,
        manager:  manager,
        interval: interval,
        logger:   logger,
        stopCh:   make(chan struct{}),
    }
}

func (c *CleanupScheduler) Start() {
    go func() {
        ticker := time.NewTicker(c.interval)
        defer ticker.Stop()

        for {
            select {
            case <-ticker.C:
                c.runCleanup()
            case <-c.stopCh:
                return
            }
        }
    }()
}

func (c *CleanupScheduler) Stop() {
    close(c.stopCh)
}

func (c *CleanupScheduler) runCleanup() {
    ctx := context.Background()

    // Get all sessions marked for cleanup
    statusCleaning := SessionStatusCleaning
    filter := SessionFilter{Status: &statusCleaning}

    sessions, err := c.registry.List(filter)
    if err != nil {
        c.logger.Error().Err(err).Msg("Failed to list sessions for cleanup")
        return
    }

    for _, record := range sessions {
        if record.ShouldCleanup() {
            c.cleanupSession(ctx, record)
        }
    }
}

func (c *CleanupScheduler) cleanupSession(ctx context.Context, record *SessionRecord) {
    c.logger.Info().
        Str("session_id", record.SessionID).
        Str("task_id", record.TaskID).
        Msg("Cleaning up session")

    // Kill the terminal session
    if err := c.manager.KillSession(ctx, record.SessionName); err != nil {
        c.logger.Warn().Err(err).Msg("Failed to kill session (may already be dead)")
    }

    // Delete from registry
    if err := c.registry.Delete(ctx, record.SessionID); err != nil {
        c.logger.Error().Err(err).Msg("Failed to delete session record")
    }

    c.logger.Info().
        Str("session_id", record.SessionID).
        Msg("Session cleaned up successfully")
}
```

---

### 6. Session Recovery

#### 6.1 Recovery on Restart

**When task-session-manager restarts:**

```go
// RecoverSessions attempts to reconnect to existing sessions
func (m *Manager) RecoverSessions(ctx context.Context) error {
    m.logger.Info().Msg("Recovering existing sessions")

    // Get all sessions that were running
    statusRunning := SessionStatusRunning
    filter := SessionFilter{Status: &statusRunning}

    sessions, err := m.registry.List(filter)
    if err != nil {
        return fmt.Errorf("failed to list sessions: %w", err)
    }

    recovered := 0
    failed := 0

    for _, record := range sessions {
        if err := m.recoverSession(ctx, record); err != nil {
            m.logger.Warn().
                Err(err).
                Str("session_id", record.SessionID).
                Msg("Failed to recover session")
            failed++
        } else {
            recovered++
        }
    }

    m.logger.Info().
        Int("recovered", recovered).
        Int("failed", failed).
        Msg("Session recovery complete")

    return nil
}

func (m *Manager) recoverSession(ctx context.Context, record *SessionRecord) error {
    // Check if session still exists in terminal multiplexer
    exists, err := m.sessionExists(record.SessionName)
    if err != nil {
        return err
    }

    if !exists {
        // Session is dead, mark as failed
        record.Status = SessionStatusFailed
        record.ErrorMessage = "Session not found after restart"
        return m.registry.Update(ctx, record)
    }

    // Check if wrapper process is still running
    if record.WrapperPID > 0 && !processExists(record.WrapperPID) {
        // Wrapper is dead, mark as failed
        record.Status = SessionStatusFailed
        record.ErrorMessage = "Wrapper process not found after restart"
        return m.registry.Update(ctx, record)
    }

    m.logger.Info().
        Str("session_id", record.SessionID).
        Str("task_id", record.TaskID).
        Msg("Session recovered successfully")

    return nil
}

func (m *Manager) sessionExists(sessionName string) (bool, error) {
    sessions, err := m.ListSessions(context.Background())
    if err != nil {
        return false, err
    }

    for _, name := range sessions {
        if name == sessionName {
            return true, nil
        }
    }

    return false, nil
}

func processExists(pid int) bool {
    process, err := os.FindProcess(pid)
    if err != nil {
        return false
    }

    // Send signal 0 to check if process exists
    err = process.Signal(syscall.Signal(0))
    return err == nil
}
```

---

### 7. Integration with Existing Code

#### 7.1 Modified Consumer

**Update event consumer to use enhanced session manager:**

```go
// In internal/consumer/consumer.go

func (c *Consumer) handleAssignedEvent(ctx context.Context, event *events.TaskLifecycleAssigned) error {
    c.logger.Info().
        Str("task_id", event.TaskID).
        Str("agent_type", event.AgentType).
        Msg("Processing task assignment")

    // Create session with wrapper
    sessionInfo, err := c.sessionMgr.CreateSession(ctx, event)
    if err != nil {
        c.logger.Error().Err(err).Msg("Failed to create session")

        // Emit failed event
        failedEvent := &events.TaskLifecycleFailed{
            TaskID:        event.TaskID,
            Reason:        "session_creation_failed",
            ErrorDetails:  err.Error(),
            FailedAt:      time.Now(),
            CorrelationID: event.CorrelationID,
        }

        return c.publisher.EmitFailed(failedEvent)
    }

    c.logger.Info().
        Str("task_id", event.TaskID).
        Str("session_id", sessionInfo.SessionID).
        Msg("Session created successfully")

    // Note: Started event will be emitted by the wrapper itself
    return nil
}
```

---

### 8. Configuration Updates

```yaml
# config.yaml additions

session:
  preferred_manager: "zellij"
  default_work_dir: "/tmp"
  startup_timeout: 30s

  # Session persistence
  database_path: "~/.local/share/flume/sessions.db"

  # Health monitoring
  heartbeat_timeout: 300s  # 5 minutes
  stale_check_interval: 60s

  # Cleanup
  cleanup_delay: 3600s  # 1 hour after completion
  cleanup_interval: 300s  # Check every 5 minutes

  # Recovery
  recover_on_startup: true
```

---

## Performance Characteristics

| Operation | Target | Notes |
|-----------|--------|-------|
| Session Creation | < 3s | Including wrapper startup |
| Registry Lookup | < 1ms | In-memory cache |
| Registry Update | < 10ms | SQLite write |
| Stale Detection | < 100ms | For 1000 sessions |
| Cleanup | < 1s | Per session |
| Recovery | < 5s | For 100 sessions |

---

## Testing Strategy

### Unit Tests

```go
func TestSessionRegistry(t *testing.T) {
    registry := setupTestRegistry(t)
    defer registry.Close()

    record := &SessionRecord{
        SessionID: "test-sess-001",
        TaskID:    "TASK-001",
        Status:    SessionStatusPending,
        CreatedAt: time.Now(),
    }

    // Test create
    err := registry.Create(context.Background(), record)
    assert.NoError(t, err)

    // Test get
    retrieved, err := registry.Get("test-sess-001")
    assert.NoError(t, err)
    assert.Equal(t, "TASK-001", retrieved.TaskID)

    // Test update
    record.Status = SessionStatusRunning
    err = registry.Update(context.Background(), record)
    assert.NoError(t, err)
}
```

---

## Security Considerations

1. **Database Permissions:** SQLite file should be 0600 (owner read/write only)
2. **PID Validation:** Validate PIDs before sending signals
3. **Session Isolation:** Ensure sessions cannot interfere with each other
4. **Cleanup Safety:** Confirm session ownership before cleanup

---

**End of Session Management Architecture Document**
