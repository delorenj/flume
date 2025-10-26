# CLI Shell Integration Requirements Specification

**Project:** Flume Task Lifecycle System
**Component:** Terminal Shell Integration Layer
**Version:** 1.0.0
**Date:** 2025-10-22
**Status:** Requirements Definition

---

## Executive Summary

Extend the existing event-driven task lifecycle system to provide seamless integration with terminal-based AI agent CLIs (Claude Code, Gemini, etc.) through intelligent shell session management and agent invocation hooks.

### Key Objectives

1. **Terminal Session Lifecycle Management**: Automate creation, monitoring, and cleanup of terminal sessions for AI agents
2. **Agent CLI Wrapper**: Standardized interface for invoking different agent CLIs with consistent task context injection
3. **Bidirectional Event Flow**: Enable agents to emit lifecycle events back to the monitoring system
4. **Session Persistence**: Support session recovery and reconnection after interruptions
5. **Observable Execution**: Full visibility into agent activities, commands, and outputs

---

## System Context

### Existing Infrastructure

The following components are **already implemented and functional**:

- ✅ **Event Schema System** (Python/Pydantic) - 7 lifecycle event types
- ✅ **Bloodbank CLI** (`bb task-assign`) - Task assignment from terminal
- ✅ **Obsidian QuickAdd Integration** - Task assignment from Obsidian
- ✅ **Task Session Manager** (Go) - Session creation and agent spawning
- ✅ **Task Monitor Service** (FastAPI) - Event consumption and state tracking
- ✅ **Task Dashboard** (React/Next.js) - Real-time monitoring UI
- ✅ **RabbitMQ Bloodbank** - Topic exchange with routing

### Current Workflow

```
Obsidian TASK.md → QuickAdd Macro → RabbitMQ Event → Session Manager →
Tmux/Zellij Session → Agent CLI (claude/gemini/etc.) → Manual Interaction
```

### Gap Analysis

**What's Missing:**

1. **Agent CLI doesn't know it's part of a lifecycle** - No awareness of task context, no event emission
2. **Manual intervention required** - User must manually interact with spawned sessions
3. **No task context injection** - Agent doesn't receive TASK.md or event metadata automatically
4. **No progress reporting** - Agent can't emit `task.lifecycle.in_progress` events
5. **No completion detection** - System doesn't know when agent finishes
6. **No session cleanup** - Zombie sessions accumulate over time

---

## Requirements

### 1. Agent CLI Wrapper

**Purpose:** Standardized interface for all agent CLIs that injects task context and enables event emission.

#### 1.1 Wrapper Script Architecture

**File:** `flume-agent` (shell script or Go binary)

**Capabilities:**
- Parse task event payload from environment or stdin
- Extract TASK.md content and metadata
- Invoke appropriate agent CLI with task context
- Monitor agent execution
- Emit progress events at intervals
- Detect completion and emit final events
- Handle errors and emit failure events

**Usage Example:**
```bash
# Invoked by task-session-manager
flume-agent --task-id TASK-001 \
            --agent claude-code \
            --working-dir /code/project \
            --task-file /tmp/TASK-001.md \
            --event-source task-event-123
```

#### 1.2 Agent CLI Support Matrix

| Agent CLI      | Binary Name   | Context Flag       | Status        |
|----------------|---------------|--------------------|---------------|
| Claude Code    | `claude`      | `@TASK.md`         | Priority 1    |
| Gemini         | `gemini`      | `-f TASK.md`       | Priority 2    |
| Cursor         | `cursor`      | TBD                | Future        |
| Windsurf       | `windsurf`    | TBD                | Future        |
| Custom         | Configurable  | Template-based     | Extensible    |

#### 1.3 Task Context Injection

The wrapper must inject task context in two forms:

**A. Environment Variables:**
```bash
FLUME_TASK_ID=TASK-001
FLUME_EVENT_ID=event-abc-123
FLUME_PROJECT_PATH=/code/project
FLUME_AGENT_TYPE=claude-code
FLUME_PRIORITY=high
FLUME_RABBITMQ_URL=amqp://localhost:5672
```

**B. Task Prompt Construction:**
```markdown
# TASK: {task_id} - {title}

{description}

## Context
- Project: {project_name}
- Working Directory: {working_dir}
- Priority: {priority}
- Event ID: {event_id}
- Assigned: {timestamp}

## Instructions
{task_instructions}

## Reporting
This task is part of a lifecycle system. You MUST:
1. Report progress by updating the TASK.md file with status
2. Use TodoWrite tool to track subtasks
3. Document decisions and blockers
4. Report completion when done

Event System: task.lifecycle.* events are being tracked.
Session ID: {session_id}
```

---

### 2. Event Emission from Agent Context

**Purpose:** Enable agents to report their state back to the monitoring system.

#### 2.1 Progress Event Emission

**Mechanism:** Background process monitors agent activity and emits events

**Heartbeat Events:**
- Frequency: Every 60 seconds by default (configurable)
- Event Type: `task.lifecycle.in_progress`
- Payload: Progress percentage, current activity, files modified

**Implementation Options:**

**Option A: Shell Script Monitor (Simple)**
```bash
# flume-monitor.sh
while true; do
  git diff --name-only | publish_progress_event
  sleep 60
done
```

**Option B: Agent Instrumentation (Advanced)**
```bash
# Inject into agent's shell environment
export PROMPT_COMMAND="flume_emit_progress"
```

**Option C: Log Tailing (Pragmatic)**
```bash
# Monitor agent output and detect progress signals
tail -f session.log | grep -E "completed|progress" | emit_events
```

#### 2.2 Completion Detection

**Automatic Detection Criteria:**
- Agent CLI exits (exit code determines success/failure)
- User types "exit" or closes session
- TASK.md updated with "completed" status
- Timeout reached (configurable, default 4 hours)

**Manual Completion:**
```bash
# User or agent can explicitly signal completion
flume-complete --task-id TASK-001 --status completed --summary "Task done"
```

---

### 3. Session Management Enhancements

**Purpose:** Improve the existing Go session manager to support wrapper integration.

#### 3.1 Enhanced Session Spawning

**Current:**
```go
// Spawns raw agent CLI in tmux/zellij session
sessionMgr.CreateSession(taskID, agentCLI)
```

**Enhanced:**
```go
// Spawns agent through flume-agent wrapper
sessionMgr.CreateSession(taskID, "flume-agent", wrapperArgs)
```

#### 3.2 Session State Tracking

Track sessions in-memory and optionally persist to SQLite:

```go
type SessionState struct {
    TaskID      string
    SessionID   string
    SessionName string
    AgentType   string
    StartTime   time.Time
    LastHeartbeat time.Time
    Status      string // "running", "stale", "completed", "failed"
    PID         int
}
```

#### 3.3 Session Recovery

**On Restart:**
- Reconnect to existing tmux/zellij sessions
- Resume event emission
- Update monitoring with recovered sessions

**Command:**
```bash
# List all active sessions
flume-session list

# Reconnect to session
flume-session attach TASK-001

# Clean up zombie sessions
flume-session cleanup --stale-threshold 24h
```

---

### 4. Obsidian Shell Integration

**Purpose:** Extend Obsidian integration to support shell-based workflows.

#### 4.1 Enhanced QuickAdd Macros

**New Macros:**

**1. "Open Task in Terminal"**
- Reads current TASK.md in Obsidian
- Fires task.lifecycle.assigned event
- Opens new terminal window
- Attaches to spawned session automatically

**2. "Check Task Progress"**
- Queries monitoring API for task status
- Displays progress in Obsidian notice
- Optionally opens dashboard in browser

**3. "Mark Task Complete"**
- Updates TASK.md frontmatter
- Emits task.lifecycle.completed event
- Archives task notes

#### 4.2 Terminal Bridge Script

**File:** `flume-obsidian-bridge.sh`

**Capabilities:**
- Called by Obsidian QuickAdd
- Fires task assignment event
- Launches terminal emulator
- Attaches to session
- Returns control to Obsidian

**Platform-Specific Terminal Launching:**
```bash
# Linux
gnome-terminal -- zellij attach task-001

# macOS
open -a Terminal.app zellij attach task-001

# Windows WSL
wsl.exe -e zellij attach task-001
```

---

### 5. Agent Activity Instrumentation

**Purpose:** Provide deep observability into what agents are doing.

#### 5.1 Activity Capture

**Captured Events:**
- Commands executed (via shell history or script wrapper)
- Files read/written (via fs watcher or git diff)
- Network requests (if applicable)
- Tool invocations (TodoWrite, Read, Edit, etc.)
- Time spent per activity

**Storage:**
```
/var/log/flume/sessions/{task_id}/
├── session.log          # Full terminal output
├── commands.log         # Executed commands
├── files.log            # File operations
├── events.jsonl         # Emitted events
└── metadata.json        # Session metadata
```

#### 5.2 Real-Time Activity Streaming

**WebSocket Enhancement:**
- Stream terminal output to dashboard
- Display current command/activity
- Show file diffs in real-time
- Enable remote session observation

---

### 6. Configuration System

**Purpose:** Centralized configuration for all CLI components.

#### 6.1 Configuration File

**File:** `~/.config/flume/config.yaml`

```yaml
# Flume CLI Configuration

rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "task_events"

agents:
  claude-code:
    binary: "claude"
    context_flag: "@"
    supports_markdown: true
    default_args: ["--verbose"]

  gemini:
    binary: "gemini"
    context_flag: "-f"
    supports_markdown: true

session:
  manager: "zellij"  # or "tmux"
  session_prefix: "flume-task-"
  working_dir_base: "/home/user/code"

monitoring:
  heartbeat_interval: 60  # seconds
  stale_threshold: 300    # seconds
  enable_activity_capture: true
  log_directory: "/var/log/flume"

completion:
  auto_detect: true
  timeout: 14400  # 4 hours
  cleanup_delay: 3600  # 1 hour after completion
```

---

## Technical Architecture

### Component Interaction Diagram

```
┌────────────────┐
│    Obsidian    │
│   QuickAdd     │
└───────┬────────┘
        │ 1. Fire event
        ▼
┌────────────────┐
│   RabbitMQ     │◄──────────┐
│  (Bloodbank)   │           │ 7. Progress events
└───────┬────────┘           │
        │ 2. Consume event   │
        ▼                    │
┌────────────────┐           │
│ Task Session   │           │
│  Manager (Go)  │           │
└───────┬────────┘           │
        │ 3. Spawn wrapper   │
        ▼                    │
┌────────────────┐           │
│  flume-agent   │───────────┘
│   (wrapper)    │
└───────┬────────┘
        │ 4. Inject context
        ▼
┌────────────────┐
│   Agent CLI    │
│ (claude/etc.)  │
└───────┬────────┘
        │ 5. Execute task
        ▼
┌────────────────┐
│  User Code /   │
│  Repository    │
└────────────────┘
```

### Event Flow Sequence

1. **Task Assignment**: User assigns task in Obsidian → `task.lifecycle.assigned` event
2. **Session Creation**: Session Manager consumes event → spawns wrapper in session
3. **Agent Startup**: Wrapper injects context → launches agent CLI
4. **Progress Updates**: Wrapper monitors activity → emits `task.lifecycle.in_progress` every 60s
5. **Completion**: Agent exits or user completes → wrapper emits `task.lifecycle.completed`
6. **Cleanup**: Session Manager waits 1 hour → cleans up session

---

## Implementation Priorities

### Phase 1: Core Shell Integration (Week 1)
- [ ] Implement `flume-agent` wrapper script (Bash/Python)
- [ ] Add wrapper invocation to task-session-manager
- [ ] Basic progress event emission (heartbeat only)
- [ ] Manual completion via `flume-complete` command
- [ ] Configuration file support

### Phase 2: Activity Monitoring (Week 2)
- [ ] Command execution capture
- [ ] File operation tracking
- [ ] Activity log storage
- [ ] Real-time activity streaming to dashboard

### Phase 3: Obsidian Integration (Week 3)
- [ ] Enhanced QuickAdd macros
- [ ] Terminal bridge script
- [ ] Platform-specific terminal launching
- [ ] Progress check from Obsidian

### Phase 4: Advanced Features (Week 4)
- [ ] Session recovery after restart
- [ ] Automatic timeout handling
- [ ] Zombie session cleanup
- [ ] Agent output parsing for intelligent event emission

---

## Non-Functional Requirements

### Performance
- **Session spawn time**: < 3 seconds
- **Event emission latency**: < 100ms
- **Heartbeat overhead**: < 1% CPU usage
- **Memory footprint**: < 50MB per session

### Reliability
- **Event delivery**: At-least-once guarantee via RabbitMQ
- **Session recovery**: 100% recovery after planned restarts
- **Error handling**: Graceful degradation on agent crashes

### Security
- **Secrets**: Never log or emit credentials/tokens
- **File access**: Respect git-ignored files
- **Network**: TLS for RabbitMQ connections
- **Permissions**: Run with user privileges (no root)

### Usability
- **Zero-config**: Works out of box with sensible defaults
- **Discoverable**: `flume --help` provides comprehensive guidance
- **Debuggable**: Verbose logging mode for troubleshooting
- **Cross-platform**: Linux, macOS, Windows (WSL)

---

## Success Criteria

### Functional
- ✅ User assigns task in Obsidian
- ✅ Terminal automatically opens with agent running
- ✅ Agent receives full task context
- ✅ Dashboard shows real-time progress
- ✅ Completion detected automatically
- ✅ Session cleaned up after timeout

### Non-Functional
- ✅ No manual intervention required for happy path
- ✅ 95%+ success rate for session spawning
- ✅ < 5 second end-to-end latency from assignment to agent start
- ✅ All events correctly routed and processed

---

## Assumptions

### Explicit
1. **Terminal Multiplexer Available**: Tmux or Zellij installed
2. **Agent CLIs Installed**: claude, gemini, etc. in PATH
3. **RabbitMQ Running**: Bloodbank exchange configured
4. **Python/Go Runtime**: For wrapper and session manager
5. **Git Repository**: Working directory is a git repo
6. **Single User**: Not designed for multi-tenancy
7. **Trusted Network**: RabbitMQ on localhost or VPN

### Implicit
1. **User is Technical**: Comfortable with CLI and configuration files
2. **Linux/Unix Environment**: Paths and commands assume Unix-like OS
3. **English Language**: UI and logs in English
4. **Task Uniqueness**: Each task_id is globally unique
5. **Agent Cooperation**: Agents follow instructions and complete tasks
6. **No Authentication**: Internal system with no auth requirements
7. **Local Execution**: All components run on same machine initially

---

## Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Agent CLI changes interface | High | Medium | Version pinning, adapter pattern |
| Session multiplexer not available | High | Low | Auto-detect, fallback to plain shell |
| RabbitMQ connection loss | High | Medium | Retry with exponential backoff |
| Zombie sessions accumulate | Medium | High | Automatic cleanup, monitoring alerts |
| Context injection fails | High | Low | Validation, error events |
| Cross-platform incompatibility | Medium | Medium | Platform detection, abstraction layer |

---

## Future Enhancements

### Phase 2 (Beyond MVP)
- **Multi-agent collaboration**: Multiple agents on same task
- **Agent handoff**: Transfer task between agents
- **Session templates**: Pre-configured environments per project
- **Remote execution**: Agents run on remote machines
- **GPU support**: Special handling for ML tasks
- **Resource limits**: CPU/memory caps per session

### Phase 3 (Advanced)
- **Agent learning**: Track successful patterns, suggest improvements
- **Predictive scheduling**: Start sessions before user requests
- **Natural language commands**: Voice-activated task assignment
- **Integration with CI/CD**: Tasks trigger on git events
- **Mobile monitoring**: View sessions from phone
- **Team collaboration**: Multi-user task boards

---

## Appendix A: Example Workflows

### Workflow 1: Standard Task Assignment

**User Actions:**
1. Open Obsidian
2. Edit `TASK.md` with new task
3. Run QuickAdd macro "Assign Task to Agent"
4. Select "Claude Code"
5. Click "Assign"

**System Actions:**
1. QuickAdd fires `task.lifecycle.assigned` event
2. Session Manager consumes event
3. Session Manager spawns `flume-agent` in new Zellij session
4. Wrapper extracts task context, launches `claude @TASK.md`
5. Claude Code starts working on task
6. Wrapper emits heartbeat events every 60s
7. User can attach to session or monitor via dashboard
8. When done, user types "exit" in session
9. Wrapper detects exit, emits `task.lifecycle.completed`
10. Session Manager waits 1 hour, cleans up session

**Total Time:** < 10 seconds from assignment to agent working

---

### Workflow 2: Progress Check

**User Actions:**
1. While agent is working, open Obsidian
2. Run QuickAdd macro "Check Task Progress"

**System Actions:**
1. QuickAdd calls `flume status TASK-001`
2. CLI queries monitoring API
3. Returns current status, progress %, last activity
4. Displays in Obsidian notice

**Total Time:** < 2 seconds

---

### Workflow 3: Manual Completion

**User Actions:**
1. Review agent's work in IDE
2. Run `flume-complete --task-id TASK-001`

**System Actions:**
1. Wrapper emits `task.lifecycle.completed` event
2. Updates TASK.md status
3. Marks session for cleanup
4. Sends notification to dashboard

**Total Time:** < 1 second

---

## Appendix B: Configuration Examples

### Minimal Configuration

```yaml
# ~/.config/flume/config.yaml
rabbitmq:
  url: "amqp://localhost:5672/"

agents:
  claude-code:
    binary: "claude"
```

### Advanced Configuration

```yaml
# ~/.config/flume/config.yaml
rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "task_events"
  vhost: "/"
  heartbeat: 60
  connection_timeout: 30

agents:
  claude-code:
    binary: "claude"
    context_flag: "@"
    args: ["--verbose", "--no-color"]
    env:
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
    supports_markdown: true

  gemini:
    binary: "gemini-cli"
    context_flag: "--task-file"
    args: ["--json-output"]
    supports_markdown: true

session:
  manager: "zellij"
  manager_args: ["--session"]
  session_prefix: "flume-"
  working_dir: "${PWD}"
  attach_on_spawn: false

monitoring:
  heartbeat_interval: 60
  stale_threshold: 300
  timeout: 14400
  enable_activity_capture: true
  enable_command_logging: true
  enable_file_tracking: true
  log_directory: "/var/log/flume/sessions"
  log_rotation: "daily"
  log_retention_days: 30

completion:
  auto_detect: true
  detect_methods: ["exit_code", "task_status", "timeout"]
  cleanup_delay: 3600
  archive_sessions: true
  archive_directory: "~/.flume/archives"

observability:
  prometheus_metrics: true
  metrics_port: 9090
  opentelemetry: false
  log_level: "info"
```

---

## Appendix C: Event Payloads

### task.lifecycle.in_progress

```json
{
  "event_id": "evt_progress_001",
  "event_type": "task.lifecycle.in_progress",
  "timestamp": "2025-10-22T14:30:00Z",
  "version": "1.0.0",
  "correlation_ids": ["evt_assigned_001", "evt_started_001"],
  "source": {
    "component": "flume-agent-wrapper",
    "host_id": "workstation-001",
    "session_id": "sess_abc_123"
  },
  "agent_context": {
    "agent_instance_id": "claude-code-001",
    "task_id": "TASK-001"
  },
  "payload": {
    "progress_percentage": 45,
    "current_activity": "Refactoring database queries",
    "files_modified": ["src/db/queries.go", "src/db/schema.sql"],
    "commands_executed": 12,
    "elapsed_time_seconds": 1800,
    "git_stats": {
      "files_changed": 2,
      "insertions": 56,
      "deletions": 23
    }
  }
}
```

---

## Appendix D: CLI Reference

### flume-agent

```bash
# Start agent with task context
flume-agent --task-id TASK-001 \
            --agent claude-code \
            --working-dir /code/project \
            --task-file /tmp/TASK.md \
            --event-source evt_abc_123

# Options
  --task-id         Task identifier
  --agent           Agent CLI to invoke (claude-code, gemini, etc.)
  --working-dir     Working directory for agent
  --task-file       Path to TASK.md file
  --event-source    Originating event ID
  --heartbeat       Heartbeat interval in seconds (default: 60)
  --timeout         Maximum execution time in seconds (default: 14400)
  --verbose         Enable verbose logging
```

### flume-complete

```bash
# Mark task as completed
flume-complete --task-id TASK-001 \
               --status completed \
               --summary "Implemented authentication module"

# Mark as failed
flume-complete --task-id TASK-002 \
               --status failed \
               --error "API key missing"

# Options
  --task-id    Task identifier
  --status     Completion status (completed, failed, paused)
  --summary    Completion summary
  --error      Error message (for failed status)
  --metadata   Additional JSON metadata
```

### flume-session

```bash
# List active sessions
flume-session list

# Attach to session
flume-session attach TASK-001

# Detach from session
# (Use terminal multiplexer's detach key, typically Ctrl+b d for tmux)

# Cleanup zombie sessions
flume-session cleanup --stale-threshold 24h

# Force kill session
flume-session kill TASK-001

# Options
  list                    List all sessions
  attach <task-id>        Attach to session
  kill <task-id>          Kill session
  cleanup                 Clean up stale sessions
    --stale-threshold     Age threshold (default: 24h)
    --force               Force cleanup without confirmation
```

### flume status

```bash
# Check task status
flume status TASK-001

# Check all active tasks
flume status --all

# Watch status in real-time
flume status TASK-001 --watch

# Options
  <task-id>    Task to check (or --all)
  --all        Show all active tasks
  --watch      Update in real-time
  --json       Output as JSON
```

---

## Appendix E: Error Handling

### Error Categories

1. **Configuration Errors**: Missing or invalid config
2. **Connection Errors**: RabbitMQ unreachable
3. **Agent Errors**: CLI not found or crashes
4. **Session Errors**: Multiplexer unavailable
5. **Event Errors**: Failed to emit event

### Error Response Strategy

```bash
# On configuration error
→ Emit task.lifecycle.failed with config_error
→ Log to stderr with helpful message
→ Exit with code 2

# On connection error
→ Retry 3 times with exponential backoff
→ If all fail, emit failure event
→ Exit with code 3

# On agent crash
→ Capture exit code and logs
→ Emit task.lifecycle.failed with crash_info
→ Clean up session
→ Exit with code 4

# On session error
→ Fall back to plain shell if multiplexer unavailable
→ Log warning
→ Continue with degraded functionality

# On event error
→ Log error locally
→ Queue event for retry
→ Continue execution (non-blocking)
```

---

**End of Requirements Specification**
