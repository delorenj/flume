# Quick Start Guide

Get the Task Monitor Service running in 5 minutes!

## Prerequisites

- Docker and Docker Compose installed
- Python 3.12+ (for local development)

## Option 1: Docker Compose (Recommended)

### 1. Start the Services

```bash
# Clone and navigate to directory
cd task-monitor

# Start RabbitMQ and Task Monitor
docker-compose up -d

# Check status
docker-compose ps
```

### 2. Verify Service is Running

```bash
# Check health
curl http://localhost:8000/health

# View logs
docker-compose logs -f task-monitor
```

### 3. Publish Test Events

```bash
# Install dependencies for example publisher
pip install aio-pika

# Run example publisher
python example_publisher.py
```

### 4. Query the API

```bash
# Get all tasks
curl http://localhost:8000/tasks | jq

# Get metrics
curl http://localhost:8000/metrics | jq

# Get active tasks
curl http://localhost:8000/tasks/active | jq

# Get specific task details
curl http://localhost:8000/tasks/task-1234 | jq

# Get task event history
curl http://localhost:8000/tasks/task-1234/events | jq
```

### 5. Access Web Interfaces

- **Task Monitor API**: http://localhost:8000/docs (Swagger UI)
- **RabbitMQ Management**: http://localhost:15672 (username: `guest`, password: `guest`)

### 6. Stop Services

```bash
docker-compose down
```

## Option 2: Local Development

### 1. Install Dependencies

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Or use uv (faster)
pip install uv
uv pip install --system -r requirements.txt
```

### 2. Start RabbitMQ

```bash
docker run -d \
  --name rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:3.13-management-alpine
```

### 3. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit if needed (defaults work for local RabbitMQ)
nano .env
```

### 4. Run the Service

```bash
python main.py
```

### 5. In Another Terminal, Run Example Publisher

```bash
source venv/bin/activate  # Activate venv
python example_publisher.py
```

## Using the Makefile

For convenience, use the provided Makefile:

```bash
# See all available commands
make help

# Quick start everything
make quickstart

# View logs
make docker-logs

# Run tests
make test

# Run code quality checks
make check

# Stop everything
make docker-down
```

## API Quick Reference

### List Tasks
```bash
GET /tasks?status=in_progress&agent_id=agent-1&limit=50&offset=0
```

### Get Task Details
```bash
GET /tasks/{task_id}
```

### Get Task Events
```bash
GET /tasks/{task_id}/events
```

### Get Active Tasks
```bash
GET /tasks/active
```

### Get Stale Tasks
```bash
GET /tasks/stale
```

### Get Metrics
```bash
GET /metrics
```

### Get Prometheus Metrics
```bash
GET /metrics/prometheus
```

### Health Check
```bash
GET /health
```

### WebSocket Connection
```bash
WS ws://localhost:8000/ws
```

## Publishing Events

### Python Example

```python
import asyncio
import json
from datetime import datetime, timezone
import aio_pika

async def publish_event():
    connection = await aio_pika.connect_robust(
        "amqp://guest:guest@localhost:5672/"
    )
    channel = await connection.channel()

    exchange = await channel.declare_exchange(
        "task_events",
        aio_pika.ExchangeType.TOPIC,
        durable=True,
    )

    event = {
        "task_id": "my-task-123",
        "event_type": "started",
        "agent_id": "agent-1",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "message": "Task started",
        "data": {"priority": "high"}
    }

    await exchange.publish(
        aio_pika.Message(
            body=json.dumps(event).encode(),
            content_type="application/json",
        ),
        routing_key="task.lifecycle.started",
    )

    await connection.close()

asyncio.run(publish_event())
```

### curl Example

```bash
# Note: This requires rabbitmq-management plugin and uses HTTP API
curl -u guest:guest -H "content-type:application/json" \
  -X POST http://localhost:15672/api/exchanges/%2F/task_events/publish \
  -d '{
    "properties": {},
    "routing_key": "task.lifecycle.started",
    "payload": "{\"task_id\":\"task-123\",\"event_type\":\"started\",\"agent_id\":\"agent-1\",\"timestamp\":\"2025-01-15T10:30:00Z\"}",
    "payload_encoding": "string"
  }'
```

## Monitoring with Prometheus & Grafana

Start the full monitoring stack:

```bash
docker-compose --profile monitoring up -d
```

Access:
- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3000 (username: `admin`, password: `admin`)

Add Task Monitor as data source in Grafana:
1. Go to Configuration > Data Sources
2. Add Prometheus: `http://prometheus:9090`
3. Create dashboards using available metrics

## Troubleshooting

### Service won't start
```bash
# Check RabbitMQ is running
docker-compose ps rabbitmq

# Check logs
docker-compose logs task-monitor

# Verify RabbitMQ is healthy
docker-compose exec rabbitmq rabbitmq-diagnostics ping
```

### Can't connect to RabbitMQ
```bash
# Check if port is accessible
telnet localhost 5672

# Restart RabbitMQ
docker-compose restart rabbitmq

# Check RabbitMQ logs
docker-compose logs rabbitmq
```

### No tasks appearing
```bash
# Verify queue is created and bound
# Go to: http://localhost:15672/#/queues
# Check: task_monitor_queue exists and is bound to task_events exchange

# Test publishing manually
python example_publisher.py

# Check consumer is connected
curl http://localhost:8000/stats
```

### High memory usage
```bash
# Check task count
curl http://localhost:8000/metrics | jq '.total_tasks'

# Reduce retention period
# Edit docker-compose.yml:
# TASK_MONITOR_RETENTION_HOURS: "1"

# Restart service
docker-compose restart task-monitor
```

## Next Steps

1. **Integrate with your tasks**: Modify your task system to publish events to RabbitMQ
2. **Create dashboards**: Build Grafana dashboards with the Prometheus metrics
3. **Set up alerts**: Configure alerts for stale tasks or high failure rates
4. **Scale horizontally**: Run multiple Task Monitor instances for high availability
5. **Customize retention**: Adjust retention periods based on your needs

## Getting Help

- Read the full [README.md](README.md) for detailed documentation
- Check [test_service.py](test_service.py) for usage examples
- View logs: `docker-compose logs -f task-monitor`
- Check RabbitMQ management UI: http://localhost:15672

## Clean Up

```bash
# Stop services
docker-compose down

# Remove volumes (delete all data)
docker-compose down -v

# Remove everything including images
docker-compose down -v --rmi all
```

---

**That's it!** You now have a fully functional task monitoring service running. 🎉
