# CLI Shell Integration: Event Flow Architecture

**Version:** 1.0.0
**Component:** Event-Driven Lifecycle Integration
**Date:** 2025-10-22
**Architect:** System Architect

---

## Executive Summary

This document defines the complete event flow architecture for CLI shell integration with the Flume task lifecycle system. It ensures consistency with the existing 7 lifecycle event types while introducing new payload structures and routing patterns for wrapper-based execution.

**Key Design Principles:**
- **Consistency:** Maintain compatibility with existing event schema
- **Traceability:** Full correlation ID propagation across all events
- **Observability:** Rich event payloads for comprehensive monitoring
- **Reliability:** At-least-once delivery with idempotent handling

---

## Existing Event Schema

### Current 7 Lifecycle Event Types

From `/task-monitor/models.py`:

```python
class EventType(str, Enum):
    ASSIGNED = "assigned"
    STARTED = "started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"
    RESUMED = "resumed"
    HEARTBEAT = "heartbeat"
```

### Current State Transitions

```python
VALID_TRANSITIONS = {
    TaskStatus.PENDING: {TaskStatus.ASSIGNED, TaskStatus.FAILED},
    TaskStatus.ASSIGNED: {TaskStatus.STARTED, TaskStatus.FAILED},
    TaskStatus.STARTED: {TaskStatus.IN_PROGRESS, TaskStatus.FAILED},
    TaskStatus.IN_PROGRESS: {
        TaskStatus.IN_PROGRESS,  # Heartbeats
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.PAUSED,
        TaskStatus.STALE,
    },
    TaskStatus.PAUSED: {TaskStatus.IN_PROGRESS, TaskStatus.FAILED, TaskStatus.STALE},
    TaskStatus.COMPLETED: set(),  # Terminal
    TaskStatus.FAILED: set(),     # Terminal
    TaskStatus.STALE: {TaskStatus.FAILED},
}
```

---

## Enhanced Event Flow

### Complete Lifecycle Sequence

```
┌─────────────────────────────────────────────────────────────────────┐
│                     TASK LIFECYCLE EVENT FLOW                        │
└─────────────────────────────────────────────────────────────────────┘

1. OBSIDIAN TASK ASSIGNMENT
   ├─> User creates/edits TASK.md in Obsidian
   ├─> QuickAdd macro triggered
   └─> Event: task.lifecycle.assigned
       ├─ Payload: task details, agent_type, working_dir
       ├─ Routing: task.lifecycle.assigned
       └─ Consumer: task-session-manager

2. SESSION MANAGER PROCESSING
   ├─> Consumes assigned event
   ├─> Creates session record (DB)
   ├─> Spawns tmux/zellij session
   ├─> Launches flume-agent wrapper
   └─> (No event emitted - wrapper handles this)

3. WRAPPER STARTUP
   ├─> flume-agent initializes
   ├─> Parses task context
   ├─> Starts agent CLI
   └─> Event: task.lifecycle.started
       ├─ Payload: session_id, agent_pid, started_at
       ├─ Routing: task.lifecycle.started
       ├─ Correlation: Links to assigned event
       └─ Consumers: task-monitor, dashboard

4. AGENT EXECUTION (Continuous)
   ├─> Wrapper monitors agent activity
   ├─> Every 60s (configurable):
   └─> Event: task.lifecycle.in_progress (Heartbeat)
       ├─ Payload: progress%, files_modified, git_stats
       ├─ Routing: task.lifecycle.in_progress
       ├─ Correlation: Links to started event
       └─ Consumers: task-monitor (updates heartbeat), dashboard

5. COMPLETION (Success Path)
   ├─> Agent CLI exits with code 0
   ├─> Wrapper detects completion
   └─> Event: task.lifecycle.completed
       ├─ Payload: exit_code, summary, total_time
       ├─ Routing: task.lifecycle.completed
       ├─ Correlation: Links to started event
       └─ Consumers: task-monitor, dashboard, session-manager

6. COMPLETION (Failure Path)
   ├─> Agent CLI exits with code != 0 OR timeout
   ├─> Wrapper detects failure
   └─> Event: task.lifecycle.failed
       ├─ Payload: reason, error_details, exit_code
       ├─ Routing: task.lifecycle.failed
       ├─ Correlation: Links to started event
       └─ Consumers: task-monitor, dashboard, session-manager

7. CLEANUP
   ├─> Session marked for cleanup (delay: 1 hour)
   ├─> Cleanup scheduler runs
   └─> Session terminated and archived
```

---

## Event Payload Specifications

### 1. task.lifecycle.assigned

**Source:** Obsidian QuickAdd / Bloodbank CLI
**Routing Key:** `task.lifecycle.assigned`

```json
{
  "event_id": "evt_assigned_abc123",
  "event_type": "task.lifecycle.assigned",
  "timestamp": "2025-10-22T14:30:00Z",
  "version": "1.0.0",
  "correlation_id": "corr_xyz789",

  "source": {
    "component": "obsidian.quickadd",
    "host_id": "workstation-001",
    "user_id": "user123"
  },

  "payload": {
    "task_id": "TASK-001",
    "title": "Implement authentication module",
    "description": "Add OAuth2 + JWT authentication to API",
    "instructions": "Use Go standard library...",
    "agent_type": "claude-code",
    "working_dir": "/home/user/code/project",
    "project_name": "api-server",
    "priority": "high",
    "estimated_duration": 3600,
    "tags": ["backend", "security"],
    "metadata": {
      "obsidian_file": "/vault/projects/api/TASK.md",
      "vault_path": "/vault"
    }
  }
}
```

**Go Struct (Existing):**
```go
type TaskLifecycleAssigned struct {
    TaskID        string            `json:"task_id"`
    WorkingDir    string            `json:"working_dir"`
    AgentType     string            `json:"agent_type"`
    Command       string            `json:"command,omitempty"`
    Environment   map[string]string `json:"environment,omitempty"`
    Priority      string            `json:"priority,omitempty"`
    CorrelationID string            `json:"correlation_id"`
    Timestamp     time.Time         `json:"timestamp"`
    Metadata      map[string]any    `json:"metadata,omitempty"`
}
```

---

### 2. task.lifecycle.started

**Source:** flume-agent wrapper
**Routing Key:** `task.lifecycle.started`

```json
{
  "event_id": "evt_started_def456",
  "event_type": "task.lifecycle.started",
  "timestamp": "2025-10-22T14:30:03Z",
  "version": "1.0.0",
  "correlation_id": "corr_xyz789",
  "parent_event_id": "evt_assigned_abc123",

  "source": {
    "component": "flume-agent-wrapper",
    "host_id": "workstation-001",
    "session_id": "sess_TASK-001_1729608603"
  },

  "agent_context": {
    "agent_instance_id": "claude-code-12345",
    "task_id": "TASK-001"
  },

  "payload": {
    "task_id": "TASK-001",
    "session_id": "sess_TASK-001_1729608603",
    "session_manager": "zellij",
    "agent_type": "claude-code",
    "agent_pid": 12345,
    "wrapper_pid": 12344,
    "working_dir": "/home/user/code/project",
    "started_at": "2025-10-22T14:30:03Z",
    "agent_version": "1.2.3",
    "wrapper_version": "0.1.0"
  }
}
```

**Go Struct (Existing - Enhanced):**
```go
type TaskLifecycleStarted struct {
    TaskID          string            `json:"task_id"`
    SessionID       string            `json:"session_id"`
    SessionManager  string            `json:"session_manager"`
    AgentType       string            `json:"agent_type"`
    AgentPID        int               `json:"agent_pid"`
    WrapperPID      int               `json:"wrapper_pid"`
    WorkingDir      string            `json:"working_dir"`
    StartedAt       time.Time         `json:"started_at"`
    CorrelationID   string            `json:"correlation_id"`
    ParentEventID   string            `json:"parent_event_id"`
    AgentVersion    string            `json:"agent_version,omitempty"`
    WrapperVersion  string            `json:"wrapper_version,omitempty"`
    Metadata        map[string]any    `json:"metadata,omitempty"`
}
```

---

### 3. task.lifecycle.in_progress (NEW PAYLOAD)

**Source:** flume-agent wrapper (heartbeat)
**Routing Key:** `task.lifecycle.in_progress`
**Frequency:** Every 60 seconds (configurable)

```json
{
  "event_id": "evt_progress_ghi789",
  "event_type": "task.lifecycle.in_progress",
  "timestamp": "2025-10-22T14:31:03Z",
  "version": "1.0.0",
  "correlation_id": "corr_xyz789",
  "parent_event_id": "evt_started_def456",

  "source": {
    "component": "flume-agent-wrapper",
    "host_id": "workstation-001",
    "session_id": "sess_TASK-001_1729608603"
  },

  "agent_context": {
    "agent_instance_id": "claude-code-12345",
    "task_id": "TASK-001"
  },

  "payload": {
    "task_id": "TASK-001",
    "session_id": "sess_TASK-001_1729608603",
    "progress_percentage": 35,
    "current_activity": "Implementing auth middleware",
    "elapsed_time_seconds": 60,

    "files_modified": [
      "internal/auth/middleware.go",
      "internal/auth/jwt.go"
    ],

    "commands_executed": 8,

    "git_stats": {
      "files_changed": 2,
      "insertions": 87,
      "deletions": 12,
      "branch": "feature/auth"
    },

    "resource_usage": {
      "cpu_percent": 45.2,
      "memory_mb": 256,
      "disk_io_mb": 12
    },

    "metadata": {
      "last_command": "go test ./...",
      "test_status": "passing"
    }
  }
}
```

**Go Struct (NEW):**
```go
type TaskLifecycleInProgress struct {
    TaskID              string         `json:"task_id"`
    SessionID           string         `json:"session_id"`
    ProgressPercentage  int            `json:"progress_percentage"`
    CurrentActivity     string         `json:"current_activity"`
    ElapsedTimeSeconds  int            `json:"elapsed_time_seconds"`
    FilesModified       []string       `json:"files_modified"`
    CommandsExecuted    int            `json:"commands_executed,omitempty"`
    GitStats            *GitStats      `json:"git_stats,omitempty"`
    ResourceUsage       *ResourceUsage `json:"resource_usage,omitempty"`
    Timestamp           time.Time      `json:"timestamp"`
    CorrelationID       string         `json:"correlation_id"`
    ParentEventID       string         `json:"parent_event_id"`
    Metadata            map[string]any `json:"metadata,omitempty"`
}

type GitStats struct {
    FilesChanged int    `json:"files_changed"`
    Insertions   int    `json:"insertions"`
    Deletions    int    `json:"deletions"`
    Branch       string `json:"branch,omitempty"`
}

type ResourceUsage struct {
    CPUPercent float64 `json:"cpu_percent"`
    MemoryMB   int     `json:"memory_mb"`
    DiskIOMB   int     `json:"disk_io_mb"`
}
```

---

### 4. task.lifecycle.completed

**Source:** flume-agent wrapper
**Routing Key:** `task.lifecycle.completed`

```json
{
  "event_id": "evt_completed_jkl012",
  "event_type": "task.lifecycle.completed",
  "timestamp": "2025-10-22T15:00:00Z",
  "version": "1.0.0",
  "correlation_id": "corr_xyz789",
  "parent_event_id": "evt_started_def456",

  "source": {
    "component": "flume-agent-wrapper",
    "host_id": "workstation-001",
    "session_id": "sess_TASK-001_1729608603"
  },

  "agent_context": {
    "agent_instance_id": "claude-code-12345",
    "task_id": "TASK-001"
  },

  "payload": {
    "task_id": "TASK-001",
    "session_id": "sess_TASK-001_1729608603",
    "exit_code": 0,
    "summary": "Successfully implemented OAuth2 authentication with JWT tokens",
    "completed_at": "2025-10-22T15:00:00Z",
    "total_time_seconds": 1800,

    "deliverables": {
      "files_created": [
        "internal/auth/oauth2.go",
        "internal/auth/jwt.go",
        "internal/auth/middleware.go"
      ],
      "files_modified": [
        "cmd/server/main.go",
        "go.mod",
        "go.sum"
      ],
      "tests_added": 12,
      "documentation_updated": true
    },

    "final_git_stats": {
      "total_files_changed": 8,
      "total_insertions": 456,
      "total_deletions": 89,
      "commits_made": 3
    },

    "metadata": {
      "tests_passing": true,
      "build_successful": true,
      "linter_clean": true
    }
  }
}
```

**Go Struct (Enhanced):**
```go
type TaskLifecycleCompleted struct {
    TaskID            string          `json:"task_id"`
    SessionID         string          `json:"session_id"`
    ExitCode          int             `json:"exit_code"`
    Summary           string          `json:"summary"`
    CompletedAt       time.Time       `json:"completed_at"`
    TotalTimeSeconds  int             `json:"total_time_seconds"`
    Deliverables      *Deliverables   `json:"deliverables,omitempty"`
    FinalGitStats     *GitStats       `json:"final_git_stats,omitempty"`
    CorrelationID     string          `json:"correlation_id"`
    ParentEventID     string          `json:"parent_event_id"`
    Metadata          map[string]any  `json:"metadata,omitempty"`
}

type Deliverables struct {
    FilesCreated         []string `json:"files_created"`
    FilesModified        []string `json:"files_modified"`
    FilesDeleted         []string `json:"files_deleted,omitempty"`
    TestsAdded           int      `json:"tests_added,omitempty"`
    DocumentationUpdated bool     `json:"documentation_updated"`
}
```

---

### 5. task.lifecycle.failed

**Source:** flume-agent wrapper OR task-session-manager
**Routing Key:** `task.lifecycle.failed`

```json
{
  "event_id": "evt_failed_mno345",
  "event_type": "task.lifecycle.failed",
  "timestamp": "2025-10-22T14:45:00Z",
  "version": "1.0.0",
  "correlation_id": "corr_xyz789",
  "parent_event_id": "evt_started_def456",

  "source": {
    "component": "flume-agent-wrapper",
    "host_id": "workstation-001",
    "session_id": "sess_TASK-001_1729608603"
  },

  "agent_context": {
    "agent_instance_id": "claude-code-12345",
    "task_id": "TASK-001"
  },

  "payload": {
    "task_id": "TASK-001",
    "session_id": "sess_TASK-001_1729608603",
    "reason": "agent_crashed",
    "error_details": "Agent process terminated unexpectedly: signal: killed",
    "exit_code": 137,
    "failed_at": "2025-10-22T14:45:00Z",
    "elapsed_time_seconds": 900,

    "failure_context": {
      "last_activity": "Running go build",
      "files_in_progress": ["internal/auth/middleware.go"],
      "error_logs": "panic: runtime error...",
      "recoverable": false
    },

    "partial_git_stats": {
      "files_changed": 2,
      "insertions": 45,
      "deletions": 10
    }
  }
}
```

**Go Struct (Enhanced):**
```go
type TaskLifecycleFailed struct {
    TaskID             string          `json:"task_id"`
    SessionID          string          `json:"session_id"`
    Reason             string          `json:"reason"`
    ErrorDetails       string          `json:"error_details"`
    ExitCode           int             `json:"exit_code"`
    FailedAt           time.Time       `json:"failed_at"`
    ElapsedTimeSeconds int             `json:"elapsed_time_seconds"`
    FailureContext     *FailureContext `json:"failure_context,omitempty"`
    PartialGitStats    *GitStats       `json:"partial_git_stats,omitempty"`
    CorrelationID      string          `json:"correlation_id"`
    ParentEventID      string          `json:"parent_event_id"`
    Metadata           map[string]any  `json:"metadata,omitempty"`
}

type FailureContext struct {
    LastActivity      string   `json:"last_activity"`
    FilesInProgress   []string `json:"files_in_progress"`
    ErrorLogs         string   `json:"error_logs"`
    Recoverable       bool     `json:"recoverable"`
}

// Failure reasons (constants)
const (
    FailureReasonAgentCrashed       = "agent_crashed"
    FailureReasonTimeout            = "timeout"
    FailureReasonSessionCreation    = "session_creation_failed"
    FailureReasonContextInjection   = "context_injection_failed"
    FailureReasonConfigurationError = "configuration_error"
    FailureReasonResourceExhaustion = "resource_exhaustion"
)
```

---

## RabbitMQ Routing Patterns

### Exchange Configuration

```yaml
Exchange: task.lifecycle
Type: topic
Durable: true
Auto-delete: false
```

### Routing Keys

| Event Type | Routing Key | Pattern |
|------------|-------------|---------|
| Assigned | `task.lifecycle.assigned` | Direct |
| Started | `task.lifecycle.started` | Direct |
| In Progress | `task.lifecycle.in_progress` | Direct |
| Completed | `task.lifecycle.completed` | Direct |
| Failed | `task.lifecycle.failed` | Direct |
| Paused | `task.lifecycle.paused` | Direct |
| Resumed | `task.lifecycle.resumed` | Direct |
| Stale Alert | `task.alert.stale` | Alert pattern |

### Queue Bindings

**Queue: task.session.assigned**
- Consumer: task-session-manager
- Binding: `task.lifecycle.assigned`
- Purpose: Create sessions for new tasks

**Queue: task.monitor.events**
- Consumer: task-monitor (Python/FastAPI)
- Binding: `task.lifecycle.*`
- Purpose: State tracking and metrics

**Queue: task.dashboard.updates**
- Consumer: task-dashboard (WebSocket)
- Binding: `task.lifecycle.*`
- Purpose: Real-time UI updates

**Queue: task.session.completion**
- Consumer: task-session-manager
- Binding: `task.lifecycle.completed`, `task.lifecycle.failed`
- Purpose: Session cleanup scheduling

---

## Event Correlation Strategy

### Correlation ID Propagation

```
assigned event (corr_xyz789)
    ├─> session creation
    ├─> started event (corr_xyz789, parent: evt_assigned_abc123)
    │   ├─> in_progress #1 (corr_xyz789, parent: evt_started_def456)
    │   ├─> in_progress #2 (corr_xyz789, parent: evt_started_def456)
    │   ├─> in_progress #3 (corr_xyz789, parent: evt_started_def456)
    │   └─> completed event (corr_xyz789, parent: evt_started_def456)
    └─> cleanup scheduled
```

**Rules:**
1. `correlation_id` is **generated once** in assigned event
2. All subsequent events **inherit** the same correlation_id
3. `parent_event_id` links to the **immediate preceding** event
4. This enables full **event chain reconstruction**

---

## Event Publisher Implementation

### Go Publisher (Enhanced)

```go
package events

import (
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/streadway/amqp"
    "github.com/rs/zerolog"
)

// EventEnvelope wraps all lifecycle events
type EventEnvelope struct {
    EventID       string    `json:"event_id"`
    EventType     string    `json:"event_type"`
    Timestamp     time.Time `json:"timestamp"`
    Version       string    `json:"version"`
    CorrelationID string    `json:"correlation_id"`
    ParentEventID string    `json:"parent_event_id,omitempty"`
    Source        Source    `json:"source"`
    AgentContext  *AgentContext `json:"agent_context,omitempty"`
    Payload       any       `json:"payload"`
}

type Source struct {
    Component string `json:"component"`
    HostID    string `json:"host_id"`
    SessionID string `json:"session_id,omitempty"`
    UserID    string `json:"user_id,omitempty"`
}

type AgentContext struct {
    AgentInstanceID string `json:"agent_instance_id"`
    TaskID          string `json:"task_id"`
}

// Publisher publishes lifecycle events
type Publisher struct {
    conn      *amqp.Connection
    channel   *amqp.Channel
    exchange  string
    hostname  string
    component string
    logger    zerolog.Logger
}

func NewPublisher(url, exchange, component string, logger zerolog.Logger) (*Publisher, error) {
    conn, err := amqp.Dial(url)
    if err != nil {
        return nil, fmt.Errorf("failed to connect: %w", err)
    }

    ch, err := conn.Channel()
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("failed to open channel: %w", err)
    }

    // Declare exchange (idempotent)
    err = ch.ExchangeDeclare(
        exchange,
        "topic",
        true,  // durable
        false, // auto-deleted
        false, // internal
        false, // no-wait
        nil,
    )
    if err != nil {
        ch.Close()
        conn.Close()
        return nil, fmt.Errorf("failed to declare exchange: %w", err)
    }

    hostname, _ := os.Hostname()

    return &Publisher{
        conn:      conn,
        channel:   ch,
        exchange:  exchange,
        hostname:  hostname,
        component: component,
        logger:    logger,
    }, nil
}

func (p *Publisher) PublishStarted(payload *TaskLifecycleStarted) error {
    envelope := EventEnvelope{
        EventID:       uuid.New().String(),
        EventType:     "task.lifecycle.started",
        Timestamp:     time.Now(),
        Version:       "1.0.0",
        CorrelationID: payload.CorrelationID,
        ParentEventID: payload.ParentEventID,
        Source: Source{
            Component: p.component,
            HostID:    p.hostname,
            SessionID: payload.SessionID,
        },
        AgentContext: &AgentContext{
            TaskID: payload.TaskID,
        },
        Payload: payload,
    }

    return p.publish("task.lifecycle.started", envelope)
}

func (p *Publisher) PublishInProgress(payload *TaskLifecycleInProgress) error {
    envelope := EventEnvelope{
        EventID:       uuid.New().String(),
        EventType:     "task.lifecycle.in_progress",
        Timestamp:     time.Now(),
        Version:       "1.0.0",
        CorrelationID: payload.CorrelationID,
        ParentEventID: payload.ParentEventID,
        Source: Source{
            Component: p.component,
            HostID:    p.hostname,
            SessionID: payload.SessionID,
        },
        AgentContext: &AgentContext{
            TaskID: payload.TaskID,
        },
        Payload: payload,
    }

    return p.publish("task.lifecycle.in_progress", envelope)
}

func (p *Publisher) publish(routingKey string, envelope EventEnvelope) error {
    body, err := json.Marshal(envelope)
    if err != nil {
        return fmt.Errorf("failed to marshal: %w", err)
    }

    err = p.channel.Publish(
        p.exchange,
        routingKey,
        false, // mandatory
        false, // immediate
        amqp.Publishing{
            ContentType:  "application/json",
            DeliveryMode: amqp.Persistent,
            Timestamp:    time.Now(),
            MessageId:    envelope.EventID,
            Body:         body,
        },
    )

    if err != nil {
        return fmt.Errorf("failed to publish: %w", err)
    }

    p.logger.Debug().
        Str("event_id", envelope.EventID).
        Str("routing_key", routingKey).
        Msg("Event published")

    return nil
}

func (p *Publisher) Close() {
    if p.channel != nil {
        p.channel.Close()
    }
    if p.conn != nil {
        p.conn.Close()
    }
}
```

---

## Python Consumer Integration

### Enhanced Event Handler

```python
# task-monitor/consumer.py

async def handle_in_progress_event(self, task_id: str, event: TaskEvent) -> None:
    """Handle in_progress events with enhanced payload."""

    # Extract enhanced payload data
    data = event.data
    progress_pct = data.get("progress_percentage", 0)
    current_activity = data.get("current_activity", "")
    files_modified = data.get("files_modified", [])
    git_stats = data.get("git_stats", {})

    # Update task state
    task_state = await self.state_manager.get_task(task_id)
    if task_state:
        task_state.last_heartbeat = event.timestamp
        task_state.metadata["progress_percentage"] = progress_pct
        task_state.metadata["current_activity"] = current_activity
        task_state.metadata["files_modified"] = files_modified
        task_state.metadata["git_stats"] = git_stats

        await self.state_manager.update_task(task_state)

        # Emit WebSocket update
        await self.ws_broadcast({
            "type": "task_progress",
            "task_id": task_id,
            "progress": progress_pct,
            "activity": current_activity,
            "files": files_modified
        })
```

---

## Idempotency and Deduplication

### Event Deduplication Strategy

```python
# In state_manager.py

class EventCache:
    """In-memory cache for event deduplication."""

    def __init__(self, ttl: int = 3600):
        self.cache: Dict[str, datetime] = {}
        self.ttl = ttl

    def is_duplicate(self, event_id: str) -> bool:
        """Check if event was recently processed."""
        if event_id in self.cache:
            age = (datetime.now(timezone.utc) - self.cache[event_id]).total_seconds()
            if age < self.ttl:
                return True
            else:
                del self.cache[event_id]
        return False

    def mark_processed(self, event_id: str) -> None:
        """Mark event as processed."""
        self.cache[event_id] = datetime.now(timezone.utc)
```

---

## Performance Characteristics

| Metric | Target | Notes |
|--------|--------|-------|
| Event Emission Latency | < 50ms | Wrapper to RabbitMQ |
| Event Consumption Latency | < 100ms | RabbitMQ to consumer |
| End-to-End Latency | < 200ms | Emission to state update |
| Throughput | 1000 events/sec | Per exchange |
| Event Size | < 10KB | Typical payload |
| Retention | 24 hours | Queue TTL |

---

## Testing Strategy

### Event Flow Integration Tests

```go
func TestCompleteEventFlow(t *testing.T) {
    // Setup test RabbitMQ
    broker := setupTestBroker(t)
    defer broker.Close()

    // Setup consumers
    sessionMgr := setupSessionManager(t, broker)
    monitor := setupMonitor(t, broker)

    // 1. Publish assigned event
    assignedEvent := &TaskLifecycleAssigned{
        TaskID:        "TEST-001",
        AgentType:     "test-agent",
        WorkingDir:    "/tmp/test",
        CorrelationID: "test-corr-001",
    }

    publisher.PublishAssigned(assignedEvent)

    // 2. Wait for started event
    startedEvent := waitForEvent(t, "task.lifecycle.started", 5*time.Second)
    assert.Equal(t, "TEST-001", startedEvent.TaskID)
    assert.Equal(t, "test-corr-001", startedEvent.CorrelationID)

    // 3. Wait for in_progress events
    progressEvents := collectEvents(t, "task.lifecycle.in_progress", 3, 10*time.Second)
    assert.Len(t, progressEvents, 3)

    // 4. Wait for completed event
    completedEvent := waitForEvent(t, "task.lifecycle.completed", 30*time.Second)
    assert.Equal(t, 0, completedEvent.ExitCode)
    assert.Equal(t, "test-corr-001", completedEvent.CorrelationID)
}
```

---

**End of Event Flow Architecture Document**
