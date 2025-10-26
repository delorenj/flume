# Task Session Manager Enhancement - Implementation Specification

**Project:** Flume Task Lifecycle System
**Component:** Task Session Manager v2.0.0
**Date:** 2025-10-22
**Developer:** Backend Go Engineer

---

## Overview

This document provides detailed implementation specifications for enhancing the existing Go task-session-manager with wrapper integration, session recovery, state tracking, and cleanup capabilities.

---

## File Structure Changes

### New Files to Create

```
task-session-manager/
├── internal/
│   ├── state/
│   │   ├── types.go           # SessionState and Status types
│   │   ├── store.go           # StateStore interface
│   │   ├── memory_store.go    # In-memory implementation
│   │   ├── sqlite_store.go    # SQLite implementation
│   │   └── store_test.go      # Comprehensive tests
│   ├── recovery/
│   │   ├── manager.go         # Recovery manager
│   │   └── manager_test.go    # Recovery tests
│   └── cleanup/
│       ├── manager.go         # Cleanup manager
│       └── manager_test.go    # Cleanup tests
├── test/
│   ├── integration/
│   │   ├── recovery_test.go   # Integration tests
│   │   └── cleanup_test.go    # Cleanup integration tests
│   └── benchmarks/
│       └── performance_test.go # Performance benchmarks
├── configs/
│   └── session-manager.yaml   # Example configuration
└── docs/
    ├── CONFIGURATION.md       # Configuration guide
    └── MIGRATION_v2.md        # Migration guide
```

### Files to Modify

```
task-session-manager/
├── internal/
│   ├── session/
│   │   └── manager.go         # Add wrapper support, state tracking
│   ├── config/
│   │   └── config.go          # Add new config sections
│   └── publisher/
│       └── publisher.go       # Add recovery event publishing
├── cmd/
│   └── main.go                # Add recovery and cleanup managers
├── pkg/events/
│   └── types.go               # Add TaskLifecycleRecovered
└── go.mod                     # Add dependencies
```

---

## Detailed Implementation

### 1. State Management (`internal/state/`)

#### 1.1 `types.go`

```go
package state

import (
    "time"
)

// Status represents session lifecycle status
type Status string

const (
    StatusRunning   Status = "running"
    StatusStale     Status = "stale"
    StatusCompleted Status = "completed"
    StatusFailed    Status = "failed"
    StatusPaused    Status = "paused"
)

// IsTerminal returns true if status is terminal
func (s Status) IsTerminal() bool {
    return s == StatusCompleted || s == StatusFailed
}

// IsActive returns true if session is actively running
func (s Status) IsActive() bool {
    return s == StatusRunning
}

// SessionState represents the current state of a task session
type SessionState struct {
    // Identity
    TaskID      string `json:"task_id" db:"task_id"`
    SessionID   string `json:"session_id" db:"session_id"`
    SessionName string `json:"session_name" db:"session_name"`

    // Configuration
    AgentType  string `json:"agent_type" db:"agent_type"`
    WorkingDir string `json:"working_dir" db:"working_dir"`
    Command    string `json:"command" db:"command"`

    // Runtime State
    Status Status `json:"status" db:"status"`
    PID    int    `json:"pid" db:"pid"`

    // Timing
    StartTime     time.Time  `json:"start_time" db:"start_time"`
    LastHeartbeat time.Time  `json:"last_heartbeat" db:"last_heartbeat"`
    CompletedAt   *time.Time `json:"completed_at,omitempty" db:"completed_at"`

    // Metadata
    EventID       string                 `json:"event_id" db:"event_id"`
    CorrelationID string                 `json:"correlation_id" db:"correlation_id"`
    Metadata      map[string]interface{} `json:"metadata,omitempty"`
}

// IsStale returns true if session hasn't had a heartbeat within the threshold
func (s *SessionState) IsStale(threshold time.Duration) bool {
    return s.Status == StatusRunning && time.Since(s.LastHeartbeat) > threshold
}

// ShouldCleanup returns true if session should be cleaned up
func (s *SessionState) ShouldCleanup(completedRetention time.Duration) bool {
    if s.Status.IsTerminal() && s.CompletedAt != nil {
        return time.Since(*s.CompletedAt) > completedRetention
    }
    return false
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

#### 1.2 `store.go`

```go
package state

import (
    "context"
    "time"
)

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

// Helper functions for creating filter pointers
func StatusPtr(s Status) *Status {
    return &s
}

func StringPtr(s string) *string {
    return &s
}

func DurationPtr(d time.Duration) *time.Duration {
    return &d
}

func TimePtr(t time.Time) *time.Time {
    return &t
}
```

#### 1.3 `memory_store.go`

```go
package state

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/rs/zerolog"
)

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

// Store saves or updates a session state
func (m *MemoryStore) Store(ctx context.Context, state *SessionState) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    // Create a copy to avoid external modifications
    stateCopy := *state
    if state.Metadata != nil {
        stateCopy.Metadata = make(map[string]interface{})
        for k, v := range state.Metadata {
            stateCopy.Metadata[k] = v
        }
    }

    m.states[state.TaskID] = &stateCopy
    m.logger.Debug().Str("task_id", state.TaskID).Msg("Session state stored")
    return nil
}

// Get retrieves a session state by task ID
func (m *MemoryStore) Get(ctx context.Context, taskID string) (*SessionState, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    state, exists := m.states[taskID]
    if !exists {
        return nil, fmt.Errorf("session not found: %s", taskID)
    }

    // Return a copy
    stateCopy := *state
    if state.Metadata != nil {
        stateCopy.Metadata = make(map[string]interface{})
        for k, v := range state.Metadata {
            stateCopy.Metadata[k] = v
        }
    }

    return &stateCopy, nil
}

// List returns all sessions matching the filter
func (m *MemoryStore) List(ctx context.Context, filter StateFilter) ([]*SessionState, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    var results []*SessionState

    for _, state := range m.states {
        // Apply filters
        if filter.Status != nil && state.Status != *filter.Status {
            continue
        }
        if filter.AgentType != nil && state.AgentType != *filter.AgentType {
            continue
        }
        if filter.StaleSince != nil && !state.IsStale(*filter.StaleSince) {
            continue
        }
        if filter.StartedAfter != nil && state.StartTime.Before(*filter.StartedAfter) {
            continue
        }

        // Create a copy
        stateCopy := *state
        if state.Metadata != nil {
            stateCopy.Metadata = make(map[string]interface{})
            for k, v := range state.Metadata {
                stateCopy.Metadata[k] = v
            }
        }
        results = append(results, &stateCopy)

        // Apply limit
        if filter.Limit > 0 && len(results) >= filter.Limit {
            break
        }
    }

    return results, nil
}

// Delete removes a session state
func (m *MemoryStore) Delete(ctx context.Context, taskID string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    if _, exists := m.states[taskID]; !exists {
        return fmt.Errorf("session not found: %s", taskID)
    }

    delete(m.states, taskID)
    m.logger.Debug().Str("task_id", taskID).Msg("Session state deleted")
    return nil
}

// UpdateHeartbeat updates the last heartbeat time
func (m *MemoryStore) UpdateHeartbeat(ctx context.Context, taskID string, timestamp time.Time) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    state, exists := m.states[taskID]
    if !exists {
        return fmt.Errorf("session not found: %s", taskID)
    }

    state.LastHeartbeat = timestamp
    m.logger.Debug().Str("task_id", taskID).Time("timestamp", timestamp).Msg("Heartbeat updated")
    return nil
}

// UpdateStatus updates the session status
func (m *MemoryStore) UpdateStatus(ctx context.Context, taskID string, status Status) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    state, exists := m.states[taskID]
    if !exists {
        return fmt.Errorf("session not found: %s", taskID)
    }

    oldStatus := state.Status
    state.Status = status

    // Set CompletedAt if transitioning to terminal state
    if status.IsTerminal() && state.CompletedAt == nil {
        now := time.Now()
        state.CompletedAt = &now
    }

    m.logger.Info().
        Str("task_id", taskID).
        Str("old_status", string(oldStatus)).
        Str("new_status", string(status)).
        Msg("Status updated")

    return nil
}

// Close closes the store (no-op for memory store)
func (m *MemoryStore) Close() error {
    m.logger.Debug().Msg("Memory store closed")
    return nil
}
```

#### 1.4 `sqlite_store.go`

```go
package state

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "time"

    _ "github.com/mattn/go-sqlite3"
    "github.com/rs/zerolog"
)

// SQLiteStore provides persistent session state storage
type SQLiteStore struct {
    db     *sql.DB
    logger zerolog.Logger
}

// NewSQLiteStore creates a new SQLite state store
func NewSQLiteStore(dbPath string, logger zerolog.Logger) (*SQLiteStore, error) {
    // Ensure directory exists
    dir := filepath.Dir(dbPath)
    if err := os.MkdirAll(dir, 0755); err != nil {
        return nil, fmt.Errorf("failed to create database directory: %w", err)
    }

    // Open database
    db, err := sql.Open("sqlite3", dbPath)
    if err != nil {
        return nil, fmt.Errorf("failed to open database: %w", err)
    }

    // Set connection pool settings
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)

    store := &SQLiteStore{
        db:     db,
        logger: logger.With().Str("store", "sqlite").Logger(),
    }

    if err := store.initSchema(); err != nil {
        db.Close()
        return nil, err
    }

    // Set secure file permissions
    if err := os.Chmod(dbPath, 0600); err != nil {
        logger.Warn().Err(err).Msg("Failed to set database permissions")
    }

    logger.Info().Str("path", dbPath).Msg("SQLite store initialized")
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
    CREATE INDEX IF NOT EXISTS idx_start_time ON sessions(start_time);

    -- Enable security features
    PRAGMA secure_delete = ON;
    PRAGMA auto_vacuum = FULL;
    `

    _, err := s.db.Exec(schema)
    return err
}

// Store saves or updates a session state
func (s *SQLiteStore) Store(ctx context.Context, state *SessionState) error {
    metadataJSON, err := json.Marshal(state.Metadata)
    if err != nil {
        return fmt.Errorf("failed to marshal metadata: %w", err)
    }

    query := `
    INSERT INTO sessions (
        task_id, session_id, session_name, agent_type, working_dir, command,
        status, pid, start_time, last_heartbeat, completed_at,
        event_id, correlation_id, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(task_id) DO UPDATE SET
        session_id = excluded.session_id,
        session_name = excluded.session_name,
        agent_type = excluded.agent_type,
        working_dir = excluded.working_dir,
        command = excluded.command,
        status = excluded.status,
        pid = excluded.pid,
        start_time = excluded.start_time,
        last_heartbeat = excluded.last_heartbeat,
        completed_at = excluded.completed_at,
        event_id = excluded.event_id,
        correlation_id = excluded.correlation_id,
        metadata = excluded.metadata,
        updated_at = CURRENT_TIMESTAMP
    `

    _, err = s.db.ExecContext(ctx, query,
        state.TaskID, state.SessionID, state.SessionName, state.AgentType,
        state.WorkingDir, state.Command, state.Status, state.PID,
        state.StartTime, state.LastHeartbeat, state.CompletedAt,
        state.EventID, state.CorrelationID, metadataJSON,
    )

    if err != nil {
        return fmt.Errorf("failed to store session: %w", err)
    }

    s.logger.Debug().Str("task_id", state.TaskID).Msg("Session state stored")
    return nil
}

// Get retrieves a session state by task ID
func (s *SQLiteStore) Get(ctx context.Context, taskID string) (*SessionState, error) {
    query := `
    SELECT task_id, session_id, session_name, agent_type, working_dir, command,
           status, pid, start_time, last_heartbeat, completed_at,
           event_id, correlation_id, metadata
    FROM sessions
    WHERE task_id = ?
    `

    var state SessionState
    var metadataJSON []byte

    err := s.db.QueryRowContext(ctx, query, taskID).Scan(
        &state.TaskID, &state.SessionID, &state.SessionName, &state.AgentType,
        &state.WorkingDir, &state.Command, &state.Status, &state.PID,
        &state.StartTime, &state.LastHeartbeat, &state.CompletedAt,
        &state.EventID, &state.CorrelationID, &metadataJSON,
    )

    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("session not found: %s", taskID)
    }
    if err != nil {
        return nil, fmt.Errorf("failed to get session: %w", err)
    }

    if len(metadataJSON) > 0 {
        if err := json.Unmarshal(metadataJSON, &state.Metadata); err != nil {
            s.logger.Warn().Err(err).Msg("Failed to unmarshal metadata")
        }
    }

    return &state, nil
}

// List returns all sessions matching the filter
func (s *SQLiteStore) List(ctx context.Context, filter StateFilter) ([]*SessionState, error) {
    query := "SELECT task_id, session_id, session_name, agent_type, working_dir, command, status, pid, start_time, last_heartbeat, completed_at, event_id, correlation_id, metadata FROM sessions WHERE 1=1"
    args := []interface{}{}

    if filter.Status != nil {
        query += " AND status = ?"
        args = append(args, *filter.Status)
    }
    if filter.AgentType != nil {
        query += " AND agent_type = ?"
        args = append(args, *filter.AgentType)
    }
    if filter.StartedAfter != nil {
        query += " AND start_time >= ?"
        args = append(args, *filter.StartedAfter)
    }

    query += " ORDER BY start_time DESC"

    if filter.Limit > 0 {
        query += " LIMIT ?"
        args = append(args, filter.Limit)
    }

    rows, err := s.db.QueryContext(ctx, query, args...)
    if err != nil {
        return nil, fmt.Errorf("failed to list sessions: %w", err)
    }
    defer rows.Close()

    var results []*SessionState
    for rows.Next() {
        var state SessionState
        var metadataJSON []byte

        err := rows.Scan(
            &state.TaskID, &state.SessionID, &state.SessionName, &state.AgentType,
            &state.WorkingDir, &state.Command, &state.Status, &state.PID,
            &state.StartTime, &state.LastHeartbeat, &state.CompletedAt,
            &state.EventID, &state.CorrelationID, &metadataJSON,
        )
        if err != nil {
            return nil, fmt.Errorf("failed to scan session: %w", err)
        }

        if len(metadataJSON) > 0 {
            if err := json.Unmarshal(metadataJSON, &state.Metadata); err != nil {
                s.logger.Warn().Err(err).Msg("Failed to unmarshal metadata")
            }
        }

        // Apply stale filter if specified
        if filter.StaleSince != nil && !state.IsStale(*filter.StaleSince) {
            continue
        }

        results = append(results, &state)
    }

    return results, rows.Err()
}

// Delete removes a session state
func (s *SQLiteStore) Delete(ctx context.Context, taskID string) error {
    result, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE task_id = ?", taskID)
    if err != nil {
        return fmt.Errorf("failed to delete session: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("failed to get rows affected: %w", err)
    }

    if rows == 0 {
        return fmt.Errorf("session not found: %s", taskID)
    }

    s.logger.Debug().Str("task_id", taskID).Msg("Session state deleted")
    return nil
}

// UpdateHeartbeat updates the last heartbeat time
func (s *SQLiteStore) UpdateHeartbeat(ctx context.Context, taskID string, timestamp time.Time) error {
    query := "UPDATE sessions SET last_heartbeat = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?"
    result, err := s.db.ExecContext(ctx, query, timestamp, taskID)
    if err != nil {
        return fmt.Errorf("failed to update heartbeat: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("failed to get rows affected: %w", err)
    }

    if rows == 0 {
        return fmt.Errorf("session not found: %s", taskID)
    }

    s.logger.Debug().Str("task_id", taskID).Time("timestamp", timestamp).Msg("Heartbeat updated")
    return nil
}

// UpdateStatus updates the session status
func (s *SQLiteStore) UpdateStatus(ctx context.Context, taskID string, status Status) error {
    query := `
    UPDATE sessions
    SET status = ?,
        completed_at = CASE WHEN ? IN ('completed', 'failed') AND completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ?
    `
    result, err := s.db.ExecContext(ctx, query, status, status, taskID)
    if err != nil {
        return fmt.Errorf("failed to update status: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("failed to get rows affected: %w", err)
    }

    if rows == 0 {
        return fmt.Errorf("session not found: %s", taskID)
    }

    s.logger.Info().Str("task_id", taskID).Str("status", string(status)).Msg("Status updated")
    return nil
}

// Close closes the database connection
func (s *SQLiteStore) Close() error {
    s.logger.Debug().Msg("Closing SQLite store")
    return s.db.Close()
}
```

---

### 2. Configuration Changes (`internal/config/config.go`)

Add new configuration sections:

```go
package config

import (
    "fmt"
    "os"
    "strconv"
    "time"

    "gopkg.in/yaml.v3"
)

// Config holds all service configuration
type Config struct {
    RabbitMQ      RabbitMQConfig
    Session       SessionConfig
    Wrapper       WrapperConfig      // NEW
    StateStore    StateStoreConfig   // NEW
    Cleanup       CleanupConfig      // NEW
    Service       ServiceConfig
    AgentCommands map[string]string
}

// WrapperConfig holds flume-agent wrapper settings
type WrapperConfig struct {
    Enabled           bool          `yaml:"enabled"`
    Path              string        `yaml:"path"`
    HeartbeatInterval time.Duration `yaml:"heartbeat_interval"`
    Timeout           time.Duration `yaml:"timeout"`
}

// StateStoreConfig holds state persistence settings
type StateStoreConfig struct {
    Type   string       `yaml:"type"` // "memory" or "sqlite"
    SQLite SQLiteConfig `yaml:"sqlite"`
}

// SQLiteConfig holds SQLite-specific settings
type SQLiteConfig struct {
    Path string `yaml:"path"`
}

// CleanupConfig holds session cleanup settings
type CleanupConfig struct {
    Enabled            bool          `yaml:"enabled"`
    CheckInterval      time.Duration `yaml:"check_interval"`
    StaleThreshold     time.Duration `yaml:"stale_threshold"`
    CompletedRetention time.Duration `yaml:"completed_retention"`
    ForceKill          bool          `yaml:"force_kill"`
}

// LoadFromFile loads configuration from YAML file
func LoadFromFile(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        // File not found is OK, use defaults
        if os.IsNotExist(err) {
            return Load()
        }
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

// Load loads configuration from environment variables with sensible defaults
func Load() (*Config, error) {
    cfg := &Config{
        RabbitMQ: RabbitMQConfig{
            URL:              getEnv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/"),
            Exchange:         getEnv("RABBITMQ_EXCHANGE", "task.lifecycle"),
            Queue:            getEnv("RABBITMQ_QUEUE", "task.session.assigned"),
            RoutingKey:       getEnv("RABBITMQ_ROUTING_KEY", "task.lifecycle.assigned"),
            PrefetchCount:    getEnvInt("RABBITMQ_PREFETCH_COUNT", 1),
            ReconnectDelay:   getEnvDuration("RABBITMQ_RECONNECT_DELAY", 5*time.Second),
            MaxReconnectTime: getEnvDuration("RABBITMQ_MAX_RECONNECT_TIME", 5*time.Minute),
        },
        Session: SessionConfig{
            PreferredManager: getEnv("FLUME_SESSION_MANAGER", "zellij"),
            SessionNameTpl:   getEnv("SESSION_NAME_TEMPLATE", "task-{{.TaskID}}"),
            DefaultWorkDir:   getEnv("DEFAULT_WORK_DIR", "/tmp"),
            StartupTimeout:   getEnvDuration("SESSION_STARTUP_TIMEOUT", 30*time.Second),
        },
        Wrapper: WrapperConfig{
            Enabled:           getEnvBool("WRAPPER_ENABLED", false),
            Path:              getEnv("WRAPPER_PATH", "/usr/local/bin/flume-agent"),
            HeartbeatInterval: getEnvDuration("WRAPPER_HEARTBEAT_INTERVAL", 60*time.Second),
            Timeout:           getEnvDuration("WRAPPER_TIMEOUT", 4*time.Hour),
        },
        StateStore: StateStoreConfig{
            Type: getEnv("STATE_STORE_TYPE", "memory"),
            SQLite: SQLiteConfig{
                Path: getEnv("STATE_STORE_SQLITE_PATH", "~/.flume/sessions.db"),
            },
        },
        Cleanup: CleanupConfig{
            Enabled:            getEnvBool("CLEANUP_ENABLED", true),
            CheckInterval:      getEnvDuration("CLEANUP_CHECK_INTERVAL", 5*time.Minute),
            StaleThreshold:     getEnvDuration("CLEANUP_STALE_THRESHOLD", 24*time.Hour),
            CompletedRetention: getEnvDuration("CLEANUP_COMPLETED_RETENTION", 1*time.Hour),
            ForceKill:          getEnvBool("CLEANUP_FORCE_KILL", false),
        },
        Service: ServiceConfig{
            LogLevel:        getEnv("LOG_LEVEL", "info"),
            ShutdownTimeout: getEnvDuration("SHUTDOWN_TIMEOUT", 30*time.Second),
            HealthCheckPort: getEnvInt("HEALTH_CHECK_PORT", 8080),
        },
        AgentCommands: make(map[string]string),
    }

    // Load agent command mappings
    cfg.AgentCommands["claude-code"] = getEnv("AGENT_CMD_CLAUDE", "claude")
    cfg.AgentCommands["gemini-cli"] = getEnv("AGENT_CMD_GEMINI", "gemini")
    cfg.AgentCommands["gpt-cli"] = getEnv("AGENT_CMD_GPT", "gpt")
    cfg.AgentCommands["default"] = getEnv("AGENT_CMD_DEFAULT", "bash")

    // Validate configuration
    if err := cfg.Validate(); err != nil {
        return nil, fmt.Errorf("invalid configuration: %w", err)
    }

    return cfg, nil
}

// applyEnvOverrides applies environment variable overrides to config
func applyEnvOverrides(cfg *Config) {
    // Existing overrides...

    // Wrapper overrides
    if val := os.Getenv("WRAPPER_ENABLED"); val != "" {
        cfg.Wrapper.Enabled = val == "true"
    }
    if val := os.Getenv("WRAPPER_PATH"); val != "" {
        cfg.Wrapper.Path = val
    }
    if val := os.Getenv("WRAPPER_HEARTBEAT_INTERVAL"); val != "" {
        if dur, err := time.ParseDuration(val); err == nil {
            cfg.Wrapper.HeartbeatInterval = dur
        }
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

// Helper function for boolean env vars
func getEnvBool(key string, defaultValue bool) bool {
    if value := os.Getenv(key); value != "" {
        if boolVal, err := strconv.ParseBool(value); err == nil {
            return boolVal
        }
    }
    return defaultValue
}
```

---

### 3. Update `go.mod`

Add new dependencies:

```
require (
    github.com/mattn/go-sqlite3 v1.14.18
    gopkg.in/yaml.v3 v3.0.1
)
```

---

## Testing Requirements

### Unit Test Coverage Targets

- `internal/state/*`: 95%+
- `internal/recovery/*`: 90%+
- `internal/cleanup/*`: 90%+
- Modified `internal/session/manager.go`: 85%+

### Integration Test Scenarios

1. **Full Lifecycle with Recovery**
   - Create session
   - Store state
   - Simulate restart
   - Verify recovery

2. **Stale Detection and Cleanup**
   - Create session
   - Wait for stale threshold
   - Verify cleanup

3. **Wrapper Integration**
   - Verify wrapper command construction
   - Verify environment variables passed

### Performance Benchmarks

- Session creation overhead: < 100ms
- State store write: < 10ms
- State store read: < 5ms
- Recovery time: < 1s per 100 sessions

---

## Implementation Checklist

### Phase 1: State Management
- [ ] Create `internal/state/types.go`
- [ ] Create `internal/state/store.go`
- [ ] Create `internal/state/memory_store.go`
- [ ] Create `internal/state/sqlite_store.go`
- [ ] Create `internal/state/store_test.go` with 95%+ coverage
- [ ] Add SQLite dependency to `go.mod`

### Phase 2: Wrapper Integration
- [ ] Update `internal/session/manager.go` - add `buildWrapperCommand`
- [ ] Update `internal/session/manager.go` - modify `CreateSession`
- [ ] Update `internal/session/manager.go` - add state storage
- [ ] Update `internal/config/config.go` - add `WrapperConfig`
- [ ] Update tests in `internal/session/manager_test.go`

### Phase 3: Session Recovery
- [ ] Create `internal/recovery/manager.go`
- [ ] Create `internal/recovery/manager_test.go`
- [ ] Update `cmd/main.go` - add recovery on startup
- [ ] Add `TaskLifecycleRecovered` to `pkg/events/types.go`
- [ ] Update `internal/publisher/publisher.go` - add `PublishRecovered`

### Phase 4: Session Cleanup
- [ ] Create `internal/cleanup/manager.go`
- [ ] Create `internal/cleanup/manager_test.go`
- [ ] Update `cmd/main.go` - add cleanup manager
- [ ] Update `internal/config/config.go` - add `CleanupConfig`

### Phase 5: Integration
- [ ] Create `configs/session-manager.yaml`
- [ ] Create integration tests
- [ ] Create performance benchmarks
- [ ] Update documentation

---

## Error Handling

### Error Categories and Responses

1. **State Store Errors**
   - Log error
   - Continue operation (non-fatal)
   - Metrics: increment error counter

2. **Wrapper Not Found**
   - Log warning
   - Fall back to raw agent CLI
   - Metrics: increment fallback counter

3. **Recovery Errors**
   - Log error
   - Mark sessions as stale
   - Continue with next session

4. **Cleanup Errors**
   - Log error
   - Retry on next iteration
   - Alert if persistent failures

---

## Deployment Strategy

### Zero-Downtime Deployment

1. Deploy v2.0.0 with features disabled
2. Verify existing functionality
3. Enable state store
4. Enable wrapper (gradually)
5. Enable cleanup
6. Monitor metrics

### Rollback Plan

1. Set `WRAPPER_ENABLED=false`
2. Set `CLEANUP_ENABLED=false`
3. Continue using v2.0.0 (backward compatible)
4. Or rollback to v1.0.0 if needed

---

## Success Metrics

- All tests passing with 95%+ coverage
- Zero breaking changes to existing deployments
- < 5% performance overhead
- Documentation complete and reviewed
- Successfully deployed to staging environment

---

**Document Status:** Implementation Ready
**Next Action:** Begin Phase 1 implementation
