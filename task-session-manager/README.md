# Task Session Manager

A production-ready Go service that manages terminal sessions for task lifecycle orchestration. It consumes task assignment events from RabbitMQ, spawns terminal sessions (tmux/zellij), launches agent CLIs, and publishes session lifecycle events.

## Features

- **RabbitMQ Integration**: Robust consumer with automatic reconnection
- **Session Management**: Supports both tmux and zellij session managers
- **Agent Orchestration**: Launches appropriate agent CLIs (claude, gemini, etc.)
- **Event Publishing**: Publishes lifecycle events (started/failed) back to RabbitMQ
- **Production Ready**: Comprehensive error handling, logging, and monitoring
- **Health Checks**: Built-in HTTP endpoints for health and readiness probes
- **Graceful Shutdown**: Proper cleanup on SIGTERM/SIGINT
- **Docker Support**: Containerized deployment with docker-compose

## Architecture

```
┌─────────────────┐         ┌──────────────────────┐         ┌─────────────────┐
│   RabbitMQ      │────────>│  Task Session        │────────>│  Terminal       │
│   (Producer)    │ assigned│  Manager Service     │ create  │  Session        │
│                 │         │                      │         │  (tmux/zellij)  │
└─────────────────┘         └──────────────────────┘         └─────────────────┘
                                      │                               │
                                      │ publishes                     │ runs
                                      v                               v
                            ┌─────────────────┐            ┌──────────────────┐
                            │   RabbitMQ      │            │  Agent CLI       │
                            │   (started/     │            │  (claude/gemini) │
                            │    failed)      │            │                  │
                            └─────────────────┘            └──────────────────┘
```

## Event Flow

1. **task.lifecycle.assigned** event arrives from RabbitMQ
2. Service creates a new terminal session (tmux or zellij)
3. Session is named `task-{task_id}`
4. Agent CLI is launched in the session
5. **task.lifecycle.started** event is published with session details
6. If creation fails, **task.lifecycle.failed** event is published

## Prerequisites

- Go 1.21 or later
- RabbitMQ 3.12 or later
- tmux or zellij installed on the system
- Agent CLIs (claude, gemini, etc.) available in PATH

## Installation

### Local Installation

```bash
# Clone the repository
git clone https://github.com/33GOD/flume.git
cd flume/task-session-manager

# Download dependencies
make deps

# Build the binary
make build

# Install to /usr/local/bin
sudo make install
```

### Docker Installation

```bash
# Build and run with docker-compose
make docker-run

# Or manually
docker build -t task-session-manager:latest .
docker run -d \
  -e RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672/ \
  task-session-manager:latest
```

### System Service Installation

```bash
# Create service user
sudo useradd -r -s /bin/false taskmanager

# Copy binary
sudo cp bin/task-session-manager /usr/local/bin/

# Copy systemd service file
sudo cp task-session-manager.service /etc/systemd/system/

# Create config directory
sudo mkdir -p /etc/task-session-manager

# Copy environment file
sudo cp .env.example /etc/task-session-manager/env

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable task-session-manager
sudo systemctl start task-session-manager

# Check status
sudo systemctl status task-session-manager
```

## Configuration

Configuration is done via environment variables. See `.env.example` for all available options.

### Key Configuration Options

| Variable               | Default                              | Description                                |
| ---------------------- | ------------------------------------ | ------------------------------------------ |
| `RABBITMQ_URL`         | `amqp://guest:guest@localhost:5672/` | RabbitMQ connection URL                    |
| `RABBITMQ_EXCHANGE`    | `task.lifecycle`                     | Exchange name                              |
| `RABBITMQ_QUEUE`       | `task.session.assigned`              | Queue name                                 |
| `RABBITMQ_ROUTING_KEY` | `task.lifecycle.assigned`            | Routing key for subscriptions              |
| `SESSION_MANAGER`      | `zellij`                             | Preferred session manager (zellij or tmux) |
| `LOG_LEVEL`            | `info`                               | Log level (debug, info, warn, error)       |
| `HEALTH_CHECK_PORT`    | `8080`                               | Port for health check endpoints            |

### Agent Command Mappings

Map agent types to CLI commands:

```bash
AGENT_CMD_CLAUDE=claude
AGENT_CMD_GEMINI=gemini
AGENT_CMD_GPT=gpt
AGENT_CMD_DEFAULT=bash
```

## Usage

### Running Locally

```bash
# Set environment variables
export RABBITMQ_URL=amqp://guest:guest@localhost:5672/
export LOG_LEVEL=debug

# Run the service
./bin/task-session-manager
```

### Running with Hot Reload (Development)

```bash
# Install air if not already installed
go install github.com/cosmtrek/air@latest

# Run with hot reload
make dev
```

### Publishing Test Events

```bash
# Install rabbitmq-utils
sudo apt-get install rabbitmq-server

# Publish a test event
rabbitmqadmin publish \
  exchange=task.lifecycle \
  routing_key=task.lifecycle.assigned \
  payload='{"task_id":"test-123","working_dir":"/tmp","agent_type":"claude-code","correlation_id":"test-correlation"}'
```

## Event Schemas

### Input: task.lifecycle.assigned

```json
{
  "task_id": "uuid-string",
  "working_dir": "/path/to/work",
  "agent_type": "claude-code",
  "command": "optional-custom-command",
  "environment": {
    "KEY": "value"
  },
  "priority": "high",
  "correlation_id": "correlation-uuid",
  "timestamp": "2025-01-15T10:30:00Z",
  "metadata": {}
}
```

### Output: task.lifecycle.started

```json
{
  "task_id": "uuid-string",
  "session_id": "task-uuid-string",
  "session_manager": "zellij",
  "agent_pid": 12345,
  "agent_type": "claude-code",
  "working_dir": "/path/to/work",
  "started_at": "2025-01-15T10:30:01Z",
  "correlation_id": "correlation-uuid",
  "parent_event_id": "message-id",
  "metadata": {}
}
```

### Output: task.lifecycle.failed

```json
{
  "task_id": "uuid-string",
  "reason": "session_creation_failed",
  "error_details": "detailed error message",
  "failed_at": "2025-01-15T10:30:01Z",
  "correlation_id": "correlation-uuid",
  "parent_event_id": "message-id",
  "metadata": {}
}
```

## Health Checks

The service exposes HTTP endpoints for monitoring:

- **GET /health** - Basic health check (always returns 200 OK)
- **GET /ready** - Readiness probe (returns 200 when ready)

```bash
# Check health
curl http://localhost:8080/health

# Check readiness
curl http://localhost:8080/ready
```

## Monitoring

### Logs

Logs are structured JSON in production, pretty-printed in development:

```bash
# View logs (systemd)
sudo journalctl -u task-session-manager -f

# View logs (Docker)
docker-compose logs -f task-session-manager
```

### Metrics

The service logs key metrics:

- Message processing rate
- Session creation success/failure rate
- RabbitMQ connection status
- Session manager availability

## Development

### Project Structure

```
task-session-manager/
├── cmd/
│   └── main.go              # Application entry point
├── internal/
│   ├── config/
│   │   └── config.go        # Configuration management
│   ├── consumer/
│   │   └── consumer.go      # RabbitMQ consumer
│   ├── session/
│   │   └── manager.go       # Session management
│   └── publisher/
│       └── publisher.go     # Event publishing
├── pkg/
│   └── events/
│       └── types.go         # Event type definitions
├── go.mod                   # Go module definition
├── Dockerfile               # Container image
├── docker-compose.yml       # Docker orchestration
├── Makefile                 # Build automation
└── README.md               # This file
```

### Running Tests

```bash
# Run all tests
make test

# Run tests with coverage
make test-coverage

# Run linters
make lint

# Run all checks
make check
```

### Adding New Agent Types

1. Add environment variable mapping:

   ```bash
   AGENT_CMD_NEWAGENT=newagent-cli
   ```

2. The service will automatically map `agent_type: "newagent"` to the command `newagent-cli`

## Troubleshooting

### Session Manager Not Found

**Error**: `no session manager (tmux or zellij) available on system`

**Solution**: Install tmux or zellij:

```bash
# Ubuntu/Debian
sudo apt-get install tmux

# MacOS
brew install zellij tmux
```

### RabbitMQ Connection Failed

**Error**: `failed to connect to RabbitMQ`

**Solution**: Check RabbitMQ is running and URL is correct:

```bash
# Check RabbitMQ status
sudo systemctl status rabbitmq-server

# Test connection
telnet localhost 5672
```

### Working Directory Not Found

**Error**: `working directory does not exist`

**Solution**: Ensure the working directory specified in the event exists:

```bash
mkdir -p /path/to/work
```

### Agent Command Not Found

**Error**: `exec: "claude": executable file not found in $PATH`

**Solution**: Install the agent CLI or update the command mapping:

```bash
export AGENT_CMD_CLAUDE=/full/path/to/claude
```

## Performance Tuning

### RabbitMQ Prefetch

Adjust the prefetch count to control parallelism:

```bash
# Process 1 message at a time (default)
RABBITMQ_PREFETCH_COUNT=1

# Process up to 5 messages concurrently
RABBITMQ_PREFETCH_COUNT=5
```

### Reconnection Settings

Tune reconnection behavior:

```bash
# Wait 10 seconds between reconnect attempts
RABBITMQ_RECONNECT_DELAY=10s

# Give up after 10 minutes
RABBITMQ_MAX_RECONNECT_TIME=10m
```
