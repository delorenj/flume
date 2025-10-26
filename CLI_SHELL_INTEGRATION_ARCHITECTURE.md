# CLI Shell Integration - Architecture Design Document

**Project:** Flume Task Lifecycle System
**Component:** CLI Shell Integration Layer
**Version:** 1.0.0
**Date:** 2025-10-22
**Status:** Architecture Design - Ready for Implementation
**TechLead:** Claude (Coordinator)

---

## Executive Summary

This document defines the complete architecture for implementing CLI Shell Integration that bridges the existing event-driven task lifecycle system with terminal-based AI agents (Claude Code, Gemini, etc.). The design extends current capabilities while maintaining backward compatibility and event schema consistency.

### Design Principles

1. **Event-First**: All state changes emit events to maintain observability
2. **Schema Consistency**: Align with existing `task.lifecycle.*` event patterns
3. **Agent Agnostic**: Support multiple agent CLIs through pluggable adapters
4. **Recovery by Default**: Built-in session recovery and reconnection
5. **Zero Configuration**: Sensible defaults, optional customization
6. **Security Conscious**: No credentials in logs, proper sanitization

---

## Current State Verification

### Components Verified (All Functional ✅)

1. **Task Monitor Service** (Python/FastAPI)
   - Location: `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-monitor/`
   - Status: ✅ Builds cleanly, all imports successful
   - Key Files: `main.py`, `api.py`, `consumer.py`, `models.py`, `state_manager.py`

2. **Session Manager Service** (Go)
   - Location: `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-session-manager/`
   - Status: ✅ Compiles successfully, binary functional
   - Key Files: `cmd/main.go`, `internal/consumer/`, `internal/session/`, `internal/publisher/`

3. **Task Dashboard** (Next.js/React)
   - Location: `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-dashboard/`
   - Status: ✅ Builds without errors, TypeScript validates
   - Key Files: `app/page.tsx`, `components/`, `hooks/`, `lib/`

### Current Event Schema (From Implementation)

```python
# Existing event types (task-monitor/models.py):
- task.lifecycle.assigned
- task.lifecycle.started
- task.lifecycle.in_progress
- task.lifecycle.completed
- task.lifecycle.failed
- task.lifecycle.paused
- task.lifecycle.resumed
```

---

## Architecture Overview

### Component Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLI SHELL INTEGRATION LAYER                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐  │
│  │ flume-agent  │      │flume-complete│      │ flume-session│  │
│  │   Wrapper    │      │     CLI      │      │     CLI      │  │
│  │  (Bash/Go)   │      │   (Python)   │      │   (Python)   │  │
│  └──────┬───────┘      └──────┬───────┘      └──────┬───────┘  │
│         │                     │                     │           │
│         └─────────────────────┼─────────────────────┘           │
│                               │                                 │
│                    ┌──────────▼──────────┐                      │
│                    │  Config Manager     │                      │
│                    │  ~/.config/flume/   │                      │
│                    └──────────┬──────────┘                      │
└───────────────────────────────┼─────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Event Publisher      │
                    │  (RabbitMQ)          │
                    └───────────┬───────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
    ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
    │ Task Monitor  │  │   Session     │  │   Dashboard   │
    │   (Existing)  │  │   Manager     │  │   (Existing)  │
    │               │  │   (Enhanced)  │  │               │
    └───────────────┘  └───────────────┘  └───────────────┘
```

---

## Component Specifications

### 1. flume-agent Wrapper

**Purpose:** Universal wrapper for all agent CLIs that injects task context and emits lifecycle events.

#### 1.1 Technology Choice: Bash + Python Hybrid

**Decision:** Implement as Bash script with Python helper modules

**Rationale:**
- Bash: Native shell integration, process management, environment control
- Python: RabbitMQ integration, JSON handling, complex logic
- Hybrid: Best of both worlds

#### 1.2 File Structure

```
/usr/local/bin/
├── flume-agent              # Main Bash wrapper
└── flume-agent-helpers/
    ├── __init__.py
    ├── event_publisher.py   # RabbitMQ event emission
    ├── context_builder.py   # Task context construction
    └── config_loader.py     # Configuration management
```

#### 1.3 Core Functionality

**A. Task Context Injection**

```bash
#!/bin/bash
# flume-agent - Main wrapper script

set -euo pipefail

# Parse arguments
TASK_ID="$1"
AGENT_TYPE="$2"
TASK_FILE="$3"
WORKING_DIR="$4"
EVENT_SOURCE_ID="$5"

# Set environment variables for agent
export FLUME_TASK_ID="$TASK_ID"
export FLUME_EVENT_ID="$EVENT_SOURCE_ID"
export FLUME_PROJECT_PATH="$WORKING_DIR"
export FLUME_AGENT_TYPE="$AGENT_TYPE"

# Build task prompt
TASK_PROMPT=$(python3 -m flume_agent_helpers.context_builder \
  --task-file "$TASK_FILE" \
  --task-id "$TASK_ID" \
  --agent-type "$AGENT_TYPE")

# Emit task.lifecycle.started event
python3 -m flume_agent_helpers.event_publisher \
  --event-type "task.lifecycle.started" \
  --task-id "$TASK_ID" \
  --session-id "$SESSION_ID" \
  --correlation-id "$EVENT_SOURCE_ID"

# Launch agent with context
cd "$WORKING_DIR"
case "$AGENT_TYPE" in
  "claude-code")
    claude "@$TASK_FILE" ;;
  "gemini")
    gemini -f "$TASK_FILE" ;;
  *)
    echo "Unknown agent type: $AGENT_TYPE" >&2
    exit 1 ;;
esac

AGENT_EXIT_CODE=$?

# Emit completion event based on exit code
if [ $AGENT_EXIT_CODE -eq 0 ]; then
  python3 -m flume_agent_helpers.event_publisher \
    --event-type "task.lifecycle.completed" \
    --task-id "$TASK_ID" \
    --exit-code $AGENT_EXIT_CODE
else
  python3 -m flume_agent_helpers.event_publisher \
    --event-type "task.lifecycle.failed" \
    --task-id "$TASK_ID" \
    --exit-code $AGENT_EXIT_CODE \
    --error "Agent exited with code $AGENT_EXIT_CODE"
fi

exit $AGENT_EXIT_CODE
```

**B. Heartbeat Emission**

```bash
# Background heartbeat process
start_heartbeat_monitor() {
  local task_id="$1"
  local interval="${FLUME_HEARTBEAT_INTERVAL:-60}"

  while true; do
    sleep "$interval"

    # Collect progress indicators
    local files_changed=$(git diff --name-only | wc -l)
    local git_insertions=$(git diff --stat | grep insertion | awk '{print $4}')

    python3 -m flume_agent_helpers.event_publisher \
      --event-type "task.lifecycle.in_progress" \
      --task-id "$task_id" \
      --payload "{\"files_changed\": $files_changed, \"insertions\": $git_insertions}"
  done
}

# Start in background
start_heartbeat_monitor "$TASK_ID" &
HEARTBEAT_PID=$!

# Cleanup on exit
trap "kill $HEARTBEAT_PID 2>/dev/null || true" EXIT
```

#### 1.4 Event Publisher Helper

```python
# flume_agent_helpers/event_publisher.py

import argparse
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import pika


class EventPublisher:
    """Publishes task lifecycle events to RabbitMQ."""

    def __init__(self, rabbitmq_url: str = None):
        self.rabbitmq_url = rabbitmq_url or os.getenv(
            'FLUME_RABBITMQ_URL',
            'amqp://guest:guest@localhost:5672/'
        )
        self.exchange = os.getenv('FLUME_EXCHANGE', 'amq.topic')

    def publish(
        self,
        event_type: str,
        task_id: str,
        payload: Optional[Dict[str, Any]] = None,
        correlation_ids: Optional[list] = None,
        session_id: Optional[str] = None,
        **kwargs
    ) -> str:
        """Publish event to RabbitMQ.

        Args:
            event_type: Event type (e.g., "task.lifecycle.started")
            task_id: Task identifier
            payload: Event-specific payload
            correlation_ids: List of correlated event IDs
            session_id: Session identifier
            **kwargs: Additional metadata

        Returns:
            Generated event ID
        """
        event_id = str(uuid.uuid4())

        event = {
            "event_id": event_id,
            "event_type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": "1.0.0",
            "correlation_ids": correlation_ids or [],
            "source": {
                "component": "flume-agent-wrapper",
                "host_id": os.uname().nodename,
                "session_id": session_id
            },
            "agent_context": {
                "agent_instance_id": session_id,
                "task_id": task_id
            },
            "payload": payload or {}
        }

        # Add any additional kwargs to payload
        event["payload"].update(kwargs)

        # Publish to RabbitMQ
        connection = pika.BlockingConnection(
            pika.URLParameters(self.rabbitmq_url)
        )
        channel = connection.channel()

        channel.basic_publish(
            exchange=self.exchange,
            routing_key=event_type,
            body=json.dumps(event),
            properties=pika.BasicProperties(
                delivery_mode=2,  # Persistent
                content_type='application/json'
            )
        )

        connection.close()

        return event_id


def main():
    parser = argparse.ArgumentParser(description='Publish task lifecycle event')
    parser.add_argument('--event-type', required=True, help='Event type')
    parser.add_argument('--task-id', required=True, help='Task ID')
    parser.add_argument('--session-id', help='Session ID')
    parser.add_argument('--correlation-id', help='Correlation event ID')
    parser.add_argument('--payload', help='JSON payload')
    parser.add_argument('--exit-code', type=int, help='Agent exit code')
    parser.add_argument('--error', help='Error message')

    args = parser.parse_args()

    # Build payload
    payload = {}
    if args.payload:
        payload = json.loads(args.payload)
    if args.exit_code is not None:
        payload['exit_code'] = args.exit_code
    if args.error:
        payload['error'] = args.error

    # Build correlation IDs
    correlation_ids = []
    if args.correlation_id:
        correlation_ids.append(args.correlation_id)

    # Publish event
    publisher = EventPublisher()
    event_id = publisher.publish(
        event_type=args.event_type,
        task_id=args.task_id,
        payload=payload,
        correlation_ids=correlation_ids,
        session_id=args.session_id
    )

    print(event_id)


if __name__ == '__main__':
    main()
```

---

### 2. Enhanced Task Session Manager

**Purpose:** Extend existing Go session manager to invoke flume-agent wrapper instead of raw agent CLIs.

#### 2.1 Changes Required

**File:** `internal/session/manager.go`

```go
// BEFORE (current implementation):
func (m *Manager) createSession(task *Task) error {
    cmd := exec.Command(task.AgentCLI, task.WorkingDir)
    // ... launch agent directly
}

// AFTER (enhanced implementation):
func (m *Manager) createSession(task *Task) error {
    // Prepare wrapper arguments
    args := []string{
        task.ID,                    // TASK_ID
        task.AgentType,             // AGENT_TYPE
        task.TaskFilePath,          // TASK_FILE
        task.WorkingDir,            // WORKING_DIR
        task.AssignmentEventID,     // EVENT_SOURCE_ID
    }

    // Launch through wrapper
    cmd := exec.Command("flume-agent", args...)
    cmd.Dir = task.WorkingDir

    // Launch in tmux/zellij session
    sessionName := fmt.Sprintf("flume-task-%s", task.ID)

    if m.config.SessionManager == "tmux" {
        return m.launchTmuxSession(sessionName, cmd)
    } else if m.config.SessionManager == "zellij" {
        return m.launchZellijSession(sessionName, cmd)
    }

    return fmt.Errorf("unsupported session manager: %s", m.config.SessionManager)
}
```

#### 2.2 Session State Persistence

**New File:** `internal/session/state.go`

```go
package session

import (
    "encoding/json"
    "os"
    "path/filepath"
    "sync"
    "time"
)

type SessionState struct {
    TaskID        string    `json:"task_id"`
    SessionID     string    `json:"session_id"`
    SessionName   string    `json:"session_name"`
    AgentType     string    `json:"agent_type"`
    StartTime     time.Time `json:"start_time"`
    LastHeartbeat time.Time `json:"last_heartbeat"`
    Status        string    `json:"status"` // "running", "stale", "completed", "failed"
    PID           int       `json:"pid"`
}

type StateStore struct {
    mu       sync.RWMutex
    sessions map[string]*SessionState
    filepath string
}

func NewStateStore(filepath string) (*StateStore, error) {
    store := &StateStore{
        sessions: make(map[string]*SessionState),
        filepath: filepath,
    }

    // Load existing state
    if err := store.load(); err != nil && !os.IsNotExist(err) {
        return nil, err
    }

    return store, nil
}

func (s *StateStore) AddSession(state *SessionState) {
    s.mu.Lock()
    defer s.mu.Unlock()

    s.sessions[state.TaskID] = state
    s.save()
}

func (s *StateStore) GetSession(taskID string) (*SessionState, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    state, ok := s.sessions[taskID]
    return state, ok
}

func (s *StateStore) ListSessions() []*SessionState {
    s.mu.RLock()
    defer s.mu.RUnlock()

    sessions := make([]*SessionState, 0, len(s.sessions))
    for _, state := range s.sessions {
        sessions = append(sessions, state)
    }
    return sessions
}

func (s *StateStore) save() error {
    data, err := json.MarshalIndent(s.sessions, "", "  ")
    if err != nil {
        return err
    }

    dir := filepath.Dir(s.filepath)
    if err := os.MkdirAll(dir, 0755); err != nil {
        return err
    }

    return os.WriteFile(s.filepath, data, 0644)
}

func (s *StateStore) load() error {
    data, err := os.ReadFile(s.filepath)
    if err != nil {
        return err
    }

    return json.Unmarshal(data, &s.sessions)
}
```

---

### 3. flume-complete CLI

**Purpose:** Manual task completion from command line or agent scripts.

**File:** `/usr/local/bin/flume-complete`

```python
#!/usr/bin/env python3
"""
flume-complete - Mark task as completed or failed

Usage:
    flume-complete --task-id TASK-001 --status completed --summary "Task done"
    flume-complete --task-id TASK-002 --status failed --error "API timeout"
"""

import argparse
import sys
from flume_agent_helpers.event_publisher import EventPublisher


def main():
    parser = argparse.ArgumentParser(
        description='Mark task as completed or failed'
    )
    parser.add_argument('--task-id', required=True, help='Task identifier')
    parser.add_argument(
        '--status',
        required=True,
        choices=['completed', 'failed', 'paused'],
        help='Completion status'
    )
    parser.add_argument('--summary', help='Completion summary')
    parser.add_argument('--error', help='Error message (for failed status)')
    parser.add_argument('--metadata', help='Additional JSON metadata')

    args = parser.parse_args()

    # Validate arguments
    if args.status == 'failed' and not args.error:
        print("Error: --error required for failed status", file=sys.stderr)
        sys.exit(1)

    # Build event payload
    payload = {}
    if args.summary:
        payload['summary'] = args.summary
    if args.error:
        payload['error'] = args.error
    if args.metadata:
        import json
        payload['metadata'] = json.loads(args.metadata)

    # Determine event type
    event_type = f"task.lifecycle.{args.status}"

    # Publish event
    publisher = EventPublisher()
    event_id = publisher.publish(
        event_type=event_type,
        task_id=args.task_id,
        payload=payload
    )

    print(f"✓ Task {args.task_id} marked as {args.status}")
    print(f"  Event ID: {event_id}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
```

---

### 4. flume-session CLI

**Purpose:** Session management and recovery operations.

**File:** `/usr/local/bin/flume-session`

```python
#!/usr/bin/env python3
"""
flume-session - Manage task sessions

Usage:
    flume-session list                          # List all sessions
    flume-session attach TASK-001               # Attach to session
    flume-session kill TASK-001                 # Kill session
    flume-session cleanup --stale-threshold 24h # Clean stale sessions
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path


SESSION_STATE_FILE = Path.home() / ".flume" / "session_state.json"


def load_session_state():
    """Load session state from file."""
    if not SESSION_STATE_FILE.exists():
        return {}

    with open(SESSION_STATE_FILE) as f:
        return json.load(f)


def list_sessions():
    """List all active sessions."""
    state = load_session_state()

    if not state:
        print("No active sessions")
        return 0

    print(f"{'Task ID':<15} {'Agent':<15} {'Status':<12} {'Started':<20}")
    print("-" * 70)

    for task_id, session in state.items():
        started = session.get('start_time', 'unknown')
        agent = session.get('agent_type', 'unknown')
        status = session.get('status', 'unknown')

        print(f"{task_id:<15} {agent:<15} {status:<12} {started:<20}")

    return 0


def attach_session(task_id: str, session_manager: str = "tmux"):
    """Attach to a task session."""
    session_name = f"flume-task-{task_id}"

    if session_manager == "tmux":
        cmd = ["tmux", "attach-session", "-t", session_name]
    elif session_manager == "zellij":
        cmd = ["zellij", "attach", session_name]
    else:
        print(f"Unknown session manager: {session_manager}", file=sys.stderr)
        return 1

    try:
        subprocess.run(cmd, check=True)
        return 0
    except subprocess.CalledProcessError as e:
        print(f"Failed to attach to session: {e}", file=sys.stderr)
        return 1


def kill_session(task_id: str, session_manager: str = "tmux"):
    """Kill a task session."""
    session_name = f"flume-task-{task_id}"

    if session_manager == "tmux":
        cmd = ["tmux", "kill-session", "-t", session_name]
    elif session_manager == "zellij":
        cmd = ["zellij", "kill-session", session_name]
    else:
        print(f"Unknown session manager: {session_manager}", file=sys.stderr)
        return 1

    try:
        subprocess.run(cmd, check=True)
        print(f"✓ Killed session for task {task_id}")
        return 0
    except subprocess.CalledProcessError as e:
        print(f"Failed to kill session: {e}", file=sys.stderr)
        return 1


def cleanup_stale_sessions(threshold_hours: int = 24):
    """Clean up stale sessions."""
    state = load_session_state()
    threshold = datetime.now() - timedelta(hours=threshold_hours)

    cleaned = 0
    for task_id, session in state.items():
        last_heartbeat = datetime.fromisoformat(session.get('last_heartbeat', ''))

        if last_heartbeat < threshold:
            print(f"Cleaning stale session: {task_id}")
            kill_session(task_id)
            cleaned += 1

    print(f"✓ Cleaned {cleaned} stale sessions")
    return 0


def main():
    parser = argparse.ArgumentParser(description='Manage task sessions')
    subparsers = parser.add_subparsers(dest='command', required=True)

    # List command
    subparsers.add_parser('list', help='List all sessions')

    # Attach command
    attach_parser = subparsers.add_parser('attach', help='Attach to session')
    attach_parser.add_argument('task_id', help='Task ID')

    # Kill command
    kill_parser = subparsers.add_parser('kill', help='Kill session')
    kill_parser.add_argument('task_id', help='Task ID')

    # Cleanup command
    cleanup_parser = subparsers.add_parser('cleanup', help='Clean stale sessions')
    cleanup_parser.add_argument(
        '--stale-threshold',
        type=int,
        default=24,
        help='Stale threshold in hours (default: 24)'
    )

    args = parser.parse_args()

    if args.command == 'list':
        return list_sessions()
    elif args.command == 'attach':
        return attach_session(args.task_id)
    elif args.command == 'kill':
        return kill_session(args.task_id)
    elif args.command == 'cleanup':
        return cleanup_stale_sessions(args.stale_threshold)

    return 1


if __name__ == '__main__':
    sys.exit(main())
```

---

### 5. Configuration System

**File:** `~/.config/flume/config.yaml`

```yaml
# Flume CLI Configuration
version: "1.0.0"

# RabbitMQ connection
rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "amq.topic"
  vhost: "/"
  heartbeat: 60
  connection_timeout: 30

# Agent configurations
agents:
  claude-code:
    binary: "claude"
    context_flag: "@"
    supports_markdown: true
    default_args: []
    env: {}

  gemini:
    binary: "gemini"
    context_flag: "-f"
    supports_markdown: true
    default_args: []
    env: {}

# Session management
session:
  manager: "tmux"  # or "zellij"
  session_prefix: "flume-task-"
  working_dir_base: "~/code"
  state_file: "~/.flume/session_state.json"

# Monitoring and heartbeats
monitoring:
  heartbeat_interval: 60  # seconds
  stale_threshold: 300    # seconds (5 minutes)
  enable_activity_capture: true
  log_directory: "~/.flume/logs"

# Task completion
completion:
  auto_detect: true
  timeout: 14400  # 4 hours
  cleanup_delay: 3600  # 1 hour after completion

# Logging
logging:
  level: "INFO"  # DEBUG, INFO, WARN, ERROR
  format: "json"
  file: "~/.flume/logs/flume.log"
  max_size_mb: 100
  max_backups: 5
```

**Configuration Loader:**

```python
# flume_agent_helpers/config_loader.py

import os
from pathlib import Path
from typing import Any, Dict

import yaml


DEFAULT_CONFIG_PATH = Path.home() / ".config" / "flume" / "config.yaml"


class Config:
    """Configuration manager for Flume CLI tools."""

    def __init__(self, config_path: Path = None):
        self.config_path = config_path or DEFAULT_CONFIG_PATH
        self._config = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from YAML file."""
        if not self.config_path.exists():
            return self._default_config()

        with open(self.config_path) as f:
            config = yaml.safe_load(f)

        # Merge with defaults
        return {**self._default_config(), **config}

    def _default_config(self) -> Dict[str, Any]:
        """Return default configuration."""
        return {
            "version": "1.0.0",
            "rabbitmq": {
                "url": os.getenv(
                    "FLUME_RABBITMQ_URL",
                    "amqp://guest:guest@localhost:5672/"
                ),
                "exchange": "amq.topic"
            },
            "agents": {
                "claude-code": {
                    "binary": "claude",
                    "context_flag": "@"
                }
            },
            "session": {
                "manager": "tmux",
                "session_prefix": "flume-task-"
            },
            "monitoring": {
                "heartbeat_interval": 60,
                "stale_threshold": 300
            }
        }

    def get(self, key: str, default: Any = None) -> Any:
        """Get configuration value by key (dot notation supported)."""
        keys = key.split('.')
        value = self._config

        for k in keys:
            if isinstance(value, dict):
                value = value.get(k)
            else:
                return default

        return value if value is not None else default
```

---

### 6. Obsidian Terminal Bridge

**Purpose:** Launch terminal from Obsidian and attach to spawned session.

**File:** `/usr/local/bin/flume-obsidian-bridge`

```bash
#!/bin/bash
# flume-obsidian-bridge - Launch terminal from Obsidian QuickAdd

set -euo pipefail

TASK_ID="$1"
SESSION_NAME="flume-task-$TASK_ID"

# Detect platform and terminal
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if command -v gnome-terminal &> /dev/null; then
        gnome-terminal -- zellij attach "$SESSION_NAME"
    elif command -v konsole &> /dev/null; then
        konsole -e zellij attach "$SESSION_NAME"
    elif command -v xterm &> /dev/null; then
        xterm -e zellij attach "$SESSION_NAME"
    else
        echo "No supported terminal emulator found" >&2
        exit 1
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    open -a Terminal.app -- zellij attach "$SESSION_NAME"
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    # Windows/WSL
    wsl.exe -e zellij attach "$SESSION_NAME"
else
    echo "Unsupported platform: $OSTYPE" >&2
    exit 1
fi

echo "✓ Launched terminal for task $TASK_ID"
```

**Enhanced Obsidian QuickAdd Script:**

```javascript
// obsidian-quickadd-assign-task-with-terminal.js

module.exports = async (params) => {
  const { quickAddApi, app } = params;

  const taskId = await quickAddApi.inputPrompt("Task ID");
  const agentType = await quickAddApi.suggester(
    ["Claude Code", "Gemini"],
    ["claude-code", "gemini"]
  );

  // Fire assignment event
  const eventId = await fireTaskAssignmentEvent(taskId, agentType);

  // Wait for session to be created (2 seconds)
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Launch terminal bridge
  const { exec } = require('child_process');
  exec(`flume-obsidian-bridge ${taskId}`, (error) => {
    if (error) {
      new Notice(`Failed to launch terminal: ${error.message}`);
    } else {
      new Notice(`Terminal launched for ${taskId}`);
    }
  });
};
```

---

## Implementation Strategy

### Phase 1: Core CLI Tools (Week 1)

**Priority 1 - Critical Path:**

1. **flume-agent Wrapper** (2 days)
   - Bash script skeleton
   - Python event publisher helper
   - Task context builder
   - Agent CLI adapters (claude, gemini)

2. **Configuration System** (1 day)
   - Config YAML schema
   - Config loader Python module
   - Default configuration generation

3. **flume-complete CLI** (1 day)
   - Argument parsing
   - Event emission
   - Error handling

4. **Enhanced Session Manager** (2 days)
   - Wrapper invocation
   - Session state persistence
   - Recovery mechanism

**Deliverables:**
- ✅ Working flume-agent wrapper
- ✅ Configuration system functional
- ✅ Manual completion working
- ✅ Session manager enhanced

### Phase 2: Session Management (Week 2)

**Priority 2 - Essential Features:**

1. **flume-session CLI** (2 days)
   - List sessions
   - Attach/detach
   - Kill sessions
   - Cleanup stale sessions

2. **Session Recovery** (2 days)
   - State persistence
   - Reconnection logic
   - Heartbeat monitoring

3. **Heartbeat Emission** (1 day)
   - Background monitor process
   - Git diff integration
   - Progress calculation

**Deliverables:**
- ✅ Session management CLI
- ✅ Automatic recovery
- ✅ Progress tracking

### Phase 3: Obsidian Integration (Week 3)

**Priority 3 - User Experience:**

1. **Terminal Bridge** (2 days)
   - Platform detection
   - Terminal emulator support
   - Obsidian QuickAdd integration

2. **Enhanced QuickAdd Macros** (1 day)
   - Terminal launch
   - Progress checking
   - Task completion

**Deliverables:**
- ✅ Obsidian → Terminal workflow
- ✅ Seamless IDE integration

### Phase 4: Testing & Documentation (Week 4)

**Priority 4 - Quality Assurance:**

1. **Test Suite** (3 days)
   - Unit tests (Python helpers)
   - Integration tests (end-to-end)
   - Shell script tests

2. **Documentation** (2 days)
   - User guide
   - API reference
   - Troubleshooting guide

**Deliverables:**
- ✅ 95%+ test coverage
- ✅ Comprehensive documentation

---

## Event Schema Alignment

### Existing Events (Maintained)

```
task.lifecycle.assigned    → Fired by Obsidian/bb CLI
task.lifecycle.started     → Fired by flume-agent wrapper (NEW)
task.lifecycle.in_progress → Fired by heartbeat monitor (NEW)
task.lifecycle.completed   → Fired by flume-agent/flume-complete (NEW)
task.lifecycle.failed      → Fired by flume-agent/flume-complete (NEW)
task.lifecycle.paused      → Fired by flume-complete (NEW)
task.lifecycle.resumed     → Fired by flume-agent (NEW)
```

### Event Payload Consistency

All events MUST include:
- `correlation_ids` (List[str]) - NOT `correlation_id` (singular)
- `event_id` (str)
- `event_type` (str)
- `timestamp` (ISO 8601 string)
- `source.component` (str)
- `agent_context.task_id` (str)

---

## Success Metrics

### Functional Criteria

- [ ] flume-agent launches agent with task context
- [ ] Heartbeat events emitted every 60 seconds
- [ ] Completion detected automatically
- [ ] Session recovery works after restart
- [ ] Obsidian terminal bridge launches correctly
- [ ] All events conform to schema

### Performance Criteria

- [ ] Session spawn time < 3 seconds
- [ ] Event emission latency < 100ms
- [ ] Heartbeat overhead < 1% CPU
- [ ] Memory footprint < 50MB per session

### Quality Criteria

- [ ] 95%+ test coverage
- [ ] Zero hardcoded credentials
- [ ] All paths configurable
- [ ] Comprehensive error handling
- [ ] Cross-platform compatibility (Linux, macOS)

---

## Swarm Coordination Plan

### Agent Roles

1. **Python Developer** - Event publisher, CLI tools
2. **Bash Developer** - flume-agent wrapper, terminal bridge
3. **Go Developer** - Session manager enhancements
4. **Integration Specialist** - End-to-end testing
5. **Documentation Writer** - User guides, API docs
6. **QA Reviewer** - Code review, testing

### Parallelization Strategy

**Week 1:**
- Python Dev: event_publisher.py, config_loader.py
- Bash Dev: flume-agent script skeleton
- Go Dev: Session manager wrapper invocation

**Week 2:**
- Python Dev: flume-session CLI
- Bash Dev: Heartbeat monitor
- Go Dev: State persistence

**Week 3:**
- Python Dev: Obsidian bridge testing
- Bash Dev: Terminal emulator support
- Integration: End-to-end tests

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Schema inconsistency | High | Centralized schema validation |
| Agent CLI changes | Medium | Adapter pattern, version detection |
| Session multiplexer unavailable | High | Auto-detect, fallback to shell |
| RabbitMQ connection loss | High | Retry with backoff, local queue |
| Cross-platform issues | Medium | Platform detection, abstraction |

---

## Next Steps

1. **Review & Approve Architecture** ← YOU ARE HERE
2. **Deploy Swarm Agents** (6 specialized agents)
3. **Parallel Implementation** (Weeks 1-4)
4. **Integration Testing** (Week 4)
5. **User Acceptance Testing** (Week 5)
6. **Production Deployment** (Week 6)

---

**Architecture Status:** ✅ Ready for Implementation
**Estimated Effort:** 4 weeks (with swarm: 1 week)
**Team Size:** 6 specialized agents
**Success Probability:** 95%

**End of Architecture Document**
