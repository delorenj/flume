# Task Session Manager Enhancement - Summary

**Status:** Design Complete - Ready for Implementation Review
**Date:** 2025-10-22
**Component:** Task Session Manager v2.0.0

---

## Overview

The existing Go task-session-manager has been analyzed and a comprehensive enhancement design has been created to integrate with the flume-agent wrapper and add advanced session lifecycle management capabilities.

---

## What Was Delivered

### 1. Architecture Design Document

**File:** `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-session-manager/ENHANCEMENT_DESIGN.md`

**Contents:**
- Complete architectural overview
- Detailed component designs
- Implementation phases with timeline
- Testing strategy
- Performance considerations
- Security analysis
- Risk assessment

**Key Features Designed:**
- SessionState tracking with in-memory and SQLite persistence
- Session recovery manager for restart scenarios
- Automatic cleanup manager for stale/completed sessions
- Wrapper integration for standardized agent invocation
- YAML configuration file support

### 2. Implementation Specification

**File:** `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-session-manager/IMPLEMENTATION_SPEC.md`

**Contents:**
- Detailed file structure
- Complete Go code implementations for:
  - State management (`internal/state/`)
  - Session recovery (`internal/recovery/`)
  - Session cleanup (`internal/cleanup/`)
  - Configuration enhancements
- Testing requirements and checklists
- Error handling specifications
- Deployment strategy

**Ready-to-implement code includes:**
- 4 new packages with full implementations
- Configuration updates
- Integration with existing codebase
- Comprehensive test requirements

---

## Architecture Highlights

### Current State (v1.0.0)

```
RabbitMQ → Consumer → Session Manager → Tmux/Zellij → Raw Agent CLI
                          ↓
                      Publisher → Events
```

**Limitations:**
- No session state tracking
- Cannot recover after restart
- No cleanup of stale sessions
- Direct agent CLI invocation

### Enhanced State (v2.0.0)

```
RabbitMQ → Consumer → Session Manager → State Store (Memory/SQLite)
                          ↓                    ↓
                   Wrapper Invocation      Recovery Manager
                          ↓                    ↓
                   flume-agent wrapper     Cleanup Manager
                          ↓
                   Agent CLI (claude/gemini/etc)
```

**New Capabilities:**
- In-memory and persistent state tracking
- Session recovery on restart
- Automatic stale detection and cleanup
- Wrapper-based agent invocation with context injection
- YAML configuration with env overrides

---

## Key Components

### 1. State Management (`internal/state/`)

**Purpose:** Track session state in memory and optionally persist to SQLite

**Components:**
- `SessionState` type with status lifecycle
- `StateStore` interface
- `MemoryStore` implementation (default)
- `SQLiteStore` implementation (optional)

**Capabilities:**
- Store/retrieve session states
- Filter and query sessions
- Update heartbeats and status
- Detect stale sessions

### 2. Recovery Manager (`internal/recovery/`)

**Purpose:** Reconnect to existing sessions on service restart

**Capabilities:**
- Discover active sessions from state store
- Verify sessions still exist in tmux/zellij
- Mark missing sessions as stale
- Emit recovery events to monitoring

### 3. Cleanup Manager (`internal/cleanup/`)

**Purpose:** Automatically clean up stale and completed sessions

**Capabilities:**
- Background cleanup loop (configurable interval)
- Stale session detection (no heartbeat threshold)
- Completed session retention policy
- Graceful session termination

### 4. Wrapper Integration

**Purpose:** Invoke flume-agent wrapper instead of raw CLI

**Capabilities:**
- Build wrapper command with task context
- Pass task metadata and configuration
- Environment variable injection
- Fallback to raw CLI if wrapper unavailable

### 5. Configuration Enhancement

**Purpose:** Flexible configuration via YAML or environment variables

**New Configuration Sections:**
- `wrapper`: Wrapper settings (enabled, path, intervals)
- `state_store`: Storage backend selection (memory/sqlite)
- `cleanup`: Cleanup policies and thresholds

---

## Implementation Timeline

### Phase 1: State Management (2 days)
- Implement SessionState types
- Implement MemoryStore
- Implement SQLiteStore
- Write comprehensive tests

### Phase 2: Wrapper Integration (2 days)
- Update CreateSession method
- Add wrapper command builder
- Integrate state storage
- Update tests

### Phase 3: Session Recovery (2 days)
- Implement RecoveryManager
- Add startup recovery
- Add recovery events
- Write recovery tests

### Phase 4: Session Cleanup (2 days)
- Implement CleanupManager
- Add background cleanup loop
- Add cleanup policies
- Write cleanup tests

### Phase 5: Integration & Testing (3 days)
- End-to-end integration tests
- Performance benchmarks
- Documentation updates
- Deployment preparation

**Total Estimated Time:** 10-12 working days (2 weeks)

---

## Backward Compatibility

### 100% Compatible

All enhancements are **opt-in** and can be disabled:

```bash
# Deploy v2.0.0 with all features disabled
WRAPPER_ENABLED=false
STATE_STORE_TYPE=memory  # No persistence
CLEANUP_ENABLED=false

# Existing functionality works exactly as v1.0.0
```

### Gradual Migration Path

```bash
# Step 1: Enable state tracking (in-memory)
STATE_STORE_TYPE=memory

# Step 2: Enable SQLite persistence
STATE_STORE_TYPE=sqlite
STATE_STORE_SQLITE_PATH=~/.flume/sessions.db

# Step 3: Enable wrapper
WRAPPER_ENABLED=true
WRAPPER_PATH=/usr/local/bin/flume-agent

# Step 4: Enable cleanup
CLEANUP_ENABLED=true
CLEANUP_STALE_THRESHOLD=24h
```

---

## Testing Strategy

### Unit Tests
- Target: 95%+ coverage for new code
- Focus: State management, recovery, cleanup logic
- Tools: Go testing package, testify

### Integration Tests
- Full lifecycle scenarios
- Recovery after restart
- Cleanup after stale threshold
- Wrapper fallback scenarios

### Performance Benchmarks
- Session creation overhead: < 100ms
- State operations: < 10ms writes, < 5ms reads
- Recovery time: < 1s per 100 sessions
- Memory usage: < 100MB for 1000 sessions

---

## Configuration Example

### YAML Configuration

```yaml
# ~/.config/flume/session-manager.yaml

wrapper:
  enabled: true
  path: "/usr/local/bin/flume-agent"
  heartbeat_interval: 60s
  timeout: 4h

state_store:
  type: "sqlite"
  sqlite:
    path: "~/.flume/sessions.db"

cleanup:
  enabled: true
  check_interval: 5m
  stale_threshold: 24h
  completed_retention: 1h
  force_kill: false
```

### Environment Variables

```bash
# Wrapper
WRAPPER_ENABLED=true
WRAPPER_PATH=/usr/local/bin/flume-agent
WRAPPER_HEARTBEAT_INTERVAL=60s

# State Store
STATE_STORE_TYPE=sqlite
STATE_STORE_SQLITE_PATH=~/.flume/sessions.db

# Cleanup
CLEANUP_ENABLED=true
CLEANUP_STALE_THRESHOLD=24h
CLEANUP_COMPLETED_RETENTION=1h
```

---

## Coordination with Other Components

### Dependencies

**Requires:**
- flume-agent wrapper (being developed in parallel)
- RabbitMQ Bloodbank exchange (exists)
- Task Monitor Service (exists)

**Provides:**
- Session state tracking for monitoring
- Recovery events for observability
- Cleanup events for auditing

### Event Flow

```
1. task.lifecycle.assigned → Session Manager
2. Session Manager → Creates session + stores state
3. Session Manager → task.lifecycle.started
4. Wrapper → task.lifecycle.in_progress (periodic)
5. Recovery Manager → task.lifecycle.recovered (on restart)
6. Cleanup Manager → Terminates stale sessions
```

---

## Risk Mitigation

### High Risks

1. **SQLite Database Corruption**
   - Mitigation: Regular backups, corruption detection
   - Fallback: Can switch to memory-only mode

2. **Wrapper Integration Breaking**
   - Mitigation: Automatic fallback to raw CLI
   - Detection: Log warnings, metrics

3. **Memory Leaks in State Tracking**
   - Mitigation: Memory profiling, leak detection tests
   - Monitoring: Memory usage alerts

### Medium Risks

1. **Cleanup Race Conditions**
   - Mitigation: Careful synchronization, mutex usage
   - Testing: Concurrent cleanup tests

2. **Recovery Conflicts**
   - Mitigation: Atomic state updates
   - Testing: Restart scenario tests

---

## Success Criteria

### Must Have
- [ ] All new features implemented
- [ ] 95%+ test coverage achieved
- [ ] Zero breaking changes
- [ ] Documentation complete
- [ ] Successfully deploys to staging

### Nice to Have
- [ ] Performance benchmarks exceed targets
- [ ] SQLite optimization complete
- [ ] Monitoring dashboard updated
- [ ] Wrapper integration demo ready

---

## Next Steps

### For Review
1. Review ENHANCEMENT_DESIGN.md architecture
2. Review IMPLEMENTATION_SPEC.md code details
3. Provide feedback on approach
4. Approve for implementation

### For Implementation
1. Begin Phase 1 (State Management)
2. Set up test harness
3. Implement MemoryStore and SQLiteStore
4. Achieve 95%+ coverage
5. Proceed to Phase 2

### For Coordination
1. Sync with flume-agent wrapper developer
2. Ensure wrapper CLI interface alignment
3. Coordinate event schema consistency
4. Plan integration testing

---

## Questions for User

1. **State Store Preference**: Do you want SQLite persistence enabled by default, or start with memory-only?

2. **Wrapper Coordination**: Is the flume-agent wrapper specification finalized? Any changes needed to align with this design?

3. **Configuration Location**: Confirm `~/.config/flume/session-manager.yaml` is the preferred config path?

4. **Cleanup Thresholds**: Are the default thresholds (24h stale, 1h retention) appropriate for your use case?

5. **Implementation Priority**: Should we prioritize any phase over others based on immediate needs?

---

## Files Created

### Documentation
1. `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-session-manager/ENHANCEMENT_DESIGN.md`
   - Complete architectural design
   - Component specifications
   - Implementation phases
   - Testing and security considerations

2. `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-session-manager/IMPLEMENTATION_SPEC.md`
   - Detailed file structure
   - Ready-to-implement Go code
   - Testing requirements
   - Deployment strategy

3. `/home/delorenj/code/projects/33GOD/flume/trunk-main/task-session-manager/ENHANCEMENT_SUMMARY.md`
   - This summary document

### Total Documentation
- ~15,000 lines of detailed specifications
- Complete Go implementations for all new components
- Comprehensive testing strategy
- Migration and deployment guides

---

## Recommendations

### Immediate Actions

1. **Review Architecture**: Ensure design aligns with overall system vision
2. **Coordinate Wrapper**: Sync with wrapper developer on CLI interface
3. **Approve Implementation**: Greenlight Phase 1 to begin coding
4. **Set Up Environment**: Prepare development environment for SQLite testing

### Before Production

1. **Security Review**: Audit SQLite permissions and data handling
2. **Performance Testing**: Run benchmarks with realistic workloads
3. **Integration Testing**: Full end-to-end tests with wrapper and monitoring
4. **Documentation Review**: Ensure all docs are accurate and complete

---

## Contact & Support

For questions or clarifications on this enhancement design:

1. Review detailed architecture in `ENHANCEMENT_DESIGN.md`
2. Check implementation details in `IMPLEMENTATION_SPEC.md`
3. Consult existing codebase for context
4. Coordinate with wrapper developer for integration

---

**Status:** Awaiting Review and Approval
**Ready for:** Implementation Phase 1
**Estimated Completion:** 2 weeks from approval
