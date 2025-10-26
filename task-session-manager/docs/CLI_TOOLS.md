# Flume CLI Tools Documentation

This document provides comprehensive documentation for the Flume CLI tools that enable interaction with the task lifecycle system.

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [CLI Tools](#cli-tools)
   - [flume-complete](#flume-complete)
   - [flume-session](#flume-session)
   - [flume (status)](#flume-status)
5. [Usage Examples](#usage-examples)
6. [Exit Codes](#exit-codes)
7. [Troubleshooting](#troubleshooting)

## Overview

The Flume CLI tools provide command-line interfaces for:

- **Task Completion**: Mark tasks as completed, failed, or paused with event emission
- **Session Management**: List, attach to, kill, and cleanup task execution sessions
- **Status Monitoring**: Check task status and progress in real-time

All tools integrate with the Flume task lifecycle system, emitting events to RabbitMQ and querying the Task Monitor API.

## Installation

### Building from Source

```bash
# Build all CLI tools
cd task-session-manager
make build-cli

# Install to /usr/local/bin
sudo make install-all
```

### Manual Installation

```bash
# Build individual tools
go build -o flume-complete ./cmd/flume-complete
go build -o flume-session ./cmd/flume-session
go build -o flume ./cmd/flume

# Install
sudo cp flume-complete flume-session flume /usr/local/bin/
```

### Verify Installation

```bash
flume-complete --version
flume-session --version
flume --version
```

## Configuration

### Configuration File

Create `~/.config/flume/config.yaml`:

```yaml
# RabbitMQ connection settings
rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "task.lifecycle"

# Task Monitor API settings
monitoring:
  api_url: "http://localhost:8000"
  timeout: 30s
  retry_attempts: 3
  retry_delay: 2s
  websocket_url: "ws://localhost:8000/ws"
  connect_timeout: 10s

# Session management settings
session:
  manager: "zellij"  # or "tmux"
  session_prefix: "task-"
  stale_threshold: 24h
  cleanup_interval: 1h
```

### Environment Variables

Override configuration with environment variables:

```bash
export RABBITMQ_URL="amqp://user:pass@host:5672/"
export RABBITMQ_EXCHANGE="custom.exchange"
export FLUME_API_URL="http://localhost:9000"
export FLUME_WS_URL="ws://localhost:9000/ws"
export FLUME_SESSION_MANAGER="tmux"
export FLUME_CONFIG_PATH="/custom/path/config.yaml"
```

### Configuration Priority

1. Environment variables (highest priority)
2. Configuration file
3. Default values (lowest priority)

## CLI Tools

### flume-complete

Mark tasks as completed, failed, or paused. Emits lifecycle events and updates TASK.md.

#### Usage

```bash
flume-complete --task-id TASK-001 --status completed --summary "Task done"
```

#### Options

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `--task-id` | Task identifier | Yes | - |
| `--status` | Status: completed, failed, paused | No | completed |
| `--summary` | Completion summary or reason | No | "" |
| `--error` | Error message (for failed status) | No | "" |
| `--metadata` | Additional JSON metadata | No | {} |
| `-v, --verbose` | Enable verbose output | No | false |
| `-h, --help` | Show help message | No | - |
| `--version` | Show version | No | - |

#### Examples

```bash
# Mark task as completed
flume-complete --task-id TASK-001 --status completed \
  --summary "Implemented authentication module"

# Mark task as failed with error details
flume-complete --task-id TASK-002 --status failed \
  --error "API key missing from environment" \
  --summary "Configuration error"

# Mark task as paused
flume-complete --task-id TASK-003 --status paused \
  --summary "Waiting for code review"

# Include custom metadata
flume-complete --task-id TASK-004 --status completed \
  --metadata '{"files_changed": 5, "tests_added": 12, "coverage": 95}'

# Verbose output
flume-complete --task-id TASK-005 --status completed \
  --summary "Database migration" --verbose
```

#### Event Emission

The tool emits the following events to RabbitMQ:

- `task.lifecycle.completed` - When status is "completed"
- `task.lifecycle.failed` - When status is "failed"
- `task.lifecycle.paused` - When status is "paused"

#### TASK.md Updates

If a `TASK.md` file exists in the current directory, the tool will:

1. Update the `status:` field in frontmatter
2. Add status line if it doesn't exist

### flume-session

Manage task execution sessions (tmux/zellij).

#### Usage

```bash
flume-session <subcommand> [options]
```

#### Subcommands

| Subcommand | Aliases | Description |
|------------|---------|-------------|
| `list` | `ls` | List all active sessions |
| `attach` | `a` | Attach to a session |
| `kill` | `k` | Kill a session forcefully |
| `cleanup` | - | Clean up stale sessions |
| `help` | - | Show help message |
| `version` | - | Show version |

#### Examples

```bash
# List all active sessions
flume-session list

# Output:
# SESSION              TASK-ID         MANAGER    WINDOWS  STALE      CREATED
# -------------------------------------------------------------------------------------
# task-TASK-001        TASK-001        zellij     1        no         2025-10-22
# task-TASK-002        TASK-002        zellij     1        no         2025-10-22
#
# Total sessions: 2

# Attach to a session
flume-session attach TASK-001
# (You are now in the session. Use Ctrl+b d for tmux or Ctrl+g d for zellij to detach)

# Kill a session
flume-session kill TASK-002

# Cleanup stale sessions (default: 24h threshold)
flume-session cleanup

# Cleanup with custom threshold
flume-session cleanup --stale-threshold 48h

# Cleanup without confirmation
flume-session cleanup --force
```

#### Cleanup Options

| Option | Description | Default |
|--------|-------------|---------|
| `--stale-threshold` | Age threshold (e.g., 24h, 7d) | 24h |
| `--force` | Skip confirmation prompt | false |

### flume (status)

Check task status and progress from the Task Monitor API.

#### Usage

```bash
flume status [task-id] [options]
flume <task-id>  # Shorthand
```

#### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--all` | Show all active tasks | false |
| `--status` | Filter by status | - |
| `--watch` | Real-time updates (every 2s) | false |
| `--json` | Output as JSON | false |
| `-h, --help` | Show help message | - |
| `--version` | Show version | - |

#### Status Filters

- `assigned` - Tasks assigned but not started
- `started` - Tasks with sessions created
- `in_progress` - Tasks actively being worked on
- `completed` - Successfully completed tasks
- `failed` - Failed tasks
- `paused` - Paused tasks

#### Examples

```bash
# Check status of specific task
flume status TASK-001

# Output:
# Task: TASK-001
# Status: in_progress
# Agent: claude-code
# Progress: [████████████░░░░░░░░░░░░░░░░░░] 40%
# Current Activity: Refactoring database queries
#
# Details:
#   Working Directory: /home/user/project
#   Priority: high
#   Created: 2025-10-22 14:30:00
#   Updated: 2025-10-22 15:45:00
#   Elapsed: 1h 15m
#   Files Modified: 3
#     - src/db/queries.go
#     - src/db/schema.sql
#     - tests/db_test.go
#   Commands Executed: 12

# Shorthand syntax
flume TASK-001

# Show all active tasks
flume status --all

# Filter by status
flume status --all --status in_progress

# Watch in real-time
flume status TASK-001 --watch

# JSON output
flume status TASK-001 --json

# Watch all tasks
flume status --all --watch
```

#### JSON Output Format

```json
{
  "task_id": "TASK-001",
  "status": "in_progress",
  "agent_type": "claude-code",
  "working_dir": "/home/user/project",
  "priority": "high",
  "progress_percentage": 40,
  "current_activity": "Refactoring database queries",
  "files_modified": ["src/db/queries.go", "src/db/schema.sql"],
  "commands_executed": 12,
  "created_at": "2025-10-22T14:30:00Z",
  "updated_at": "2025-10-22T15:45:00Z",
  "duration_seconds": 4500,
  "metadata": {}
}
```

## Usage Examples

### Complete Workflow

```bash
# 1. Check task status
flume status TASK-001

# 2. Attach to task session to see what's happening
flume-session attach TASK-001

# 3. Detach from session (Ctrl+b d for tmux, Ctrl+g d for zellij)

# 4. Watch progress in real-time
flume status TASK-001 --watch

# 5. When done, mark as completed
flume-complete --task-id TASK-001 --status completed \
  --summary "Successfully implemented feature X"
```

### Monitor All Tasks

```bash
# See all active tasks
flume status --all

# Watch all in-progress tasks
flume status --all --status in_progress --watch

# Check for failed tasks
flume status --all --status failed
```

### Session Management

```bash
# List all sessions
flume-session list

# Kill stuck session
flume-session kill TASK-999

# Clean up old sessions
flume-session cleanup --stale-threshold 48h --force
```

### Scripting Example

```bash
#!/bin/bash
# Check if task completed, if not retry

TASK_ID="TASK-001"
MAX_RETRIES=3
RETRY_DELAY=60

for i in $(seq 1 $MAX_RETRIES); do
  STATUS=$(flume status $TASK_ID --json | jq -r '.status')

  if [ "$STATUS" = "completed" ]; then
    echo "Task $TASK_ID completed successfully"
    exit 0
  elif [ "$STATUS" = "failed" ]; then
    echo "Task $TASK_ID failed"
    exit 1
  fi

  echo "Attempt $i: Task still $STATUS, waiting..."
  sleep $RETRY_DELAY
done

echo "Task $TASK_ID did not complete in time"
exit 2
```

## Exit Codes

### flume-complete

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | Usage error (invalid arguments) |
| 2 | Configuration error |
| 3 | Connection error (cannot reach RabbitMQ) |
| 4 | Publish error |

### flume-session

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | Usage error |
| 2 | Configuration error |
| 4 | Session error |
| 5 | Session not found |

### flume (status)

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | Usage error |
| 2 | Configuration error |
| 3 | Connection error (cannot reach monitoring API) |
| 5 | Task not found |

## Troubleshooting

### Configuration Issues

**Problem**: "Error loading configuration"

**Solution**: Create config file or use environment variables:

```bash
# Quick test with env vars
export RABBITMQ_URL="amqp://localhost:5672/"
export FLUME_API_URL="http://localhost:8000"
flume-complete --task-id TEST-001 --status completed
```

### Connection Issues

**Problem**: "failed to connect to RabbitMQ"

**Solution**: Verify RabbitMQ is running:

```bash
# Check RabbitMQ status
systemctl status rabbitmq-server

# Test connection
curl http://localhost:15672/api/overview
```

**Problem**: "failed to fetch task status"

**Solution**: Verify Task Monitor API is running:

```bash
# Check API
curl http://localhost:8000/health

# Check logs
docker logs task-monitor
```

### Session Issues

**Problem**: "no session manager (tmux or zellij) available"

**Solution**: Install a session manager:

```bash
# Install zellij
cargo install zellij

# Or install tmux
sudo apt install tmux  # Debian/Ubuntu
brew install tmux      # macOS
```

**Problem**: "session not found"

**Solution**: List available sessions:

```bash
# List all sessions
flume-session list

# Check session manager directly
zellij list-sessions
# or
tmux list-sessions
```

### Verbose Mode

Enable verbose output for debugging:

```bash
flume-complete --task-id TEST-001 --status completed --verbose

# Output:
# Using RabbitMQ: amqp://guest:guest@localhost:5672/
# Exchange: task.lifecycle
# Published event: task.lifecycle.completed
# Correlation ID: 550e8400-e29b-41d4-a716-446655440000
# Task TEST-001 marked as completed
```

### Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| "task-id is required" | Missing --task-id flag | Add --task-id TASK-XXX |
| "invalid status" | Wrong status value | Use: completed, failed, or paused |
| "invalid JSON metadata" | Malformed JSON | Check JSON syntax |
| "TASK.md not found" | No TASK.md in directory | Run from project root |
| "failed to declare exchange" | RabbitMQ permissions | Check user permissions |
| "invalid manager" | Wrong session manager | Use 'zellij' or 'tmux' |

## Advanced Configuration

### Custom Exchange and Routing

```yaml
rabbitmq:
  url: "amqp://user:pass@rabbitmq.example.com:5672/vhost"
  exchange: "custom.tasks"
```

### API Authentication

If your Task Monitor API requires authentication:

```bash
# Add authentication to API requests (future feature)
# Currently, the tools assume no authentication
```

### Multiple Environments

```bash
# Development
export FLUME_CONFIG_PATH=~/.config/flume/dev.yaml

# Production
export FLUME_CONFIG_PATH=~/.config/flume/prod.yaml
```

## Integration with Obsidian

Use CLI tools from Obsidian QuickAdd macros:

```javascript
// Mark task complete from Obsidian
const taskId = tp.file.title;
const cmd = `flume-complete --task-id ${taskId} --status completed --summary "Done from Obsidian"`;
await tp.user.shell_command(cmd);
```

## Future Enhancements

- WebSocket-based real-time updates for `flume status --watch`
- Interactive TUI mode for session management
- Batch operations (complete multiple tasks)
- Task dependencies and blocking
- Notification integration (desktop, email, Slack)
- Task templates and presets
- Performance metrics and analytics

## Support

For issues, feature requests, or contributions:

- GitHub Issues: [flume/issues](https://github.com/33GOD/flume/issues)
- Documentation: [flume/docs](https://github.com/33GOD/flume/docs)
- Discord: [flume community](https://discord.gg/flume)

## License

MIT License - See LICENSE file for details
