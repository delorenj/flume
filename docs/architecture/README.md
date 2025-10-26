# Flume CLI Shell Integration - Architecture Documentation

**Project:** Flume Task Lifecycle System
**Version:** 1.0.0
**Date:** 2025-10-22
**Status:** Architecture Design Complete

---

## Overview

This directory contains the complete architecture documentation for the CLI Shell Integration component of the Flume task lifecycle system.

The CLI Shell Integration enables seamless orchestration of terminal-based AI agent CLIs (Claude Code, Gemini, GPT, etc.) within an event-driven task management framework powered by Obsidian, RabbitMQ, and real-time monitoring.

---

## Architecture Documents

### 📋 [00-ARCHITECTURE_SUMMARY.md](./00-ARCHITECTURE_SUMMARY.md)

**Start Here** - Comprehensive overview of the entire architecture.

**Contents:**
- Executive summary
- Component overview
- System architecture diagram
- Data flow examples
- Integration points
- Implementation roadmap (4 phases)
- Success metrics
- Future enhancements

**Audience:** Product managers, architects, all developers

---

### 🔧 [01-wrapper-design.md](./01-wrapper-design.md)

**flume-agent Wrapper Architecture**

**Contents:**
- Input processing (CLI arguments)
- Configuration loading
- Task context injection (environment + prompts)
- Agent invocation strategy
- Event emission (started, in_progress, completed, failed)
- Heartbeat monitoring (60s intervals)
- Completion detection (exit code, timeout, signal)
- Error handling and retry logic
- Security considerations
- Testing strategy

**Audience:** Backend developers implementing the wrapper

**Key Specs:**
- Language: Go
- Memory: < 20MB
- Startup: < 200ms
- Event latency: < 50ms

---

### 🗄️ [02-session-management.md](./02-session-management.md)

**Enhanced Task Session Manager Architecture**

**Contents:**
- Session state schema (SQLite)
- Session registry (in-memory cache + persistence)
- Wrapper integration (CreateSession modifications)
- Heartbeat processing (in_progress event consumption)
- Stale session detection
- Cleanup automation (scheduled with delay)
- Session recovery (reconnection after restart)
- Platform-specific terminal launching

**Audience:** Backend developers enhancing the session manager

**Key Specs:**
- Database: SQLite with WAL mode
- Session creation: < 3s
- Registry lookup: < 1ms
- Recovery: 100% after planned restart

---

### 📡 [03-event-flows.md](./03-event-flows.md)

**Event-Driven Lifecycle Architecture**

**Contents:**
- Complete event flow sequence (7 event types)
- Enhanced payload specifications
  - `task.lifecycle.assigned`
  - `task.lifecycle.started`
  - `task.lifecycle.in_progress` (NEW enhanced payload)
  - `task.lifecycle.completed`
  - `task.lifecycle.failed`
- RabbitMQ routing patterns
- Event correlation strategy (correlation_id + parent_event_id)
- Go event publisher implementation
- Python consumer integration
- Idempotency and deduplication
- Performance characteristics

**Audience:** Backend developers, integration engineers

**Key Specs:**
- Delivery: At-least-once via RabbitMQ
- Latency: < 100ms end-to-end
- Throughput: 1000 events/sec

---

### ⚙️ [04-configuration.md](./04-configuration.md)

**Centralized Configuration Architecture**

**Contents:**
- Complete YAML schema (`~/.config/flume/config.yaml`)
- Configuration sections:
  - RabbitMQ (connection, TLS, reconnection)
  - Agents (CLI configurations, API keys)
  - Session (multiplexer, database, recovery)
  - Monitoring (heartbeat, logging, metrics)
  - Completion (timeout, cleanup, archival)
  - Security (secrets, limits, validation)
  - Platform (Linux/macOS/Windows)
- Environment variable reference
- Loading hierarchy (flags > env > file > defaults)
- Agent CLI support matrix
- Cross-platform terminal launching
- Configuration validation
- Minimal vs. advanced examples

**Audience:** DevOps engineers, backend developers, end users

**Key Specs:**
- Zero-config defaults
- Progressive enhancement
- Environment parity

---

## Quick Navigation

### By Role

**Product Manager / Architect:**
- Start: [00-ARCHITECTURE_SUMMARY.md](./00-ARCHITECTURE_SUMMARY.md)
- Review roadmap and success metrics

**Backend Developer (Wrapper):**
1. [00-ARCHITECTURE_SUMMARY.md](./00-ARCHITECTURE_SUMMARY.md) - Overview
2. [01-wrapper-design.md](./01-wrapper-design.md) - Implementation details
3. [03-event-flows.md](./03-event-flows.md) - Event payloads
4. [04-configuration.md](./04-configuration.md) - Config loading

**Backend Developer (Session Manager):**
1. [00-ARCHITECTURE_SUMMARY.md](./00-ARCHITECTURE_SUMMARY.md) - Overview
2. [02-session-management.md](./02-session-management.md) - Implementation details
3. [03-event-flows.md](./03-event-flows.md) - Event consumption
4. [04-configuration.md](./04-configuration.md) - Config structure

**DevOps Engineer:**
1. [04-configuration.md](./04-configuration.md) - Deployment config
2. [00-ARCHITECTURE_SUMMARY.md](./00-ARCHITECTURE_SUMMARY.md) - Infrastructure requirements
3. [02-session-management.md](./02-session-management.md) - Database setup

---

## Implementation Phases

### ✅ Phase 0: Architecture Design (COMPLETE)

**Deliverables:**
- [x] Architecture summary document
- [x] Wrapper design specification
- [x] Session management enhancement spec
- [x] Event flow design
- [x] Configuration architecture
- [x] All documents reviewed and approved

---

### 🚧 Phase 1: Core Wrapper (Week 1) - IN PROGRESS

**Reference:** [01-wrapper-design.md](./01-wrapper-design.md)

**Tasks:**
- [ ] Go project scaffold for `flume-agent`
- [ ] Configuration loading (YAML + env vars)
- [ ] Task context extraction from TASK.md
- [ ] Prompt template rendering
- [ ] Agent CLI invocation (claude-code)
- [ ] Event publisher (started, completed, failed)
- [ ] Heartbeat monitor (git stats)
- [ ] Completion detection (exit code, timeout)
- [ ] Unit tests

**Success Criteria:**
- Wrapper launches Claude Code with task context
- Events emitted to RabbitMQ correctly
- Exit code determines completion

---

### 📅 Phase 2: Session Management (Week 2) - PLANNED

**Reference:** [02-session-management.md](./02-session-management.md)

**Tasks:**
- [ ] SQLite schema for sessions
- [ ] Session registry implementation
- [ ] Enhanced CreateSession with wrapper
- [ ] Heartbeat consumer
- [ ] Stale detection
- [ ] Cleanup scheduler
- [ ] Session recovery
- [ ] Integration tests

---

### 📅 Phase 3: Multi-Agent Support (Week 3) - PLANNED

**Reference:** [01-wrapper-design.md](./01-wrapper-design.md), [04-configuration.md](./04-configuration.md)

**Tasks:**
- [ ] Agent registry
- [ ] Gemini CLI support
- [ ] GPT CLI support
- [ ] Agent auto-detection
- [ ] Custom agent config
- [ ] Platform-specific terminal launching

---

### 📅 Phase 4: Observability (Week 4) - PLANNED

**Reference:** [03-event-flows.md](./03-event-flows.md)

**Tasks:**
- [ ] Enhanced dashboard UI
- [ ] Progress visualization
- [ ] File/git stats display
- [ ] Activity log streaming
- [ ] Prometheus metrics
- [ ] Performance benchmarks

---

## Key Concepts

### Wrapper Pattern

The `flume-agent` wrapper is a **thin orchestration layer** that:
1. Injects task context into agent CLIs
2. Monitors agent execution
3. Emits lifecycle events
4. Handles completion and cleanup

**Not responsible for:**
- Business logic
- State management (delegates to session registry)
- Agent behavior modification

---

### Event-Driven Lifecycle

All task lifecycle events flow through RabbitMQ:

```
assigned → started → in_progress (x N) → completed/failed
```

**Correlation Strategy:**
- Single `correlation_id` generated in assigned event
- All subsequent events inherit this ID
- `parent_event_id` links to immediate predecessor
- Enables full event chain reconstruction

---

### Session Persistence

Sessions are tracked in SQLite with in-memory caching:

**States:** pending → starting → running → completed/failed/stale → cleaning

**Recovery:** Sessions persist across restarts and can be reconnected

**Cleanup:** Automated cleanup after configurable delay (default 1 hour)

---

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Wrapper | Go 1.22+ | Performance, concurrency |
| Session Manager | Go 1.22+ | Existing codebase |
| Event Bus | RabbitMQ | Reliable message delivery |
| Database | SQLite (WAL mode) | Session persistence |
| Config | YAML + env vars | Hierarchical configuration |
| Logging | zerolog | Structured JSON logs |
| Monitoring | Prometheus (optional) | Metrics export |

---

## External Dependencies

### Required

- **RabbitMQ:** Message broker for event bus
- **Terminal Multiplexer:** tmux or zellij for session management
- **Agent CLIs:** claude, gemini-cli, gpt, etc.

### Optional

- **Prometheus:** Metrics collection
- **OpenTelemetry:** Distributed tracing
- **SQLite:** Session persistence (can run in-memory only)

---

## Performance Targets

| Metric | Target | Critical |
|--------|--------|----------|
| Session spawn time | < 3s | ✅ |
| Wrapper startup | < 200ms | ✅ |
| Event emission | < 100ms | ✅ |
| Heartbeat CPU | < 1% | ✅ |
| Memory per session | < 50MB | ✅ |
| Registry lookup | < 1ms | ✅ |

---

## Security Considerations

1. **Secrets Management:**
   - Never log API keys or credentials
   - Use environment variables for sensitive data
   - Config file permissions: 0600

2. **Input Validation:**
   - Validate all CLI arguments
   - Check working directory existence
   - Sanitize environment variables in logs

3. **Resource Limits:**
   - Maximum sessions per user
   - CPU/memory caps (optional)
   - Timeout enforcement

4. **Network Security:**
   - TLS support for RabbitMQ
   - Certificate validation
   - No hardcoded credentials

---

## Getting Help

### Questions?

- **Architecture Questions:** Refer to [00-ARCHITECTURE_SUMMARY.md](./00-ARCHITECTURE_SUMMARY.md)
- **Implementation Details:** Check component-specific docs
- **Configuration Help:** See [04-configuration.md](./04-configuration.md)

### Contributing

When implementing features:

1. Read relevant architecture document(s)
2. Follow design specifications exactly
3. Write tests as specified
4. Update docs if design changes
5. Submit PR with reference to arch doc

---

## Document Status

| Document | Status | Last Updated |
|----------|--------|--------------|
| 00-ARCHITECTURE_SUMMARY.md | ✅ Complete | 2025-10-22 |
| 01-wrapper-design.md | ✅ Complete | 2025-10-22 |
| 02-session-management.md | ✅ Complete | 2025-10-22 |
| 03-event-flows.md | ✅ Complete | 2025-10-22 |
| 04-configuration.md | ✅ Complete | 2025-10-22 |

---

**Architecture designed by:** System Architect
**Review Status:** Ready for Implementation
**Next Action:** Begin Phase 1 (flume-agent wrapper)

