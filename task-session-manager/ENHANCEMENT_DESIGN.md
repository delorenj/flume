# Task Session Manager Enhancement Design

**Project:** Flume Task Lifecycle System
**Component:** Enhanced Task Session Manager (Go)
**Version:** 2.0.0
**Date:** 2025-10-22
**Status:** Design Complete - Implementation Ready

---

## Executive Summary

This document outlines the enhancements to the existing Go task-session-manager to integrate with the flume-agent wrapper, add session recovery capabilities, implement state tracking with optional persistence, and provide robust session lifecycle management.

### Enhancement Objectives

1. **Wrapper Integration**: Invoke flume-agent wrapper instead of raw agent CLIs
2. **State Tracking**: In-memory session state with optional SQLite persistence
3. **Session Recovery**: Reconnect to existing sessions on restart
4. **Cleanup Management**: Detect and clean up stale/zombie sessions
5. **Configuration**: YAML-based configuration with environment variable overrides

### Key Metrics

- **Backward Compatibility**: 100% - existing functionality preserved
- **New Features**: 5 major capabilities added
- **Test Coverage Target**: 95%+
- **Performance Impact**: < 5% overhead

---

## Architecture Overview

### Current Architecture (v1.0.0)

```
RabbitMQ Event → Consumer → Session Manager → Tmux/Zellij Session → Raw Agent CLI
                                  ↓
                              Publisher → RabbitMQ (started/failed events)
```

**Current Limitations:**
- No awareness of session state after creation
- Cannot recover sessions after restart
- No cleanup of stale sessions
- Invokes raw agent CLIs directly
- No persistence of session information

### Enhanced Architecture (v2.0.0)

```
RabbitMQ Event → Consumer → Session Manager → Session State Store
                                  ↓                    ↓
                    Tmux/Zellij Session ← Wrapper → SQLite (optional)
                           ↓                         ↓
                    flume-agent wrapper         Recovery Manager
                           ↓                         ↓
                    Agent CLI (claude/etc)     Cleanup Manager
                           ↓                         ↓
                    Publisher → RabbitMQ      Health Monitor
```

**New Capabilities:**
- Session state tracking in memory and SQLite
- Session recovery on restart
- Automatic stale session detection
- Wrapper-based agent invocation
- Health monitoring and cleanup
- Configuration file support

---

## Component Design

### 1. Session State Management

#### 1.1 SessionState Type

```go
// SessionState represents the current state of a task session
type SessionState struct {
    // Identity
    TaskID        string    `json:"task_id" db:"task_id"`
    SessionID     string    `json:"session_id" db:"session_id"`
    SessionName   string    `json:"session_name" db:"session_name"`

    // Configuration
    AgentType     string    `json:"agent_type" db:"agent_type"`
    WorkingDir    string    `json:"working_dir" db:"working_dir"`
    Command       string    `json:"command" db:"command"`

    // Runtime State
    Status        Status    `json:"status" db:"status"`
    PID           int       `json:"pid" db:"pid"`

    // Timing
    StartTime     time.Time `json:"start_time" db:"start_time"`
    LastHeartbeat time.Time `json:"last_heartbeat" db:"last_heartbeat"`
    CompletedAt   *time.Time `json:"completed_at,omitempty" db:"completed_at"`

    // Metadata
    EventID       string    `json:"event_id" db:"event_id"`
    CorrelationID string    `json:"correlation_id" db:"correlation_id"`
    Metadata      map[string]interface{} `json:"metadata,omitempty"`
}

// Status represents session lifecycle status
type Status string

const (
    StatusRunning   Status = "running"
    StatusStale     Status = "stale"      // No heartbeat for threshold period
    StatusCompleted Status = "completed"
    StatusFailed    Status = "failed"
    StatusPaused    Status = "paused"
)

// IsTerminal returns true if status is terminal (completed/failed)
func (s Status) IsTerminal() bool {
    return s == StatusCompleted || s == StatusFailed
}

// IsActive returns true if session is actively running
func (s Status) IsActive() bool {
    return s == StatusRunning
}
```

#### 1.2 StateStore Interface

```go
// StateStore defines the interface for session state persistence
type StateStore interface {
    // Store saves or updates a session state
    Store(ctx context.Context, state *SessionState) error

    // Get retrieves a session state by task ID
    Get(ctx context.Context, taskID string) (*SessionState, error)

    // List returns all sessions matching the filter
    List(ctx context.Context, filter StateFilter) ([]*SessionState, error)

    // Delete removes a session state
    Delete(ctx context.Context, taskID string) error

    // UpdateHeartbeat updates the last heartbeat time
    UpdateHeartbeat(ctx context.Context, taskID string, timestamp time.Time) error

    // UpdateStatus updates the session status
    UpdateStatus(ctx context.Context, taskID string, status Status) error

    // Close closes the store connection
    Close() error
}

// StateFilter defines filtering criteria for listing sessions
type StateFilter struct {
    Status       *Status
    AgentType    *string
    StaleSince   *time.Duration
    StartedAfter *time.Time
    Limit        int
}
```

#### 1.3 In-Memory Store Implementation

```go
// MemoryStore provides in-memory session state storage
type MemoryStore struct {
    mu     sync.RWMutex
    states map[string]*SessionState
    logger zerolog.Logger
}

// NewMemoryStore creates a new in-memory state store
func NewMemoryStore(logger zerolog.Logger) *MemoryStore {
    return &MemoryStore{
        states: make(map[string]*SessionState),
        logger: logger.With().Str("store", "memory").Logger(),
    }
}

// Implementation of StateStore interface methods...
```

#### 1.4 SQLite Store Implementation

```go
// SQLiteStore provides persistent session state storage
type SQLiteStore struct {
    db     *sql.DB
    logger zerolog.Logger
}

// NewSQLiteStore creates a new SQLite state store
func NewSQLiteStore(dbPath string, logger zerolog.Logger) (*SQLiteStore, error) {
    db, err := sql.Open("sqlite3", dbPath)
    if err != nil {
        return nil, fmt.Errorf("failed to open database: %w", err)
    }

    store := &SQLiteStore{
        db:     db,
        logger: logger.With().Str("store", "sqlite").Logger(),
    }

    if err := store.initSchema(); err != nil {
        return nil, err
    }

    return store, nil
}

// initSchema creates the necessary database tables
func (s *SQLiteStore) initSchema() error {
    schema := `
    CREATE TABLE IF NOT EXISTS sessions (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER NOT NULL,
        start_time TIMESTAMP NOT NULL,
        last_heartbeat TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        event_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_last_heartbeat ON sessions(last_heartbeat);
    CREATE INDEX IF NOT EXISTS idx_agent_type ON sessions(agent_type);
    `

    _, err := s.db.Exec(schema)
    return err
}

// Implementation of StateStore interface methods...
```

---

### 2. Wrapper Integration

#### 2.1 WrapperConfig Type

```go
// WrapperConfig holds configuration for the flume-agent wrapper
type WrapperConfig struct {
    // Path to the wrapper binary/script
    WrapperPath string

    // Arguments template for the wrapper
    ArgsTemplate []string

    // Environment variables to pass
    Environment map[string]string

    // Timeout for wrapper execution
    Timeout time.Duration
}
```

#### 2.2 Enhanced CreateSession Method

```go
// CreateSession creates a new terminal session with wrapper integration
func (m *Manager) CreateSession(ctx context.Context, event *events.TaskLifecycleAssigned) (*SessionInfo, error) {
    log := m.logger.With().
        Str("task_id", event.TaskID).
        Str("agent_type", event.AgentType).
        Logger()

    log.Info().Msg("Creating terminal session with wrapper")

    // Determine session name
    sessionName := fmt.Sprintf("task-%s", event.TaskID)

    // Validate working directory
    workDir := event.WorkingDir
    if workDir == "" {
        workDir = m.cfg.Session.DefaultWorkDir
    }
    if _, err := os.Stat(workDir); os.IsNotExist(err) {
        return nil, fmt.Errorf("working directory does not exist: %s", workDir)
    }

    // Prepare wrapper command
    wrapperCmd, err := m.buildWrapperCommand(event, sessionName, workDir)
    if err != nil {
        return nil, fmt.Errorf("failed to build wrapper command: %w", err)
    }

    log.Info().
        Str("session_name", sessionName).
        Str("work_dir", workDir).
        Str("wrapper_cmd", wrapperCmd).
        Str("manager", string(m.managerType)).
        Msg("Session configuration")

    // Create session based on manager type
    var info *SessionInfo
    switch m.managerType {
    case Zellij:
        info, err = m.createZellijSession(ctx, sessionName, workDir, wrapperCmd, event.Environment)
    case Tmux:
        info, err = m.createTmuxSession(ctx, sessionName, workDir, wrapperCmd, event.Environment)
    default:
        return nil, fmt.Errorf("unsupported session manager: %s", m.managerType)
    }

    if err != nil {
        log.Error().Err(err).Msg("Failed to create session")
        return nil, err
    }

    // Create session state
    state := &SessionState{
        TaskID:        event.TaskID,
        SessionID:     info.SessionID,
        SessionName:   sessionName,
        AgentType:     event.AgentType,
        WorkingDir:    workDir,
        Command:       wrapperCmd,
        Status:        StatusRunning,
        PID:           info.AgentPID,
        StartTime:     time.Now(),
        LastHeartbeat: time.Now(),
        EventID:       event.CorrelationID,
        CorrelationID: event.CorrelationID,
        Metadata:      event.Metadata,
    }

    // Store session state
    if err := m.stateStore.Store(ctx, state); err != nil {
        log.Error().Err(err).Msg("Failed to store session state")
        // Non-fatal - continue with session creation
    }

    log.Info().
        Str("session_id", info.SessionID).
        Int("agent_pid", info.AgentPID).
        Msg("Session created successfully")

    return info, nil
}
```

#### 2.3 Wrapper Command Builder

```go
// buildWrapperCommand constructs the command to invoke the flume-agent wrapper
func (m *Manager) buildWrapperCommand(event *events.TaskLifecycleAssigned, sessionName, workDir string) (string, error) {
    if m.cfg.Wrapper.Enabled {
        // Use wrapper if enabled
        args := []string{
            m.cfg.Wrapper.Path,
            "--task-id", event.TaskID,
            "--agent", event.AgentType,
            "--working-dir", workDir,
            "--session-id", sessionName,
            "--event-source", event.CorrelationID,
        }

        // Add optional task file if available
        if event.TaskFile != "" {
            args = append(args, "--task-file", event.TaskFile)
        }

        // Add heartbeat interval
        if m.cfg.Wrapper.HeartbeatInterval > 0 {
            args = append(args, "--heartbeat", fmt.Sprintf("%d", int(m.cfg.Wrapper.HeartbeatInterval.Seconds())))
        }

        return strings.Join(args, " "), nil
    }

    // Fallback to raw agent command
    agentCmd := m.getAgentCommand(event.AgentType)
    if event.Command != "" {
        agentCmd = event.Command
    }
    return agentCmd, nil
}
```

---

### 3. Session Recovery

#### 3.1 Recovery Manager

```go
// RecoveryManager handles session recovery on restart
type RecoveryManager struct {
    sessionMgr  *Manager
    stateStore  StateStore
    publisher   *publisher.Publisher
    logger      zerolog.Logger
    cfg         *config.Config
}

// NewRecoveryManager creates a new recovery manager
func NewRecoveryManager(
    sessionMgr *Manager,
    stateStore StateStore,
    publisher *publisher.Publisher,
    cfg *config.Config,
    logger zerolog.Logger,
) *RecoveryManager {
    return &RecoveryManager{
        sessionMgr: sessionMgr,
        stateStore: stateStore,
        publisher:  publisher,
        logger:     logger.With().Str("component", "recovery").Logger(),
        cfg:        cfg,
    }
}

// RecoverSessions attempts to recover existing sessions
func (r *RecoveryManager) RecoverSessions(ctx context.Context) error {
    r.logger.Info().Msg("Starting session recovery")

    // Get all active sessions from state store
    filter := StateFilter{
        Status: statusPtr(StatusRunning),
    }

    states, err := r.stateStore.List(ctx, filter)
    if err != nil {
        return fmt.Errorf("failed to list sessions: %w", err)
    }

    r.logger.Info().Int("count", len(states)).Msg("Found sessions to recover")

    recovered := 0
    failed := 0
    stale := 0

    for _, state := range states {
        log := r.logger.With().
            Str("task_id", state.TaskID).
            Str("session_name", state.SessionName).
            Logger()

        // Check if session still exists
        exists, err := r.sessionMgr.SessionExists(ctx, state.SessionName)
        if err != nil {
            log.Error().Err(err).Msg("Failed to check session existence")
            failed++
            continue
        }

        if !exists {
            log.Warn().Msg("Session no longer exists, marking as stale")
            if err := r.stateStore.UpdateStatus(ctx, state.TaskID, StatusStale); err != nil {
                log.Error().Err(err).Msg("Failed to update status")
            }
            stale++
            continue
        }

        // Session exists - reconnect monitoring
        log.Info().Msg("Session recovered")

        // Emit recovery event
        if err := r.emitRecoveryEvent(ctx, state); err != nil {
            log.Error().Err(err).Msg("Failed to emit recovery event")
        }

        recovered++
    }

    r.logger.Info().
        Int("recovered", recovered).
        Int("stale", stale).
        Int("failed", failed).
        Msg("Session recovery complete")

    return nil
}

// emitRecoveryEvent emits a session recovery event
func (r *RecoveryManager) emitRecoveryEvent(ctx context.Context, state *SessionState) error {
    event := &events.TaskLifecycleRecovered{
        TaskID:         state.TaskID,
        SessionID:      state.SessionID,
        SessionManager: string(r.sessionMgr.managerType),
        AgentPID:       state.PID,
        AgentType:      state.AgentType,
        WorkingDir:     state.WorkingDir,
        RecoveredAt:    time.Now(),
        OriginalStart:  state.StartTime,
        CorrelationID:  state.CorrelationID,
        Metadata:       state.Metadata,
    }

    return r.publisher.PublishRecovered(ctx, event)
}
```

#### 3.2 Session Existence Checks

```go
// SessionExists checks if a session exists in the terminal multiplexer
func (m *Manager) SessionExists(ctx context.Context, sessionName string) (bool, error) {
    sessions, err := m.ListSessions(ctx)
    if err != nil {
        return false, err
    }

    for _, s := range sessions {
        if s == sessionName {
            return true, nil
        }
    }

    return false, nil
}
```

---

### 4. Session Cleanup

#### 4.1 Cleanup Manager

```go
// CleanupManager handles automatic session cleanup
type CleanupManager struct {
    sessionMgr *Manager
    stateStore StateStore
    logger     zerolog.Logger
    cfg        *config.Config
    stopChan   chan struct{}
    wg         sync.WaitGroup
}

// NewCleanupManager creates a new cleanup manager
func NewCleanupManager(
    sessionMgr *Manager,
    stateStore StateStore,
    cfg *config.Config,
    logger zerolog.Logger,
) *CleanupManager {
    return &CleanupManager{
        sessionMgr: sessionMgr,
        stateStore: stateStore,
        logger:     logger.With().Str("component", "cleanup").Logger(),
        cfg:        cfg,
        stopChan:   make(chan struct{}),
    }
}

// Start begins the cleanup monitoring loop
func (c *CleanupManager) Start(ctx context.Context) {
    c.wg.Add(1)
    go c.cleanupLoop(ctx)
}

// Stop stops the cleanup monitoring loop
func (c *CleanupManager) Stop() {
    close(c.stopChan)
    c.wg.Wait()
}

// cleanupLoop periodically checks for sessions to clean up
func (c *CleanupManager) cleanupLoop(ctx context.Context) {
    defer c.wg.Done()

    ticker := time.NewTicker(c.cfg.Cleanup.CheckInterval)
    defer ticker.Stop()

    c.logger.Info().
        Dur("interval", c.cfg.Cleanup.CheckInterval).
        Msg("Cleanup loop started")

    for {
        select {
        case <-ctx.Done():
            return
        case <-c.stopChan:
            return
        case <-ticker.C:
            if err := c.performCleanup(ctx); err != nil {
                c.logger.Error().Err(err).Msg("Cleanup failed")
            }
        }
    }
}

// performCleanup executes the cleanup logic
func (c *CleanupManager) performCleanup(ctx context.Context) error {
    c.logger.Debug().Msg("Performing cleanup check")

    // Get all sessions
    sessions, err := c.stateStore.List(ctx, StateFilter{})
    if err != nil {
        return fmt.Errorf("failed to list sessions: %w", err)
    }

    now := time.Now()
    cleaned := 0

    for _, session := range sessions {
        log := c.logger.With().
            Str("task_id", session.TaskID).
            Str("status", string(session.Status)).
            Logger()

        // Check if session should be cleaned up
        shouldCleanup := false
        reason := ""

        // 1. Check for stale sessions
        if session.Status == StatusRunning {
            staleDuration := now.Sub(session.LastHeartbeat)
            if staleDuration > c.cfg.Cleanup.StaleThreshold {
                shouldCleanup = true
                reason = fmt.Sprintf("stale (no heartbeat for %v)", staleDuration)

                // Mark as stale first
                if err := c.stateStore.UpdateStatus(ctx, session.TaskID, StatusStale); err != nil {
                    log.Error().Err(err).Msg("Failed to mark as stale")
                }
            }
        }

        // 2. Check for completed sessions past retention period
        if session.Status.IsTerminal() && session.CompletedAt != nil {
            retentionPeriod := now.Sub(*session.CompletedAt)
            if retentionPeriod > c.cfg.Cleanup.CompletedRetention {
                shouldCleanup = true
                reason = fmt.Sprintf("completed %v ago", retentionPeriod)
            }
        }

        // 3. Perform cleanup if needed
        if shouldCleanup {
            log.Info().Str("reason", reason).Msg("Cleaning up session")

            if err := c.cleanupSession(ctx, session); err != nil {
                log.Error().Err(err).Msg("Failed to cleanup session")
            } else {
                cleaned++
            }
        }
    }

    if cleaned > 0 {
        c.logger.Info().Int("count", cleaned).Msg("Sessions cleaned up")
    }

    return nil
}

// cleanupSession cleans up a single session
func (c *CleanupManager) cleanupSession(ctx context.Context, session *SessionState) error {
    // Kill the session if it still exists
    if err := c.sessionMgr.KillSession(ctx, session.SessionName); err != nil {
        c.logger.Warn().Err(err).Msg("Failed to kill session (may already be gone)")
    }

    // Delete from state store
    if err := c.stateStore.Delete(ctx, session.TaskID); err != nil {
        return fmt.Errorf("failed to delete session state: %w", err)
    }

    return nil
}
```

---

### 5. Configuration Enhancement

#### 5.1 Enhanced Config Structure

```go
// Config holds all service configuration
type Config struct {
    RabbitMQ      RabbitMQConfig
    Session       SessionConfig
    Wrapper       WrapperConfig
    StateStore    StateStoreConfig
    Cleanup       CleanupConfig
    Service       ServiceConfig
    AgentCommands map[string]string
}

// WrapperConfig holds flume-agent wrapper settings
type WrapperConfig struct {
    Enabled           bool
    Path              string
    HeartbeatInterval time.Duration
    Timeout           time.Duration
}

// StateStoreConfig holds state persistence settings
type StateStoreConfig struct {
    Type     string // "memory" or "sqlite"
    SQLite   SQLiteConfig
}

// SQLiteConfig holds SQLite-specific settings
type SQLiteConfig struct {
    Path string
}

// CleanupConfig holds session cleanup settings
type CleanupConfig struct {
    Enabled            bool
    CheckInterval      time.Duration
    StaleThreshold     time.Duration
    CompletedRetention time.Duration
    ForceKill          bool
}
```

#### 5.2 YAML Configuration File Support

```go
// LoadFromFile loads configuration from YAML file
func LoadFromFile(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("failed to read config file: %w", err)
    }

    var cfg Config
    if err := yaml.Unmarshal(data, &cfg); err != nil {
        return nil, fmt.Errorf("failed to parse config file: %w", err)
    }

    // Apply environment variable overrides
    applyEnvOverrides(&cfg)

    // Validate
    if err := cfg.Validate(); err != nil {
        return nil, fmt.Errorf("invalid configuration: %w", err)
    }

    return &cfg, nil
}

// applyEnvOverrides applies environment variable overrides to config
func applyEnvOverrides(cfg *Config) {
    // Existing env overrides...

    // Wrapper overrides
    if val := os.Getenv("WRAPPER_ENABLED"); val != "" {
        cfg.Wrapper.Enabled = val == "true"
    }
    if val := os.Getenv("WRAPPER_PATH"); val != "" {
        cfg.Wrapper.Path = val
    }

    // State store overrides
    if val := os.Getenv("STATE_STORE_TYPE"); val != "" {
        cfg.StateStore.Type = val
    }
    if val := os.Getenv("STATE_STORE_SQLITE_PATH"); val != "" {
        cfg.StateStore.SQLite.Path = val
    }

    // Cleanup overrides
    if val := os.Getenv("CLEANUP_ENABLED"); val != "" {
        cfg.Cleanup.Enabled = val == "true"
    }
    if val := os.Getenv("CLEANUP_STALE_THRESHOLD"); val != "" {
        if dur, err := time.ParseDuration(val); err == nil {
            cfg.Cleanup.StaleThreshold = dur
        }
    }
}
```

#### 5.3 Example Configuration File

```yaml
# ~/.config/flume/session-manager.yaml

rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "task.lifecycle"
  queue: "task.session.assigned"
  routing_key: "task.lifecycle.assigned"
  prefetch_count: 1
  reconnect_delay: 5s
  max_reconnect_time: 5m

session:
  preferred_manager: "zellij"
  session_name_template: "task-{{.TaskID}}"
  default_work_dir: "/tmp"
  startup_timeout: 30s

wrapper:
  enabled: true
  path: "/usr/local/bin/flume-agent"
  heartbeat_interval: 60s
  timeout: 4h

state_store:
  type: "sqlite"  # or "memory"
  sqlite:
    path: "~/.flume/sessions.db"

cleanup:
  enabled: true
  check_interval: 5m
  stale_threshold: 24h
  completed_retention: 1h
  force_kill: false

service:
  log_level: "info"
  shutdown_timeout: 30s
  health_check_port: 8080

agent_commands:
  claude-code: "claude"
  gemini-cli: "gemini"
  gpt-cli: "gpt"
  default: "bash"
```

---

## New Event Types

### TaskLifecycleRecovered

```go
// TaskLifecycleRecovered represents a session recovery event
type TaskLifecycleRecovered struct {
    TaskID         string         `json:"task_id"`
    SessionID      string         `json:"session_id"`
    SessionManager string         `json:"session_manager"`
    AgentPID       int            `json:"agent_pid"`
    AgentType      string         `json:"agent_type"`
    WorkingDir     string         `json:"working_dir"`
    RecoveredAt    time.Time      `json:"recovered_at"`
    OriginalStart  time.Time      `json:"original_start"`
    CorrelationID  string         `json:"correlation_id"`
    Metadata       map[string]any `json:"metadata,omitempty"`
}
```

---

## Implementation Plan

### Phase 1: Core State Management (Week 1, Days 1-2)

**Deliverables:**
- [ ] Implement `SessionState` type
- [ ] Implement `StateStore` interface
- [ ] Implement `MemoryStore`
- [ ] Implement `SQLiteStore`
- [ ] Add unit tests (95%+ coverage)

**Files to Create:**
- `internal/state/types.go`
- `internal/state/store.go`
- `internal/state/memory_store.go`
- `internal/state/sqlite_store.go`
- `internal/state/store_test.go`

### Phase 2: Wrapper Integration (Week 1, Days 3-4)

**Deliverables:**
- [ ] Update `CreateSession` to use wrapper
- [ ] Implement `buildWrapperCommand`
- [ ] Add wrapper configuration
- [ ] Store session state on creation
- [ ] Add integration tests

**Files to Modify:**
- `internal/session/manager.go`
- `internal/config/config.go`

**Files to Create:**
- `internal/session/wrapper.go`
- `internal/session/wrapper_test.go`

### Phase 3: Session Recovery (Week 1, Days 5-6)

**Deliverables:**
- [ ] Implement `RecoveryManager`
- [ ] Add `SessionExists` method
- [ ] Add recovery on startup
- [ ] Add recovery event emission
- [ ] Add recovery tests

**Files to Create:**
- `internal/recovery/manager.go`
- `internal/recovery/manager_test.go`

**Files to Modify:**
- `cmd/main.go`
- `internal/publisher/publisher.go`

### Phase 4: Session Cleanup (Week 2, Days 1-2)

**Deliverables:**
- [ ] Implement `CleanupManager`
- [ ] Add stale session detection
- [ ] Add completed session cleanup
- [ ] Add cleanup background loop
- [ ] Add cleanup tests

**Files to Create:**
- `internal/cleanup/manager.go`
- `internal/cleanup/manager_test.go`

**Files to Modify:**
- `cmd/main.go`
- `internal/config/config.go`

### Phase 5: Configuration & Documentation (Week 2, Days 3-4)

**Deliverables:**
- [ ] Add YAML config file support
- [ ] Add environment variable overrides
- [ ] Update configuration documentation
- [ ] Add example configurations
- [ ] Add migration guide

**Files to Create:**
- `configs/session-manager.yaml`
- `docs/CONFIGURATION.md`
- `docs/MIGRATION_v2.md`

**Files to Modify:**
- `internal/config/config.go`
- `README.md`

### Phase 6: Integration & Testing (Week 2, Days 5-7)

**Deliverables:**
- [ ] End-to-end integration tests
- [ ] Performance benchmarks
- [ ] Recovery scenario tests
- [ ] Cleanup scenario tests
- [ ] Documentation review

**Files to Create:**
- `test/integration/recovery_test.go`
- `test/integration/cleanup_test.go`
- `test/benchmarks/performance_test.go`

---

## Testing Strategy

### Unit Tests (Target: 95% coverage)

**State Management:**
- Memory store CRUD operations
- SQLite store CRUD operations
- State filtering and queries
- Concurrent access safety

**Wrapper Integration:**
- Command building
- Environment variable setup
- Error handling

**Recovery:**
- Session detection
- State reconciliation
- Event emission

**Cleanup:**
- Stale detection logic
- Cleanup timing
- Forced vs graceful cleanup

### Integration Tests

**Full Lifecycle:**
1. Assign task event
2. Create session with wrapper
3. Verify state stored
4. Simulate restart
5. Verify recovery
6. Wait for stale threshold
7. Verify cleanup

**Error Scenarios:**
- Wrapper not found
- Session creation failure
- State store unavailable
- Recovery with missing sessions

### Performance Tests

**Metrics to Measure:**
- Session creation overhead (< 100ms)
- State store write latency (< 10ms)
- State store read latency (< 5ms)
- Recovery time (< 1s per 100 sessions)
- Cleanup time (< 100ms per session)
- Memory usage (< 100MB for 1000 sessions)

---

## Backward Compatibility

### Compatibility Guarantees

1. **Existing events still work**: No changes to incoming event format
2. **Existing sessions continue**: Current sessions run normally
3. **Configuration backward compatible**: Old env vars still work
4. **Optional features**: All new features can be disabled

### Migration Path

**Step 1: Update without features**
```bash
# Deploy v2.0.0 with features disabled
WRAPPER_ENABLED=false
STATE_STORE_TYPE=memory
CLEANUP_ENABLED=false
```

**Step 2: Enable state tracking**
```bash
# Add state tracking
STATE_STORE_TYPE=sqlite
STATE_STORE_SQLITE_PATH=~/.flume/sessions.db
```

**Step 3: Enable wrapper**
```bash
# Enable wrapper integration
WRAPPER_ENABLED=true
WRAPPER_PATH=/usr/local/bin/flume-agent
```

**Step 4: Enable cleanup**
```bash
# Enable automatic cleanup
CLEANUP_ENABLED=true
CLEANUP_STALE_THRESHOLD=24h
```

---

## Performance Considerations

### Memory Usage

**Without enhancements:**
- Base: ~20MB
- Per session: ~0KB (no tracking)

**With enhancements:**
- Base: ~25MB
- Per session: ~2KB (in-memory state)
- SQLite: +10MB (database file)

**Optimization:**
- Limit in-memory cache size
- Periodic SQLite VACUUM
- Index optimization for queries

### CPU Usage

**Overhead per session:**
- State store write: < 1ms CPU
- Wrapper invocation: < 10ms CPU
- Recovery check: < 0.1ms CPU per session

**Background processes:**
- Cleanup loop: < 1% CPU average
- Heartbeat monitoring: < 0.5% CPU average

---

## Security Considerations

### Sensitive Data Handling

1. **Task metadata**: May contain sensitive information
   - Solution: Encrypt metadata in SQLite
   - Solution: Secure file permissions (600)

2. **Event IDs and correlation**: Enable tracing
   - Solution: Sanitize logs
   - Solution: Redact sensitive fields

3. **Session state**: Contains working directories
   - Solution: Validate paths
   - Solution: Prevent path traversal

### Database Security

```go
// SQLite security configuration
func (s *SQLiteStore) initDB() error {
    // Set secure file permissions
    os.Chmod(s.dbPath, 0600)

    // Enable security features
    _, err := s.db.Exec(`
        PRAGMA secure_delete = ON;
        PRAGMA auto_vacuum = FULL;
    `)
    return err
}
```

---

## Observability

### Metrics to Expose

**Prometheus metrics:**
```go
var (
    sessionsTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "flume_sessions_total",
            Help: "Total number of sessions created",
        },
        []string{"agent_type", "status"},
    )

    sessionsActive = prometheus.NewGauge(
        prometheus.GaugeOpts{
            Name: "flume_sessions_active",
            Help: "Number of currently active sessions",
        },
    )

    sessionRecoveries = prometheus.NewCounter(
        prometheus.CounterOpts{
            Name: "flume_session_recoveries_total",
            Help: "Total number of session recoveries",
        },
    )

    sessionCleanups = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "flume_session_cleanups_total",
            Help: "Total number of session cleanups",
        },
        []string{"reason"},
    )
)
```

### Structured Logging

```go
// Example log structure
log.Info().
    Str("task_id", taskID).
    Str("session_id", sessionID).
    Str("agent_type", agentType).
    Str("status", string(status)).
    Dur("duration", elapsed).
    Msg("Session lifecycle event")
```

---

## Success Criteria

### Functional Requirements
- [ ] Sessions tracked in state store
- [ ] Sessions recovered on restart
- [ ] Stale sessions detected and cleaned up
- [ ] Wrapper invoked for agent launching
- [ ] Configuration file support working
- [ ] All events correctly emitted

### Non-Functional Requirements
- [ ] 95%+ test coverage achieved
- [ ] < 5% performance overhead
- [ ] 100% backward compatibility maintained
- [ ] Documentation complete and accurate
- [ ] Zero breaking changes to existing deployments

### Operational Requirements
- [ ] Deployment guide updated
- [ ] Configuration examples provided
- [ ] Troubleshooting guide created
- [ ] Migration path documented
- [ ] Monitoring dashboard updated

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SQLite corruption | Low | High | Regular backups, corruption detection |
| Memory leaks in state tracking | Medium | Medium | Memory profiling, leak detection tests |
| Recovery conflicts | Low | Medium | Atomic state updates, locking |
| Cleanup race conditions | Medium | Low | Careful synchronization, testing |
| Wrapper not found | High | High | Graceful fallback to raw CLI |
| Configuration migration issues | Medium | Medium | Thorough migration guide, validation |

---

## Future Enhancements

### v2.1 Enhancements
- [ ] Distributed state store (Redis, etcd)
- [ ] Multi-instance coordination
- [ ] Advanced cleanup policies
- [ ] Session templates
- [ ] Resource limits per session

### v3.0 Vision
- [ ] Multi-agent collaboration on tasks
- [ ] Session migration between hosts
- [ ] Advanced observability (OpenTelemetry)
- [ ] Auto-scaling agent pools
- [ ] ML-based stale prediction

---

## Conclusion

This enhancement design provides a comprehensive, production-ready upgrade to the task-session-manager that:

1. **Maintains backward compatibility** while adding powerful new features
2. **Enables wrapper integration** for standardized agent invocation
3. **Provides session recovery** for resilience and reliability
4. **Implements intelligent cleanup** to prevent resource accumulation
5. **Offers flexible configuration** via YAML or environment variables

The phased implementation approach ensures incremental delivery with continuous validation, targeting completion in 2 weeks with 95%+ test coverage.

---

**Document Status:** Design Complete - Ready for Implementation
**Next Steps:** Review and approval, then begin Phase 1 implementation
**Estimated Effort:** 80-100 engineering hours (2 weeks, 1 senior Go engineer)
