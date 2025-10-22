#!/bin/bash

# Script to publish a test event to RabbitMQ

set -e

# Configuration
RABBITMQ_HOST="${RABBITMQ_HOST:-localhost}"
RABBITMQ_PORT="${RABBITMQ_PORT:-5672}"
RABBITMQ_USER="${RABBITMQ_USER:-guest}"
RABBITMQ_PASS="${RABBITMQ_PASS:-guest}"
EXCHANGE="${RABBITMQ_EXCHANGE:-task.lifecycle}"
ROUTING_KEY="${RABBITMQ_ROUTING_KEY:-task.lifecycle.assigned}"

# Generate test event
TASK_ID="test-$(date +%s)"
WORKING_DIR="${1:-/tmp}"
AGENT_TYPE="${2:-claude-code}"

EVENT=$(cat <<EOF
{
  "task_id": "${TASK_ID}",
  "working_dir": "${WORKING_DIR}",
  "agent_type": "${AGENT_TYPE}",
  "command": "",
  "environment": {},
  "priority": "normal",
  "correlation_id": "test-corr-${TASK_ID}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "metadata": {
    "test": true,
    "source": "test-script"
  }
}
EOF
)

echo "Publishing test event..."
echo "Task ID: ${TASK_ID}"
echo "Working Dir: ${WORKING_DIR}"
echo "Agent Type: ${AGENT_TYPE}"
echo ""

# Check if rabbitmqadmin is available
if ! command -v rabbitmqadmin &> /dev/null; then
    echo "Error: rabbitmqadmin not found"
    echo "Install with: wget http://localhost:15672/cli/rabbitmqadmin && chmod +x rabbitmqadmin"
    exit 1
fi

# Publish event
rabbitmqadmin publish \
    --host="${RABBITMQ_HOST}" \
    --port="${RABBITMQ_PORT}" \
    --username="${RABBITMQ_USER}" \
    --password="${RABBITMQ_PASS}" \
    exchange="${EXCHANGE}" \
    routing_key="${ROUTING_KEY}" \
    payload="${EVENT}"

echo ""
echo "Event published successfully!"
echo ""
echo "To monitor the session:"
echo "  tmux list-sessions | grep task-${TASK_ID}"
echo "  tmux attach -t task-${TASK_ID}"
echo ""
