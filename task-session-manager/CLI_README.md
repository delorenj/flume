# Flume CLI Tools

User-facing CLI utilities for the Flume task lifecycle system.

## Quick Start

### Build & Install

```bash
# Build all CLI tools
make build-cli

# Install to /usr/local/bin
sudo make install-all

# Verify installation
flume-complete --version
flume-session --version
flume --version
```

### Basic Usage

```bash
# Mark task as completed
flume-complete --task-id TASK-001 --status completed --summary "Done!"

# List active sessions
flume-session list

# Check task status
flume status TASK-001
```

## Available Tools

### 1. flume-complete

Mark tasks as completed, failed, or paused with automatic event emission.

**Key Features:**
- Emits `task.lifecycle.completed`, `task.lifecycle.failed`, or `task.lifecycle.paused` events
- Updates TASK.md status automatically
- Supports custom metadata
- Proper error codes for scripting

**Usage:**
```bash
flume-complete --task-id TASK-001 --status completed --summary "Implemented auth"
flume-complete --task-id TASK-002 --status failed --error "API error"
flume-complete --task-id TASK-003 --status paused --summary "Waiting"
```

### 2. flume-session

Manage terminal sessions (tmux/zellij) for tasks.

**Key Features:**
- List all active sessions with status
- Attach to existing sessions
- Kill sessions forcefully
- Cleanup stale sessions (configurable threshold)

**Usage:**
```bash
flume-session list                          # List all sessions
flume-session attach TASK-001               # Attach to session
flume-session kill TASK-002                 # Kill session
flume-session cleanup --stale-threshold 24h # Cleanup old sessions
```

### 3. flume (status command)

Query task status from the monitoring API.

**Key Features:**
- Display progress percentage and current activity
- Show files modified and commands executed
- Real-time watch mode
- JSON output for scripting
- Filter by status

**Usage:**
```bash
flume status TASK-001                # Check specific task
flume TASK-001                       # Shorthand
flume status --all                   # Show all tasks
flume status TASK-001 --watch        # Real-time updates
flume status --all --status in_progress --json
```

## Configuration

Create `~/.config/flume/config.yaml`:

```yaml
rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "task.lifecycle"

monitoring:
  api_url: "http://localhost:8000"
  timeout: 30s

session:
  manager: "zellij"  # or "tmux"
  session_prefix: "task-"
  stale_threshold: 24h
```

Or use environment variables:

```bash
export RABBITMQ_URL="amqp://localhost:5672/"
export FLUME_API_URL="http://localhost:8000"
export FLUME_SESSION_MANAGER="zellij"
```

## Exit Codes

All tools use standardized exit codes:

- `0` - Success
- `1` - Usage error (invalid arguments)
- `2` - Configuration error
- `3` - Connection error
- `4` - Operation error (publish, session, etc.)
- `5` - Not found error

## Integration

### RabbitMQ Event Emission

`flume-complete` publishes events to RabbitMQ topic exchange with routing keys:
- `task.lifecycle.completed`
- `task.lifecycle.failed`
- `task.lifecycle.paused`

### Monitoring API Integration

`flume status` queries the FastAPI Task Monitor service:
- `GET /tasks/{task_id}` - Get specific task
- `GET /tasks?status=<status>` - Filter tasks

### Session Manager Integration

`flume-session` interacts with tmux/zellij:
- Works with existing sessions created by task-session-manager
- Uses configured session prefix to identify task sessions

## Testing

```bash
# Run unit tests
go test ./pkg/cliconfig/...

# Run with coverage
go test -coverprofile=coverage.out ./pkg/cliconfig/...
go tool cover -html=coverage.out

# Current coverage: 82.8%
```

## Troubleshooting

### "failed to connect to RabbitMQ"

```bash
# Check RabbitMQ is running
systemctl status rabbitmq-server

# Test connectivity
curl http://localhost:15672/api/overview
```

### "failed to fetch task status"

```bash
# Check Task Monitor API
curl http://localhost:8000/health

# Verify API URL in config
cat ~/.config/flume/config.yaml
```

### "no session manager available"

```bash
# Install zellij
cargo install zellij

# Or install tmux
sudo apt install tmux
```

## Documentation

- [CLI Tools Documentation](docs/CLI_TOOLS.md) - Comprehensive usage guide
- [Configuration Guide](config.example.yaml) - Example configuration
- [Shell Integration Requirements](../CLI_SHELL_INTEGRATION_REQUIREMENTS.md) - System design

## Architecture

```
┌─────────────────┐         ┌──────────────┐         ┌────────────────┐
│ flume-complete  │────────>│   RabbitMQ   │────────>│ Task Monitor   │
└─────────────────┘   emit  │  (Bloodbank) │  consume│  (FastAPI)     │
                             └──────────────┘         └────────────────┘
                                     ^                        │
                                     │                        │ query
┌─────────────────┐                 │                 ┌──────▼──────┐
│ flume-session   │──────────────── ┘                 │    flume    │
└─────────────────┘   monitor                         │  (status)   │
        │                                              └─────────────┘
        │ manage
        ▼
┌─────────────────┐
│  tmux/zellij    │
│   sessions      │
└─────────────────┘
```

## Development

### Building

```bash
# Build all CLI tools
make build-cli

# Build specific tool
go build -o bin/flume-complete ./cmd/flume-complete
```

### Adding New Features

1. Add CLI flags and argument parsing
2. Update configuration schema if needed
3. Implement core functionality
4. Add unit tests (target: 80%+ coverage)
5. Update documentation
6. Test with actual RabbitMQ/API services

### Code Quality

```bash
# Format code
make fmt

# Run linter
make lint

# Run all checks
make check
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Update documentation
6. Submit a pull request

## License

MIT License - See LICENSE file for details

## Support

- GitHub Issues: Report bugs and request features
- Documentation: [docs/](docs/)
- Examples: See [CLI_TOOLS.md](docs/CLI_TOOLS.md) for usage examples
