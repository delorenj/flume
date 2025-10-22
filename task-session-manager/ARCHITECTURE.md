# Architecture Documentation

This document describes the architecture, design decisions, and implementation details of the Task Session Manager service.

## Table of Contents

- [System Overview](#system-overview)
- [Component Design](#component-design)
- [Data Flow](#data-flow)
- [Concurrency Model](#concurrency-model)
- [Error Handling](#error-handling)
- [Reliability Patterns](#reliability-patterns)
- [Performance Characteristics](#performance-characteristics)
- [Security Considerations](#security-considerations)
- [Operational Concerns](#operational-concerns)

## System Overview

### Purpose

The Task Session Manager bridges task orchestration systems with interactive terminal sessions. It enables automated provisioning of development environments by:

1. Consuming task assignment events from a message queue
2. Creating isolated terminal sessions (tmux/zellij)
3. Launching appropriate agent CLIs within sessions
4. Publishing session lifecycle events for tracking

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Task Session Manager                        │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │   Consumer   │───>│   Session    │───>│  Publisher   │    │
│  │   (RabbitMQ) │    │   Manager    │    │  (RabbitMQ)  │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
│         │                     │                    │           │
│         │                     │                    │           │
│         v                     v                    v           │
│  ┌──────────────────────────────────────────────────────┐     │
│  │           Configuration & Logging Layer              │     │
│  └──────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Consumer Component (`internal/consumer`)

**Responsibility**: Consume and process task assignment events from RabbitMQ

**Key Features**:
- Connection management with automatic reconnection
- Manual message acknowledgment for reliability
- Concurrent message processing with configurable prefetch
- Connection error monitoring and recovery
- Graceful shutdown support

**Design Decisions**:
- **Manual ACK**: Ensures messages aren't lost if processing fails
- **Prefetch Count**: Controls parallelism and memory usage
- **Reconnection Logic**: Exponential backoff with max retry time
- **Channel Isolation**: Separate channels for consumer and publisher

**Code Structure**:
```go
type Consumer struct {
    conn            *amqp.Connection    // RabbitMQ connection
    channel         *amqp.Channel       // Consumer channel
    sessionManager  *session.Manager    // Session creation
    publisher       *publisher.Publisher // Event publishing
    reconnecting    bool                // Reconnection guard
    stopChan        chan struct{}       // Shutdown signal
    doneChan        chan struct{}       // Shutdown complete
}
```

**Concurrency Model**:
- Single goroutine for message consumption
- Separate goroutine for connection error monitoring
- Mutex protection for reconnection logic
- Configurable prefetch for concurrent processing

### 2. Session Manager Component (`internal/session`)

**Responsibility**: Create and manage terminal sessions (tmux/zellij)

**Key Features**:
- Multi-manager support (tmux, zellij)
- Automatic manager detection and selection
- Working directory validation
- Agent command mapping
- Process PID tracking
- Session lifecycle management

**Design Decisions**:
- **Runtime Detection**: Checks which session managers are available at startup
- **Preference System**: Uses preferred manager if available, falls back gracefully
- **PID Tracking**: Attempts multiple methods to find actual agent PID
- **Environment Isolation**: Each session has its own environment variables
- **Detached Sessions**: Sessions run independently of service process

**Manager Selection Logic**:
```
1. Check if preferred manager is available
2. If not, try zellij (modern, better features)
3. If not, try tmux (universal availability)
4. If neither, fail with clear error message
```

**Session Naming Convention**:
```
Format: task-{task_id}
Example: task-550e8400-e29b-41d4-a716-446655440000
```

### 3. Publisher Component (`internal/publisher`)

**Responsibility**: Publish lifecycle events to RabbitMQ

**Key Features**:
- Connection pooling
- Persistent message delivery
- Correlation ID propagation
- Exchange auto-declaration
- Reconnection support

**Design Decisions**:
- **Persistent Messages**: `DeliveryMode: Persistent` ensures durability
- **Separate Connection**: Independent from consumer for isolation
- **Exchange Declaration**: Idempotent, safe to call on startup
- **Context Support**: Respects cancellation and timeouts

**Event Types**:
- `task.lifecycle.started`: Session created successfully
- `task.lifecycle.failed`: Session creation failed

### 4. Configuration Component (`internal/config`)

**Responsibility**: Load and validate configuration from environment

**Key Features**:
- Environment variable parsing
- Sensible defaults
- Type-safe configuration
- Validation on load
- Duration/integer parsing

**Configuration Categories**:
1. **RabbitMQ**: Connection, queue, exchange settings
2. **Session**: Manager preferences, timeouts, directories
3. **Service**: Logging, health checks, shutdown behavior
4. **Agents**: Command mappings for different agent types

**Validation Rules**:
- Required fields must be non-empty
- Session manager must be 'tmux' or 'zellij'
- URLs must be valid AMQP URLs
- Durations must be positive

### 5. Event Types (`pkg/events`)

**Responsibility**: Define event schemas and data structures

**Design Decisions**:
- **JSON Serialization**: Standard, widely supported
- **Timestamps**: RFC3339 format for interoperability
- **Metadata**: Extensible map for additional data
- **Correlation IDs**: Enable distributed tracing

## Data Flow

### Happy Path Flow

```
1. RabbitMQ Message Arrives
   └─> Consumer receives task.lifecycle.assigned event

2. Event Parsing
   └─> JSON deserialization into TaskLifecycleAssigned struct

3. Validation
   ├─> Validate working directory exists
   ├─> Determine agent command
   └─> Check session manager availability

4. Session Creation
   ├─> Generate session name (task-{id})
   ├─> Create tmux/zellij session
   ├─> Set working directory
   ├─> Launch agent CLI
   └─> Capture session ID and PID

5. Event Publishing
   └─> Publish task.lifecycle.started event

6. Message Acknowledgment
   └─> ACK message to RabbitMQ

7. Monitoring
   └─> Log success metrics and details
```

### Error Path Flow

```
1. Error Occurs During Processing
   ├─> Working directory doesn't exist
   ├─> Session creation fails
   ├─> Agent command not found
   └─> Timeout exceeded

2. Error Handling
   ├─> Log error with context
   ├─> Build failure event
   └─> Include error details and reason

3. Failure Event Publishing
   └─> Publish task.lifecycle.failed event

4. Message Handling
   └─> NACK without requeue (malformed/invalid)
       OR
   └─> NACK with requeue (transient failure)

5. Monitoring
   └─> Increment error metrics
```

## Concurrency Model

### Goroutine Usage

1. **Main Goroutine**: Application lifecycle, signal handling
2. **Consumer Goroutine**: Message consumption loop
3. **Connection Monitor Goroutine**: Watch for connection failures
4. **Health Check Goroutine**: HTTP server for /health and /ready

### Synchronization Primitives

- **Mutex**: Protects reconnection state
- **Channels**:
  - `stopChan`: Broadcast shutdown signal
  - `doneChan`: Wait for graceful shutdown
  - `errChan`: Propagate errors to main
  - `sigChan`: OS signal notifications

### Concurrency Safety

- **Consumer**: Single consumer goroutine, mutex for reconnection
- **Publisher**: Channel is not goroutine-safe, protected by single-use pattern
- **Session Manager**: Stateless operations, safe for concurrent use
- **Config**: Read-only after initialization, no synchronization needed

## Error Handling

### Error Categories

1. **Transient Errors**: Retry with backoff
   - Network failures
   - RabbitMQ connection loss
   - Temporary file system issues

2. **Permanent Errors**: Fail fast, don't retry
   - Malformed event JSON
   - Non-existent working directory
   - Invalid agent type
   - Session manager not available

3. **Timeout Errors**: Fail with context
   - Session creation timeout
   - Command execution timeout

### Error Propagation

```go
// Wrap errors with context
return fmt.Errorf("failed to create session: %w", err)

// Log errors with structured context
log.Error().
    Err(err).
    Str("task_id", taskID).
    Msg("Session creation failed")

// Publish failure events
failedEvent := &events.TaskLifecycleFailed{
    Reason: "session_creation_failed",
    ErrorDetails: err.Error(),
}
```

### Graceful Degradation

- **Session Manager Fallback**: tmux → zellij or vice versa
- **PID Detection Fallback**: Multiple methods attempted
- **Default Working Directory**: Used if not specified
- **Default Agent Command**: Fallback to bash

## Reliability Patterns

### At-Least-Once Delivery

- Manual message acknowledgment
- ACK only after successful processing
- NACK with requeue for transient failures
- Idempotent session creation (session names are unique per task)

### Connection Resilience

```go
// Reconnection with exponential backoff
for time.Since(startTime) < maxReconnectTime {
    if err := connect(); err == nil {
        return nil
    }
    time.Sleep(reconnectDelay)
    reconnectDelay = min(reconnectDelay * 2, maxDelay)
}
```

### Circuit Breaker Pattern

Implicit circuit breaker through:
- Max reconnect time limits
- Connection error monitoring
- Graceful service shutdown on persistent failures

### Health Checks

Two endpoints for different monitoring needs:

1. **`/health`**: Basic liveness probe
   - Always returns 200 if service is running
   - Used by orchestrators to detect if process is alive

2. **`/ready`**: Readiness probe
   - Returns 200 if ready to accept traffic
   - Checks RabbitMQ connection status
   - Used for load balancer decisions

## Performance Characteristics

### Throughput

- **Baseline**: ~10 sessions/second on standard hardware
- **Optimized**: ~50 sessions/second with prefetch=5
- **Bottleneck**: Session creation (tmux/zellij startup time)

### Latency

- **Event to Session**: 1-2 seconds typical
  - RabbitMQ delivery: <100ms
  - Session creation: 500-1500ms
  - Event publishing: <100ms

### Resource Usage

- **Memory**: ~20MB base + ~5MB per concurrent session creation
- **CPU**: Minimal except during session creation bursts
- **Connections**: 2 RabbitMQ connections (consumer + publisher)
- **File Descriptors**: ~10 base + 2 per active session

### Scalability

**Vertical Scaling**:
- Increase `RABBITMQ_PREFETCH_COUNT` for more parallelism
- Add CPU cores (session creation is CPU-bound)

**Horizontal Scaling**:
- Multiple service instances consuming from same queue
- RabbitMQ load balances messages across consumers
- No shared state between instances
- Sessions are machine-local (each instance manages its own)

**Limitations**:
- Sessions are tied to the machine they're created on
- Can't migrate sessions between instances
- Total capacity = sum of individual instance capacities

## Security Considerations

### Input Validation

- **Working Directory**: Must exist and be accessible
- **Agent Type**: Validated against known agents
- **Command Injection**: Commands are mapped, not passed directly
- **Path Traversal**: Working directory validated before use

### Credential Management

- **Environment Variables**: Secrets passed via env, not command line
- **RabbitMQ Credentials**: Never logged or exposed
- **Process Isolation**: Sessions run as service user

### Network Security

- **TLS Support**: Configure via `amqps://` URLs
- **Authentication**: RabbitMQ username/password
- **Firewall**: Expose only necessary ports (5672, 8080)

### Process Security

- **Non-Root User**: Service runs as dedicated user
- **Limited Permissions**: Only access to required directories
- **Resource Limits**: systemd controls (LimitNOFILE, LimitNPROC)
- **No New Privileges**: `NoNewPrivileges=true` in systemd

### Audit Trail

All operations logged with:
- Task ID
- Correlation ID
- User/agent information
- Timestamps
- Success/failure status

## Operational Concerns

### Logging Strategy

**Structured Logging** (zerolog):
- JSON in production for machine parsing
- Pretty-print in development for readability
- Configurable log levels (debug, info, warn, error)

**Log Context**:
```go
log.Info().
    Str("task_id", taskID).
    Str("session_id", sessionID).
    Int("agent_pid", pid).
    Dur("duration", elapsed).
    Msg("Session created")
```

### Monitoring & Metrics

**Key Metrics to Track**:
- Session creation rate (successes/failures)
- Message processing latency
- RabbitMQ connection status
- Active session count
- Error rates by type

**Observability Endpoints**:
- `/health`: Liveness probe
- `/ready`: Readiness probe
- Future: `/metrics` for Prometheus

### Deployment Strategies

**Blue-Green Deployment**:
1. Deploy new version alongside old
2. Validate health checks
3. Switch traffic to new version
4. Drain old version gracefully

**Rolling Update**:
1. Update instances one at a time
2. Wait for health checks
3. Continue to next instance

**Graceful Shutdown**:
```go
// Signal handling
sigChan := make(chan os.Signal, 1)
signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)
<-sigChan

// Graceful shutdown with timeout
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

// Stop consuming new messages
consumer.Stop()

// Wait for in-flight messages
<-consumer.doneChan

// Close connections
publisher.Close()
```

### Disaster Recovery

**Failure Scenarios**:

1. **RabbitMQ Down**:
   - Service continues retry attempts
   - Messages queued in RabbitMQ (if durable)
   - No message loss when RabbitMQ recovers

2. **Service Crash**:
   - systemd restarts service automatically
   - Unacknowledged messages requeued by RabbitMQ
   - Sessions remain running (detached from service)

3. **Machine Failure**:
   - Sessions lost (not recoverable)
   - Messages requeued to other instances
   - Orchestrator detects failure via health checks

**Recovery Procedures**:
- Check RabbitMQ queue depth
- Verify session manager availability
- Review service logs for errors
- Restart service if hung
- Scale horizontally if overloaded

### Maintenance Operations

**Session Cleanup**:
```bash
# List all sessions
tmux list-sessions

# Kill old/stuck sessions
for session in $(tmux list-sessions -F '#{session_name}' | grep '^task-'); do
    tmux kill-session -t "$session"
done
```

**Queue Management**:
```bash
# Check queue depth
rabbitmqadmin list queues name messages

# Purge queue (careful!)
rabbitmqadmin purge queue name=task.session.assigned
```

**Service Restart**:
```bash
# Graceful restart (waits for current messages)
sudo systemctl reload task-session-manager

# Hard restart (terminates immediately)
sudo systemctl restart task-session-manager
```

## Design Trade-offs

### Decisions & Rationale

1. **Manual ACK vs Auto-ACK**
   - **Chose**: Manual ACK
   - **Reason**: Ensures reliability, prevents message loss
   - **Trade-off**: More complex code, must handle ACK/NACK correctly

2. **Separate Consumer/Publisher Connections**
   - **Chose**: Separate connections
   - **Reason**: Isolation, better error handling
   - **Trade-off**: More network connections

3. **Detached Sessions**
   - **Chose**: Sessions independent of service
   - **Reason**: Sessions survive service restarts
   - **Trade-off**: Must track sessions externally

4. **Synchronous Processing**
   - **Chose**: Process messages sequentially (or with limited prefetch)
   - **Reason**: Prevents resource exhaustion
   - **Trade-off**: Lower throughput

5. **Go 1.21+**
   - **Chose**: Modern Go version
   - **Reason**: Better performance, improved generics, enhanced stdlib
   - **Trade-off**: Requires recent Go installation

## Future Enhancements

### Potential Improvements

1. **Metrics Endpoint**: Add Prometheus `/metrics` for detailed observability
2. **Session Persistence**: Store session metadata in database
3. **Session Migration**: Support moving sessions between instances
4. **Resource Limits**: Per-session CPU/memory limits via cgroups
5. **Dynamic Reconfiguration**: Reload config without restart
6. **Batch Processing**: Process multiple events in single transaction
7. **Priority Queues**: High/low priority task routing
8. **Dead Letter Queue**: Handle permanently failed messages
9. **Webhook Notifications**: Alert on failures via HTTP
10. **Admin API**: REST API for session management

### Scalability Roadmap

- **Phase 1**: Current (10-50 sessions/second)
- **Phase 2**: Batching + optimizations (100-200 sessions/second)
- **Phase 3**: Distributed sessions (1000+ sessions/second)

## Appendix

### Configuration Reference

See `.env.example` for complete configuration options.

### Event Schema Reference

See `pkg/events/types.go` for detailed type definitions.

### Code Organization

```
task-session-manager/
├── cmd/              # Application entry point
├── internal/         # Internal packages
│   ├── config/       # Configuration management
│   ├── consumer/     # RabbitMQ consumer
│   ├── publisher/    # Event publisher
│   └── session/      # Session manager
├── pkg/              # Public packages
│   └── events/       # Event type definitions
└── scripts/          # Operational scripts
```

### Dependencies

- **github.com/rabbitmq/amqp091-go**: RabbitMQ client
- **github.com/rs/zerolog**: Structured logging
- **tmux/zellij**: Terminal multiplexers (runtime)

---

**Document Version**: 1.0
**Last Updated**: 2025-01-15
**Maintainer**: 33GOD Engineering Team
