# Quick Start Guide

Get the Task Session Manager running in 5 minutes!

## Prerequisites Check

```bash
# Check Go version (need 1.21+)
go version

# Check if tmux or zellij is installed
command -v tmux || command -v zellij

# Check if RabbitMQ is running
curl -s http://localhost:15672
```

## Option 1: Local Development (Fastest)

### 1. Start RabbitMQ (if not running)

```bash
# Using Docker
docker run -d --name rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:3.12-management-alpine

# Wait for RabbitMQ to start
sleep 10
```

### 2. Build and Run

```bash
# Clone and enter directory
cd /home/delorenj/code/projects/33GOD/cortex/task-session-manager

# Build
make build

# Run (in one terminal)
./bin/task-session-manager
```

### 3. Test It

```bash
# In another terminal, publish a test event
./scripts/test-event.sh /tmp claude-code

# Check if session was created
tmux list-sessions | grep task-
# or
zellij list-sessions | grep task-
```

## Option 2: Docker Compose (Production-Like)

```bash
# Start everything
make docker-run

# View logs
make docker-logs

# Stop everything
make docker-stop
```

## Option 3: System Service (Production)

```bash
# Build
make build

# Install (requires sudo)
sudo ./scripts/install.sh

# Configure
sudo nano /etc/task-session-manager/env

# Enable and start
sudo systemctl enable task-session-manager
sudo systemctl start task-session-manager

# Check status
sudo systemctl status task-session-manager

# View logs
sudo journalctl -u task-session-manager -f
```

## Testing the Service

### Manual Event Publishing

```bash
# Using provided script
./scripts/test-event.sh /tmp claude-code

# Using rabbitmqadmin directly
rabbitmqadmin publish \
  exchange=task.lifecycle \
  routing_key=task.lifecycle.assigned \
  payload='{"task_id":"test-123","working_dir":"/tmp","agent_type":"claude-code","correlation_id":"test-corr","timestamp":"2025-01-15T10:00:00Z"}'
```

### Check Results

```bash
# List all sessions
tmux list-sessions
# or
zellij list-sessions

# Attach to a specific session
tmux attach -t task-test-123
# or
zellij attach task-test-123

# Check service logs
# Docker
docker-compose logs -f task-session-manager

# Systemd
sudo journalctl -u task-session-manager -f

# Local run (check terminal)
```

### Verify Health

```bash
# Health check
curl http://localhost:8080/health

# Readiness check
curl http://localhost:8080/ready
```

## Common Issues

### "No session manager available"

**Problem**: Neither tmux nor zellij is installed

**Solution**:
```bash
# Ubuntu/Debian
sudo apt-get install tmux

# MacOS
brew install tmux zellij
```

### "Failed to connect to RabbitMQ"

**Problem**: RabbitMQ is not running or wrong URL

**Solution**:
```bash
# Check if RabbitMQ is running
docker ps | grep rabbitmq
# or
sudo systemctl status rabbitmq-server

# Update connection URL
export RABBITMQ_URL="amqp://guest:guest@localhost:5672/"
```

### "Working directory does not exist"

**Problem**: The working_dir in the event doesn't exist

**Solution**:
```bash
# Create the directory
mkdir -p /tmp/work

# Or use an existing directory in the event
./scripts/test-event.sh /home/user/existing-dir
```

## Next Steps

1. **Configure Agent Commands**: Edit environment variables to map agent types to CLI commands
   ```bash
   export AGENT_CMD_CLAUDE=/path/to/claude
   export AGENT_CMD_GEMINI=/path/to/gemini
   ```

2. **Set Up Monitoring**: Use the health endpoints with your monitoring system
   ```bash
   # Prometheus, Datadog, etc.
   curl http://localhost:8080/health
   ```

3. **Integrate with Your System**: Configure your task orchestrator to publish events to RabbitMQ

4. **Scale**: Run multiple instances with different routing keys for different task types

## Configuration Reference

### Essential Environment Variables

```bash
# RabbitMQ
RABBITMQ_URL=amqp://guest:guest@localhost:5672/
RABBITMQ_EXCHANGE=task.lifecycle
RABBITMQ_QUEUE=task.session.assigned
RABBITMQ_ROUTING_KEY=task.lifecycle.assigned

# Session Manager
SESSION_MANAGER=zellij  # or tmux
DEFAULT_WORK_DIR=/tmp

# Agent Commands
AGENT_CMD_CLAUDE=claude
AGENT_CMD_GEMINI=gemini
AGENT_CMD_GPT=gpt

# Logging
LOG_LEVEL=info  # debug, info, warn, error
```

### Full Configuration

See `.env.example` for all available options.

## Development Workflow

```bash
# Install dependencies
make deps

# Run with hot reload
make dev

# Run tests
make test

# Run linters
make lint

# Run all checks
make check

# Format code
make fmt

# Build
make build
```

## Troubleshooting Commands

```bash
# Check what's listening on RabbitMQ port
sudo netstat -tlnp | grep 5672

# Check what's listening on health check port
sudo netstat -tlnp | grep 8080

# View all tmux sessions
tmux list-sessions

# Kill a specific session
tmux kill-session -t task-123

# View RabbitMQ queues
rabbitmqadmin list queues

# Check RabbitMQ connections
rabbitmqadmin list connections
```

## Performance Tips

1. **Prefetch Count**: Increase for higher throughput
   ```bash
   export RABBITMQ_PREFETCH_COUNT=5
   ```

2. **Parallel Processing**: Run multiple service instances
   ```bash
   # Instance 1
   RABBITMQ_QUEUE=session.1 ./bin/task-session-manager &

   # Instance 2
   RABBITMQ_QUEUE=session.2 ./bin/task-session-manager &
   ```

3. **Resource Limits**: Set appropriate limits in systemd
   ```ini
   LimitNOFILE=65536
   LimitNPROC=4096
   ```

## Getting Help

- **Documentation**: See [README.md](README.md) for comprehensive docs
- **Issues**: https://github.com/33GOD/cortex/issues
- **Logs**: Always check logs first for error messages

## Quick Reference

| Command | Purpose |
|---------|---------|
| `make build` | Build the binary |
| `make run` | Build and run locally |
| `make test` | Run tests |
| `make docker-run` | Start with Docker |
| `make docker-logs` | View Docker logs |
| `sudo systemctl start task-session-manager` | Start service |
| `sudo journalctl -u task-session-manager -f` | View service logs |
| `./scripts/test-event.sh` | Publish test event |
| `tmux list-sessions` | List sessions |
| `curl localhost:8080/health` | Health check |

---

**Ready to go?** Start with Option 1 above and you'll have it running in minutes!
