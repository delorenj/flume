# CLI Shell Integration: Architecture Summary

**Project:** Flume Task Lifecycle System
**Component:** CLI Shell Integration Layer
**Version:** 1.0.0
**Date:** 2025-10-22
**Status:** Architecture Design Complete

---

## Executive Summary

This document provides a comprehensive overview of the CLI Shell Integration architecture for the Flume task lifecycle system. The system enables seamless integration between terminal-based AI agent CLIs (Claude Code, Gemini, etc.) and the event-driven task management infrastructure.

**Mission:** Transform Obsidian task assignment into autonomous agent execution with full lifecycle tracking, progress monitoring, and automated cleanup.

---

## Architecture Components

The CLI shell integration consists of four major architectural components:

### 1. Wrapper Design (`flume-agent`)

**Document:** [01-wrapper-design.md](./01-wrapper-design.md)

**Purpose:** Thin orchestration layer that bridges agent CLIs with the Flume lifecycle system.

**Key Capabilities:**
- Task context injection (environment variables + prompt templates)
- Agent CLI invocation with proper configuration
- Heartbeat-based progress monitoring (60s intervals)
- Completion detection (exit code, timeout, signal)
- Bidirectional event emission (started, in_progress, completed, failed)

**Performance Targets:**
- Startup overhead: < 200ms
- Heartbeat CPU: < 1%
- Memory footprint: < 20MB
- Event latency: < 50ms

**Technology Stack:**
- **Language:** Go
- **Event Bus:** RabbitMQ (AMQP)
- **Logging:** zerolog (structured JSON)
- **Configuration:** YAML + environment variables

---

### 2. Session Management Enhancement

**Document:** [02-session-management.md](./02-session-management.md)

**Purpose:** Enhanced task-session-manager with state persistence, recovery, and automated cleanup.

**Key Enhancements:**
- **Wrapper Integration:** Spawn `flume-agent` instead of raw CLI
- **State Persistence:** SQLite database for session records
- **Health Monitoring:** Heartbeat tracking and stale detection
- **Cleanup Automation:** Scheduled cleanup with configurable delay
- **Session Recovery:** Reconnect to existing sessions after restart

**Database Schema:**
```sql
sessions (
  session_id, task_id, agent_type, working_dir,
  session_name, session_manager, agent_pid, wrapper_pid,
  status, created_at, started_at, last_heartbeat,
  completed_at, cleanup_at, correlation_id, ...
)
```

**Performance Targets:**
- Session creation: < 3s
- Registry lookup: < 1ms (in-memory cache)
- Stale detection: < 100ms (for 1000 sessions)
- Recovery: < 5s (for 100 sessions)

---

### 3. Event Flow Design

**Document:** [03-event-flows.md](./03-event-flows.md)

**Purpose:** Complete event-driven lifecycle with consistency, traceability, and observability.

**Event Types (7 Existing):**
1. `task.lifecycle.assigned` - Task assignment from Obsidian
2. `task.lifecycle.started` - Agent execution begins (wrapper)
3. `task.lifecycle.in_progress` - Heartbeat progress updates (wrapper)
4. `task.lifecycle.completed` - Successful completion (wrapper)
5. `task.lifecycle.failed` - Failure or timeout (wrapper)
6. `task.lifecycle.paused` - Execution paused (future)
7. `task.lifecycle.resumed` - Execution resumed (future)

**New Payload Enhancements:**
- `in_progress`: progress_percentage, files_modified, git_stats, resource_usage
- `completed`: deliverables, final_git_stats, tests_added
- `failed`: failure_context, partial_git_stats, recoverable flag

**Event Flow Sequence:**
```
Obsidian → assigned event → Session Manager → Wrapper Launch →
started event → [in_progress events x N] → completed/failed event →
Session Cleanup
```

**Correlation Strategy:**
- Single `correlation_id` generated in assigned event
- `parent_event_id` links to immediate predecessor
- Full event chain reconstruction for tracing

---

### 4. Configuration Architecture

**Document:** [04-configuration.md](./04-configuration.md)

**Purpose:** Centralized, hierarchical configuration with security and cross-platform support.

**Configuration File:** `~/.config/flume/config.yaml`

**Major Sections:**
1. **RabbitMQ:** Connection, TLS, reconnection strategy
2. **Agents:** CLI configurations (claude-code, gemini, gpt-cli, custom)
3. **Session:** Multiplexer settings, database path, recovery
4. **Monitoring:** Heartbeat, logging, metrics, observability
5. **Completion:** Timeout, cleanup, archival
6. **Security:** Secret management, resource limits, validation
7. **Platform:** Linux/macOS/Windows terminal launching

**Loading Hierarchy:**
1. Command-line flags (highest priority)
2. Environment variables
3. Config file
4. Built-in defaults (lowest priority)

**Environment Variable Injection:**
- `FLUME_TASK_ID`, `FLUME_SESSION_ID`, `FLUME_CORRELATION_ID`
- `FLUME_PROJECT_PATH`, `FLUME_AGENT_TYPE`, `FLUME_PRIORITY`
- Agent-specific: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc.

---

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     FLUME CLI SHELL INTEGRATION                      │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────┐
│   Obsidian   │  1. User creates/edits TASK.md
│  QuickAdd    │  2. Fires task.lifecycle.assigned event
└──────┬───────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────┐
│                        RabbitMQ (Bloodbank)                         │
│  Exchange: task.lifecycle (topic)                                   │
│  Routing: task.lifecycle.{assigned,started,in_progress,...}        │
└──────┬──────────────────────────────────────┬──────────────────────┘
       │                                       │
       │ (assigned)                            │ (all events)
       ▼                                       ▼
┌─────────────────────┐              ┌──────────────────────┐
│ Task Session Mgr    │              │  Task Monitor        │
│ (Go)                │              │  (Python/FastAPI)    │
├─────────────────────┤              ├──────────────────────┤
│ - Consume assigned  │              │ - Consume all events │
│ - Create session    │              │ - Update state DB    │
│   record (SQLite)   │              │ - Emit WebSocket     │
│ - Spawn tmux/zellij │              │ - Metrics/alerts     │
│ - Launch wrapper    │              └──────────────────────┘
└─────────┬───────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Terminal Session (tmux/zellij)                │
│  Session Name: task-TASK-001                                     │
│  Working Dir: /home/user/code/project                            │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │          flume-agent Wrapper (Go binary)                    │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ 1. Parse task context from TASK.md                         │ │
│  │ 2. Inject environment variables                            │ │
│  │ 3. Render prompt template                                  │ │
│  │ 4. Launch agent CLI (claude/gemini/etc.)                   │ │
│  │ 5. Emit started event                                      │ │
│  │ 6. Start heartbeat monitor (every 60s)                     │ │
│  │    - Collect git stats                                     │ │
│  │    - Detect file modifications                             │ │
│  │    - Emit in_progress event                                │ │
│  │ 7. Wait for completion                                     │ │
│  │    - Detect exit code / timeout / signal                   │ │
│  │    - Emit completed/failed event                           │ │
│  └────────┬───────────────────────────────────────────────────┘ │
│           │                                                       │
│           ▼                                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │         Agent CLI (claude / gemini / gpt / etc.)           │ │
│  │                                                             │ │
│  │  Environment:                                               │ │
│  │    FLUME_TASK_ID=TASK-001                                  │ │
│  │    FLUME_SESSION_ID=sess_TASK-001_1729608603              │ │
│  │    FLUME_CORRELATION_ID=corr_xyz789                        │ │
│  │    ANTHROPIC_API_KEY=sk-...                                │ │
│  │                                                             │ │
│  │  Prompt:                                                    │ │
│  │    # TASK: TASK-001 - Implement auth module                │ │
│  │    [Full task context with lifecycle instructions]         │ │
│  │                                                             │ │
│  │  Execution:                                                 │ │
│  │    - Reads files                                           │ │
│  │    - Writes code                                           │ │
│  │    - Runs tests                                            │ │
│  │    - Commits changes                                       │ │
│  │    - Exits with code 0 (success) or != 0 (failure)        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

           │ (events flow back to RabbitMQ)
           ▼

┌──────────────────────────────────────────────────────────────────┐
│                      Task Dashboard (Next.js)                     │
│  - Real-time WebSocket updates                                    │
│  - Display task status, progress, files modified                  │
│  - Show agent activity and logs                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Example

### Complete Task Lifecycle

**Scenario:** User assigns "Implement auth module" task to Claude Code

**1. Assignment (Obsidian)**
```json
{
  "event_type": "task.lifecycle.assigned",
  "correlation_id": "corr_abc123",
  "payload": {
    "task_id": "TASK-001",
    "agent_type": "claude-code",
    "working_dir": "/home/user/code/api",
    "title": "Implement OAuth2 authentication"
  }
}
```

**2. Session Creation (Session Manager)**
- Receives assigned event
- Creates session record in SQLite:
  - `session_id`: `sess_TASK-001_1729608603`
  - `status`: `starting`
  - `correlation_id`: `corr_abc123`
- Spawns zellij session: `task-TASK-001`
- Launches wrapper: `flume-agent --task-id TASK-001 --agent claude-code ...`

**3. Agent Startup (Wrapper)**
```json
{
  "event_type": "task.lifecycle.started",
  "correlation_id": "corr_abc123",
  "parent_event_id": "evt_assigned_xyz",
  "payload": {
    "session_id": "sess_TASK-001_1729608603",
    "agent_pid": 12345,
    "started_at": "2025-10-22T14:30:03Z"
  }
}
```

**4. Progress Updates (Wrapper, every 60s)**
```json
{
  "event_type": "task.lifecycle.in_progress",
  "correlation_id": "corr_abc123",
  "payload": {
    "progress_percentage": 45,
    "current_activity": "Implementing JWT middleware",
    "files_modified": ["internal/auth/jwt.go"],
    "git_stats": {
      "files_changed": 3,
      "insertions": 87,
      "deletions": 12
    }
  }
}
```

**5. Completion (Wrapper)**
```json
{
  "event_type": "task.lifecycle.completed",
  "correlation_id": "corr_abc123",
  "payload": {
    "exit_code": 0,
    "summary": "OAuth2 auth implemented with tests",
    "total_time_seconds": 1823,
    "deliverables": {
      "files_created": ["internal/auth/oauth2.go", "..."],
      "tests_added": 12
    }
  }
}
```

**6. Cleanup (Session Manager)**
- Marks session for cleanup (delay: 1 hour)
- Cleanup scheduler eventually:
  - Kills zellij session
  - Deletes session record
  - Archives logs

---

## Integration Points

### Existing Components (No Changes Required)

1. **Event Schema (Python/Pydantic)** - `task-monitor/models.py`
   - Already supports 7 event types
   - State transitions are correct
   - No breaking changes needed

2. **Task Monitor (FastAPI)** - `task-monitor/`
   - Consumes all events via RabbitMQ
   - Updates task state in memory/database
   - Emits WebSocket updates to dashboard
   - **Enhancement:** Handle richer `in_progress` payloads

3. **Task Dashboard (Next.js)** - `task-dashboard/`
   - Real-time UI via WebSocket
   - **Enhancement:** Display progress, files, git stats

4. **RabbitMQ (Bloodbank)** - Already configured
   - Topic exchange: `task.lifecycle`
   - Routing keys: `task.lifecycle.*`

### New Components (To Be Implemented)

1. **flume-agent Wrapper (Go)** - NEW
   - Standalone binary: `/usr/local/bin/flume-agent`
   - Package structure defined in wrapper-design.md
   - Implements all event emission logic

2. **Enhanced Session Manager (Go)** - ENHANCED
   - Add session registry with SQLite persistence
   - Add heartbeat consumer for in_progress events
   - Add stale detection and cleanup automation
   - Modify CreateSession to invoke wrapper

3. **Configuration System** - NEW
   - Config file: `~/.config/flume/config.yaml`
   - Loader with environment variable expansion
   - Validation and migration tools

---

## Implementation Roadmap

### Phase 1: Core Wrapper (Week 1)

**Deliverables:**
- [ ] Go project scaffold for `flume-agent`
- [ ] Configuration loading (YAML + env vars)
- [ ] Task context extraction from TASK.md
- [ ] Prompt template rendering
- [ ] Agent CLI invocation (claude-code only)
- [ ] Event publisher (started, completed, failed)
- [ ] Basic heartbeat monitor (git stats)
- [ ] Completion detection (exit code, timeout)
- [ ] Unit tests (context, templates, events)

**Success Criteria:**
- Wrapper can launch Claude Code with task context
- Events are emitted to RabbitMQ correctly
- Exit code determines completion status

---

### Phase 2: Session Management (Week 2)

**Deliverables:**
- [ ] SQLite schema for session persistence
- [ ] Session registry implementation
- [ ] Enhanced CreateSession in session manager
- [ ] Heartbeat consumer for in_progress events
- [ ] Stale session detector
- [ ] Cleanup scheduler
- [ ] Session recovery on restart
- [ ] Integration tests (end-to-end)

**Success Criteria:**
- Sessions persist across restarts
- Stale sessions detected automatically
- Cleanup happens after configured delay

---

### Phase 3: Multi-Agent Support (Week 3)

**Deliverables:**
- [ ] Agent registry implementation
- [ ] Support for Gemini CLI
- [ ] Support for GPT CLI
- [ ] Agent auto-detection
- [ ] Configuration for custom agents
- [ ] Platform-specific terminal launching
- [ ] Enhanced documentation

**Success Criteria:**
- Multiple agent types work seamlessly
- Config supports easy agent addition
- Terminal windows open correctly on all platforms

---

### Phase 4: Observability & Polish (Week 4)

**Deliverables:**
- [ ] Enhanced dashboard with progress bars
- [ ] File modification display in UI
- [ ] Git stats visualization
- [ ] Activity log streaming
- [ ] Prometheus metrics endpoint
- [ ] OpenTelemetry integration (optional)
- [ ] Configuration migration tool
- [ ] End-user documentation
- [ ] Performance benchmarks

**Success Criteria:**
- Dashboard shows rich real-time data
- Metrics available for monitoring
- Documentation complete for users

---

## Non-Functional Requirements

### Performance

| Metric | Target | Critical |
|--------|--------|----------|
| Session spawn time | < 3s | Yes |
| Wrapper startup | < 200ms | Yes |
| Event emission latency | < 100ms | Yes |
| Heartbeat CPU usage | < 1% | Yes |
| Memory per session | < 50MB | Yes |
| Stale detection | < 100ms | No |

### Reliability

- **Event Delivery:** At-least-once via RabbitMQ
- **Session Recovery:** 100% after planned restart
- **Error Handling:** Graceful degradation, always emit failure events
- **Data Persistence:** SQLite with WAL mode

### Security

- **Secrets:** Never log API keys or credentials
- **File Access:** Validate working directory, no path traversal
- **Permissions:** Config file 0600, database 0600
- **Network:** Support TLS for RabbitMQ
- **Isolation:** Each session in separate shell environment

### Usability

- **Zero-config:** Works with sensible defaults
- **Discoverable:** `flume-agent --help` is comprehensive
- **Debuggable:** Verbose logging mode available
- **Cross-platform:** Linux, macOS, Windows (WSL)

---

## Testing Strategy

### Unit Tests

- **Wrapper:** Context extraction, template rendering, event payloads
- **Registry:** CRUD operations, filtering, caching
- **Publisher:** Event emission, correlation IDs
- **Config:** Loading, validation, environment expansion

### Integration Tests

- **End-to-End Flow:** Obsidian → Session → Wrapper → Agent → Completion
- **Event Chain:** Verify all events emitted correctly
- **Session Recovery:** Restart session manager, verify reconnection
- **Multi-Agent:** Test multiple agent types

### Performance Tests

- **Load:** 100 concurrent sessions
- **Latency:** Measure event emission and consumption
- **Memory:** Profile wrapper and session manager
- **Cleanup:** Verify no resource leaks

### Manual Tests

- **Real Agents:** Test with actual Claude Code, Gemini CLIs
- **Terminal Launching:** Verify on Linux/macOS/Windows
- **Dashboard:** Verify real-time updates
- **Error Cases:** Test timeout, crash, signal handling

---

## Risk Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Agent CLI changes interface | High | Medium | Version pinning, adapter pattern |
| Session multiplexer unavailable | High | Low | Auto-detect, fallback to plain shell |
| RabbitMQ connection loss | High | Medium | Retry with exponential backoff |
| Zombie sessions accumulate | Medium | High | Automatic cleanup, monitoring |
| Context injection fails | High | Low | Validation, error events |
| Cross-platform incompatibility | Medium | Medium | Platform detection, abstraction |
| Performance degradation at scale | Medium | Low | Benchmark, tune heartbeat interval |

---

## Success Metrics

### Functional

- ✅ User assigns task in Obsidian
- ✅ Terminal automatically opens with agent running
- ✅ Agent receives full task context
- ✅ Dashboard shows real-time progress
- ✅ Completion detected automatically
- ✅ Session cleaned up after timeout

### Non-Functional

- ✅ 95%+ success rate for session spawning
- ✅ < 5s end-to-end latency (assignment to agent start)
- ✅ < 1% CPU overhead from monitoring
- ✅ Zero manual intervention for happy path
- ✅ Full event traceability via correlation IDs

---

## Future Enhancements

### Phase 2 (Beyond MVP)

- **Multi-agent collaboration:** Multiple agents on same task
- **Agent handoff:** Transfer task between agents
- **Session templates:** Pre-configured environments per project
- **Remote execution:** Agents run on remote machines
- **Resource limits:** CPU/memory caps per session via cgroups

### Phase 3 (Advanced)

- **ML-based progress estimation:** Train model on historical data
- **Predictive scheduling:** Start sessions before user requests
- **Natural language commands:** Voice-activated task assignment
- **CI/CD integration:** Tasks trigger on git events
- **Mobile monitoring:** View sessions from phone
- **Team collaboration:** Multi-user task boards

---

## Document References

| Document | Purpose | Path |
|----------|---------|------|
| **Wrapper Design** | flume-agent architecture | `01-wrapper-design.md` |
| **Session Management** | Enhanced session manager | `02-session-management.md` |
| **Event Flows** | Lifecycle event specifications | `03-event-flows.md` |
| **Configuration** | Config schema and loading | `04-configuration.md` |
| **Requirements** | Original requirements spec | `../CLI_SHELL_INTEGRATION_REQUIREMENTS.md` |

---

## Getting Started (For Developers)

### Prerequisites

1. **Install Dependencies:**
   ```bash
   # Go 1.22+
   go version

   # RabbitMQ
   docker run -d -p 5672:5672 rabbitmq:3-management

   # Terminal multiplexer
   brew install zellij  # or: apt install zellij
   ```

2. **Clone Repository:**
   ```bash
   cd /home/delorenj/code/projects/33GOD/flume/trunk-main
   ```

3. **Read Architecture Docs:**
   - Start with this summary
   - Read wrapper-design.md for implementation details
   - Review event-flows.md for event payloads
   - Check configuration.md for config examples

4. **Implement in Order:**
   - Phase 1: Wrapper (Go)
   - Phase 2: Session Manager enhancements (Go)
   - Phase 3: Multi-agent support
   - Phase 4: Observability

### First Steps

```bash
# Create wrapper project
mkdir -p flume-agent/{cmd,pkg,internal}
cd flume-agent

# Initialize Go module
go mod init github.com/33GOD/flume/flume-agent

# Create main.go
touch cmd/main.go

# Install dependencies
go get github.com/streadway/amqp
go get github.com/rs/zerolog
go get gopkg.in/yaml.v3
```

---

**Architecture design complete and ready for implementation.**

**Next Steps:** Begin Phase 1 implementation (flume-agent wrapper).
