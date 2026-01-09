# Sprint Plan: Flume

**Date:** 2026-01-05
**Scrum Master:** delorenj
**Project Level:** 2
**Total Stories:** 19
**Total Points:** 71
**Planned Sprints:** 3
**Sprint Length:** 2 weeks

---

## Executive Summary

This sprint plan breaks down the remaining work for Flume/Yi into actionable stories across 3 sprints. As a brownfield project, significant implementation already exists (8 FRs complete, 7 partial). Stories focus on completing partial implementations, adding missing features, and ensuring production readiness.

**Key Metrics:**
- Total Stories: 19
- Total Points: 71
- Sprints: 3
- Team Capacity: 25 points per sprint (solo developer, senior level)
- Target Completion: Week 6

---

## Story Inventory

### EPIC-001: Core Protocol Completion

#### STORY-001: TypeDoc Documentation for Flume Core

**Epic:** EPIC-001
**Priority:** Must Have
**Points:** 3

**User Story:**
As a framework developer
I want comprehensive TypeDoc documentation for all Flume types
So that I can understand the protocol without reading source code

**Acceptance Criteria:**
- [ ] JSDoc comments on all public interfaces in flume-core
- [ ] Generated TypeDoc site builds without errors
- [ ] All Employee, Task, State, Result, Event types documented
- [ ] Examples included for key interfaces

**Technical Notes:**
- Files: `packages/flume-core/src/types/*.ts`
- Add typedoc as dev dependency
- Configure typedoc.json for output

**Dependencies:** None

---

#### STORY-002: Runtime Type Validation Helpers

**Epic:** EPIC-001
**Priority:** Should Have
**Points:** 3

**User Story:**
As a framework developer
I want runtime type validation helpers
So that I can catch invalid data at protocol boundaries

**Acceptance Criteria:**
- [ ] isValidTaskPayload() function with type guard
- [ ] isValidWorkResult() function with type guard
- [ ] isValidBloodbankEvent() function with type guard
- [ ] Validation errors include specific field that failed
- [ ] Unit tests for all validators

**Technical Notes:**
- Add to `flume-core/src/validation/` directory
- Use Zod or manual validation (prefer manual for zero deps)
- Export from main index.ts

**Dependencies:** None

---

#### STORY-003: Edge Case Handling for State Transitions

**Epic:** EPIC-001
**Priority:** Should Have
**Points:** 2

**User Story:**
As a framework developer
I want robust state transition handling
So that invalid transitions throw clear errors

**Acceptance Criteria:**
- [ ] InvalidTransitionError class with from/to states
- [ ] transitionState() function that validates and executes
- [ ] Clear error messages for invalid transitions
- [ ] Unit tests for all valid and invalid transitions
- [ ] Edge cases: terminated state, errored recovery

**Technical Notes:**
- Extend `flume-core/src/types/state.ts`
- Create custom error class

**Dependencies:** None

---

### EPIC-002: Yi Adapter Layer Hardening

#### STORY-004: Round-Robin Selection Strategy

**Epic:** EPIC-002
**Priority:** Must Have
**Points:** 3

**User Story:**
As an orchestrator
I want round-robin selection strategy
So that work is distributed evenly across capable agents

**Acceptance Criteria:**
- [ ] RoundRobinStrategy class implementing SelectionStrategy
- [ ] Tracks last-selected index per manager
- [ ] Skips agents that can't handle the task
- [ ] Wraps around when reaching end of list
- [ ] Unit tests with multiple agents

**Technical Notes:**
- Add to `yi-adapter/src/selection/round-robin.ts`
- Export from index.ts
- State stored in manager instance

**Dependencies:** None

---

#### STORY-005: Skill-Match Selection Strategy

**Epic:** EPIC-002
**Priority:** Should Have
**Points:** 5

**User Story:**
As an orchestrator
I want skill-based selection strategy
So that tasks are routed to the best-matched agent

**Acceptance Criteria:**
- [ ] SkillMatchStrategy class implementing SelectionStrategy
- [ ] Scores agents based on skill overlap with task requirements
- [ ] Configurable scoring weights
- [ ] Returns highest-scoring capable agent
- [ ] Unit tests with various skill combinations

**Technical Notes:**
- Add to `yi-adapter/src/selection/skill-match.ts`
- Task tags/context indicate required skills
- Agent skills defined in Employee interface

**Dependencies:** None

---

#### STORY-006: Health Check Endpoints

**Epic:** EPIC-002
**Priority:** Must Have
**Points:** 3

**User Story:**
As an operator
I want health check endpoints
So that I can monitor Yi process health

**Acceptance Criteria:**
- [ ] HealthChecker class with status() method
- [ ] Checks: RabbitMQ connection, agent count, error rate
- [ ] Returns structured health status
- [ ] Optional HTTP server for `/health` endpoint
- [ ] Integration with boot sequence

**Technical Notes:**
- Add to `yi-adapter/src/boot/health-checker.ts`
- Use simple Node HTTP server (no Express dep)
- Port configurable via env var

**Dependencies:** FR-010 (Bloodbank Publisher)

---

#### STORY-007: Graceful Shutdown Handling

**Epic:** EPIC-002
**Priority:** Must Have
**Points:** 3

**User Story:**
As an operator
I want graceful shutdown
So that in-flight tasks complete before termination

**Acceptance Criteria:**
- [ ] SIGTERM/SIGINT handlers registered in boot sequence
- [ ] Stops accepting new tasks
- [ ] Waits for in-flight tasks (with timeout)
- [ ] Closes RabbitMQ connection cleanly
- [ ] Emits shutdown event to Bloodbank
- [ ] Exit code reflects success/failure

**Technical Notes:**
- Add to `yi-adapter/src/boot/shutdown.ts`
- Configurable shutdown timeout (default: 30s)
- Track in-flight tasks in base agents

**Dependencies:** STORY-006

---

#### STORY-008: Unit Test Coverage for Yi-Adapter

**Epic:** EPIC-002
**Priority:** Should Have
**Points:** 5

**User Story:**
As a framework developer
I want comprehensive unit tests for yi-adapter
So that protocol changes don't break existing implementations

**Acceptance Criteria:**
- [ ] Vitest configured for yi-adapter package
- [ ] Tests for HR Department (recruitment flow)
- [ ] Tests for Onboarding Specialist
- [ ] Tests for Base Agents (state transitions, delegation)
- [ ] Tests for Selection Strategies
- [ ] 70%+ line coverage

**Technical Notes:**
- Add vitest as dev dependency
- Use yi-echo for mock implementations
- Use ConsoleEventPublisher for event testing

**Dependencies:** None

---

### EPIC-003: Production Adapter Suite

#### STORY-009: Claude Streaming Support

**Epic:** EPIC-003
**Priority:** Should Have
**Points:** 5

**User Story:**
As a developer
I want Claude streaming support
So that long-running tasks provide incremental output

**Acceptance Criteria:**
- [ ] ClaudeContributor supports streaming responses
- [ ] Partial results emitted as events
- [ ] Final result aggregated correctly
- [ ] Timeout handling during streaming
- [ ] Integration test with real Claude API

**Technical Notes:**
- Use Anthropic SDK streaming API
- Emit intermediate events to Bloodbank
- Consider backpressure for fast streams

**Dependencies:** FR-012 (Claude Adapter core)

---

#### STORY-010: Claude Tool Use Integration

**Epic:** EPIC-003
**Priority:** Should Have
**Points:** 5

**User Story:**
As a developer
I want Claude tool use integration
So that agents can invoke external tools

**Acceptance Criteria:**
- [ ] Tool registry in ClaudeContributor
- [ ] Tools defined as Flume-compatible interfaces
- [ ] Tool calls handled during execution
- [ ] Tool results incorporated into response
- [ ] Error handling for tool failures

**Technical Notes:**
- Use Anthropic SDK tool_use feature
- Map Flume task context to tool definitions
- Consider tool execution timeouts

**Dependencies:** STORY-009

---

#### STORY-011: Claude Context Window Management

**Epic:** EPIC-003
**Priority:** Could Have
**Points:** 3

**User Story:**
As a developer
I want context window management
So that long conversations don't exceed limits

**Acceptance Criteria:**
- [ ] Track token usage per conversation
- [ ] Automatic truncation when approaching limit
- [ ] Configurable context retention strategy
- [ ] Warning events when truncating

**Technical Notes:**
- Use tiktoken or estimate from response
- Strategy: sliding window or summarization
- Emit context_truncated event

**Dependencies:** STORY-009

---

#### STORY-012: Letta Agent Persistence

**Epic:** EPIC-003
**Priority:** Should Have
**Points:** 5

**User Story:**
As a developer
I want Letta agent persistence
So that agents retain context across restarts

**Acceptance Criteria:**
- [ ] Save agent state to Letta server on shutdown
- [ ] Restore agent state on startup
- [ ] Handle missing agents gracefully (recreate)
- [ ] Correlation ID preserved across restarts
- [ ] Test persistence with yi-echo mock

**Technical Notes:**
- Use Letta server persistence API
- Agent IDs stored in boot sequence config
- Consider versioning for state schema

**Dependencies:** FR-013 (Letta Adapter core)

---

#### STORY-013: Letta Memory Block Management

**Epic:** EPIC-003
**Priority:** Could Have
**Points:** 3

**User Story:**
As a developer
I want Letta memory block management
So that I can control what agents remember

**Acceptance Criteria:**
- [ ] API to add/update/remove memory blocks
- [ ] Memory blocks typed (core, persona, knowledge)
- [ ] Memory visible in agent status
- [ ] Integration with team context

**Technical Notes:**
- Use Letta memory API
- Map to TeamContext structure
- Consider memory size limits

**Dependencies:** STORY-012

---

#### STORY-014: Integration Tests for Adapters

**Epic:** EPIC-003
**Priority:** Should Have
**Points:** 5

**User Story:**
As a framework developer
I want integration tests for all adapters
So that I can verify end-to-end functionality

**Acceptance Criteria:**
- [ ] Docker Compose for test infrastructure
- [ ] Integration test for yi-echo (baseline)
- [ ] Integration test for yi-claude (requires API key)
- [ ] Integration test for yi-letta (requires server)
- [ ] Tests verify full delegation chain
- [ ] Event correlation verified in tests

**Technical Notes:**
- Use vitest with longer timeouts
- CI can skip Claude/Letta tests (require secrets)
- Mock external services where needed

**Dependencies:** STORY-008

---

### EPIC-004: Persistence & Integration

#### STORY-015: PostgreSQL Schema and Migrations

**Epic:** EPIC-004
**Priority:** Should Have
**Points:** 5

**User Story:**
As an operator
I want a defined database schema
So that agent state and tasks can be persisted

**Acceptance Criteria:**
- [ ] SQL migration files in database/ directory
- [ ] Tables: agents, teams, tasks, work_results, artifacts, bloodbank_events
- [ ] Indexes on correlation_id, agent_id, timestamp
- [ ] Migration runner script
- [ ] Seeds for test data

**Technical Notes:**
- Use raw SQL migrations (no ORM dependency)
- Schema matches data model in architecture doc
- JSONB for flexible fields (context, output)

**Dependencies:** None

---

#### STORY-016: Agent State Persistence Queries

**Epic:** EPIC-004
**Priority:** Should Have
**Points:** 3

**User Story:**
As an operator
I want agent state persisted to PostgreSQL
So that I can recover from crashes

**Acceptance Criteria:**
- [ ] saveAgent() function
- [ ] loadAgent() function
- [ ] updateAgentState() function
- [ ] listAgentsByTeam() function
- [ ] Connection pooling implemented

**Technical Notes:**
- Extend `flume-core/src/db/postgres-client.ts`
- Use pg driver with pool
- Consider query builder (but avoid full ORM)

**Dependencies:** STORY-015

---

#### STORY-017: Task History Persistence

**Epic:** EPIC-004
**Priority:** Should Have
**Points:** 3

**User Story:**
As an operator
I want task history persisted
So that I can audit and debug agent work

**Acceptance Criteria:**
- [ ] saveTask() function
- [ ] updateTaskStatus() function
- [ ] saveWorkResult() function
- [ ] getTasksByCorrelation() for chain reconstruction
- [ ] Artifact storage

**Technical Notes:**
- Extend postgres-client.ts
- Index on correlation_id critical for performance
- Consider archival strategy for old tasks

**Dependencies:** STORY-015, STORY-016

---

#### STORY-018: Plane Issue Sync Implementation

**Epic:** EPIC-004
**Priority:** Could Have
**Points:** 5

**User Story:**
As a project manager
I want tasks synced to Plane
So that I can track agent work in my existing tools

**Acceptance Criteria:**
- [ ] Create issue from TaskPayload
- [ ] Update issue status on task state change
- [ ] Add comment with WorkResult summary
- [ ] Link issues to parent task issues
- [ ] Handle Plane API errors gracefully

**Technical Notes:**
- Extend `yi-adapter/src/sync/plane-sync.ts`
- Use PlaneClient for API calls
- Consider event-driven sync (consume from Bloodbank)

**Dependencies:** STORY-017

---

#### STORY-019: Jelmore Bidirectional Communication

**Epic:** EPIC-004
**Priority:** Could Have
**Points:** 3

**User Story:**
As a developer
I want bidirectional Zellij communication
So that terminal sessions can receive commands and return results

**Acceptance Criteria:**
- [ ] Send command to Zellij session
- [ ] Capture session output
- [ ] Parse output for work result
- [ ] Handle session timeout/disconnect
- [ ] Integration with SessionContributor

**Technical Notes:**
- Extend `yi-jelmore/src/client/jelmore-client.ts`
- Use Zellij CLI run command
- Consider file-based communication if CLI limited

**Dependencies:** FR-014 (Jelmore core)

---

## Sprint Allocation

### Sprint 1 (Weeks 1-2) - 24/25 points

**Goal:** Complete core protocol validation and establish robust Yi adapter foundation with health monitoring

**Stories:**
| Story | Title | Points | Priority | Epic |
|-------|-------|--------|----------|------|
| STORY-001 | TypeDoc Documentation | 3 | Must Have | EPIC-001 |
| STORY-002 | Runtime Type Validation | 3 | Should Have | EPIC-001 |
| STORY-003 | Edge Case State Handling | 2 | Should Have | EPIC-001 |
| STORY-004 | Round-Robin Selection | 3 | Must Have | EPIC-002 |
| STORY-006 | Health Check Endpoints | 3 | Must Have | EPIC-002 |
| STORY-007 | Graceful Shutdown | 3 | Must Have | EPIC-002 |
| STORY-008 | Yi-Adapter Unit Tests | 5 | Should Have | EPIC-002 |
| STORY-015 | PostgreSQL Schema | 2 | Should Have | EPIC-004 |

**Total:** 24 points / 25 capacity (96% utilization)

**Deliverables:**
- Fully documented Flume Core with runtime validation
- Robust Yi adapter with health checks and graceful shutdown
- Two selection strategies (FirstMatch + RoundRobin)
- Database schema ready for persistence
- 70%+ test coverage on yi-adapter

**Risks:**
- TypeDoc configuration complexity (mitigate: use standard config)
- Health check HTTP server conflicts (mitigate: configurable port)

---

### Sprint 2 (Weeks 3-4) - 25/25 points

**Goal:** Production-ready Claude and Letta adapters with persistence layer

**Stories:**
| Story | Title | Points | Priority | Epic |
|-------|-------|--------|----------|------|
| STORY-005 | Skill-Match Selection | 5 | Should Have | EPIC-002 |
| STORY-009 | Claude Streaming | 5 | Should Have | EPIC-003 |
| STORY-010 | Claude Tool Use | 5 | Should Have | EPIC-003 |
| STORY-012 | Letta Persistence | 5 | Should Have | EPIC-003 |
| STORY-016 | Agent State Queries | 3 | Should Have | EPIC-004 |
| STORY-017 | Task History Queries | 2 | Should Have | EPIC-004 |

**Total:** 25 points / 25 capacity (100% utilization)

**Deliverables:**
- Claude adapter with streaming and tool use
- Letta adapter with persistence across restarts
- Full persistence layer for agents and tasks
- Three selection strategies available

**Risks:**
- Claude API changes (mitigate: pin SDK version)
- Letta server availability (mitigate: mock for tests)

**Dependencies:**
- STORY-015 (Schema) must complete in Sprint 1
- Anthropic API key required for Claude tests

---

### Sprint 3 (Weeks 5-6) - 22/25 points

**Goal:** Integration completeness and optional enhancements

**Stories:**
| Story | Title | Points | Priority | Epic |
|-------|-------|--------|----------|------|
| STORY-011 | Claude Context Management | 3 | Could Have | EPIC-003 |
| STORY-013 | Letta Memory Blocks | 3 | Could Have | EPIC-003 |
| STORY-014 | Integration Tests | 5 | Should Have | EPIC-003 |
| STORY-018 | Plane Issue Sync | 5 | Could Have | EPIC-004 |
| STORY-019 | Jelmore Bidirectional | 3 | Could Have | EPIC-004 |

**Total:** 19 points / 25 capacity (76% utilization)

**Buffer:** 6 points for bug fixes, documentation, or scope changes

**Deliverables:**
- Full integration test suite
- Plane sync for task visibility
- Enhanced Claude context handling
- Letta memory management
- Jelmore human-in-the-loop ready

**Risks:**
- Plane API complexity (mitigate: start with read-only sync)
- Integration test flakiness (mitigate: retries, longer timeouts)

---

## Epic Traceability

| Epic ID | Epic Name | Stories | Total Points | Sprint |
|---------|-----------|---------|--------------|--------|
| EPIC-001 | Core Protocol Completion | STORY-001, 002, 003 | 8 points | Sprint 1 |
| EPIC-002 | Yi Adapter Layer Hardening | STORY-004, 005, 006, 007, 008 | 19 points | Sprint 1-2 |
| EPIC-003 | Production Adapter Suite | STORY-009, 010, 011, 012, 013, 014 | 26 points | Sprint 2-3 |
| EPIC-004 | Persistence & Integration | STORY-015, 016, 017, 018, 019 | 18 points | Sprint 1-3 |

---

## Functional Requirements Coverage

| FR ID | FR Name | Stories | Sprint |
|-------|---------|---------|--------|
| FR-001 | Corporate Hierarchy Types | STORY-001, 002 | 1 |
| FR-002 | Task Payload System | STORY-001, 002 | 1 |
| FR-003 | Agent State Machine | STORY-001, 003 | 1 |
| FR-004 | Work Result System | STORY-001, 002 | 1 |
| FR-005 | Bloodbank Event System | STORY-001 | 1 |
| FR-006 | HR Department | STORY-008 | 1 |
| FR-007 | Onboarding System | STORY-008 | 1 |
| FR-008 | Base Agent Implementations | STORY-008 | 1 |
| FR-009 | Selection Strategies | STORY-004, 005 | 1-2 |
| FR-010 | Bloodbank Publisher | STORY-006, 007 | 1 |
| FR-011 | Echo Adapter | STORY-014 | 3 |
| FR-012 | Claude Adapter | STORY-009, 010, 011 | 2-3 |
| FR-013 | Letta Adapter | STORY-012, 013 | 2-3 |
| FR-014 | Jelmore Integration | STORY-019 | 3 |
| FR-015 | PostgreSQL Persistence | STORY-015, 016, 017 | 1-2 |
| FR-016 | Plane Sync | STORY-018 | 3 |
| FR-017 | Boot Sequence | STORY-006, 007 | 1 |

---

## NFR Coverage

| NFR ID | NFR Name | Stories | Validation |
|--------|----------|---------|------------|
| NFR-001 | Performance < 50ms | STORY-008, 014 | Benchmark tests |
| NFR-002 | Reliable Event Delivery | STORY-007 | Shutdown test |
| NFR-003 | 50+ Concurrent Agents | STORY-008, 014 | Load test |
| NFR-004 | Type Safety | STORY-001, 002 | TypeDoc, validators |
| NFR-005 | 80% Test Coverage | STORY-008, 014 | Coverage report |
| NFR-006 | Node 20+ ESM | All stories | CI matrix |

---

## Risks and Mitigation

### High Risk

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Claude API breaking changes | Adapter fails | Low | Pin SDK version, integration tests |
| Letta server unavailable | Can't test adapter | Medium | Mock server for CI, fallback to echo |

### Medium Risk

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| PostgreSQL schema migration issues | Persistence blocked | Medium | Thorough migration testing |
| Integration test flakiness | CI failures | High | Retries, longer timeouts, isolation |

### Low Risk

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| TypeDoc configuration | Docs delayed | Low | Use standard config |
| Plane API complexity | Sync delayed | Medium | Start with read-only |

---

## Dependencies

### External Dependencies

| Dependency | Required For | Status |
|------------|--------------|--------|
| Anthropic API Key | Claude adapter tests | Must configure in CI secrets |
| Letta Server | Letta adapter tests | Self-hosted, available |
| RabbitMQ (Bloodbank) | All integration tests | Available at 192.168.1.12 |
| PostgreSQL | Persistence tests | Available in Docker Compose |
| Plane API | Plane sync | API key required |

### Internal Dependencies

```
STORY-015 (Schema) ← STORY-016 (Agent Queries) ← STORY-017 (Task Queries)
STORY-006 (Health) ← STORY-007 (Shutdown)
STORY-009 (Streaming) ← STORY-010 (Tool Use) ← STORY-011 (Context)
STORY-012 (Letta Persistence) ← STORY-013 (Memory Blocks)
```

---

## Definition of Done

For a story to be considered complete:
- [ ] Code implemented and committed to main branch
- [ ] Unit tests written and passing (coverage meets target)
- [ ] Integration tests passing (where applicable)
- [ ] Code reviewed (self-review acceptable for solo dev)
- [ ] TypeDoc/JSDoc for new public APIs
- [ ] No TypeScript errors (strict mode)
- [ ] Exported from package index.ts
- [ ] CLAUDE.md updated if architecture changed

---

## Team Capacity

**Team Composition:**
- 1 Senior Developer (delorenj)

**Sprint Parameters:**
- Sprint Length: 2 weeks (10 working days)
- Productive Hours/Day: 5 hours (accounting for meetings, context switching)
- Hours per Point: 2 hours (senior developer)
- Capacity: 50 hours / 2 = 25 points per sprint

**Velocity Tracking:**
- Sprint 1: TBD (first sprint, establishing baseline)
- Sprint 2: TBD
- Sprint 3: TBD

---

## Next Steps

**Immediate:** Begin Sprint 1

**Options:**
1. `/dev-story STORY-001` - Start with TypeDoc documentation
2. `/dev-story STORY-004` - Start with Round-Robin selection (more impactful)
3. `/dev-story STORY-015` - Start with PostgreSQL schema (unblocks persistence)

**Recommended:** Start with STORY-004 (Round-Robin Selection Strategy)
- High impact, Must Have priority
- Unblocks testing of manager delegation patterns
- Builds on existing codebase understanding

**Sprint Cadence:**
- Sprint Planning: Day 1
- Daily Standup: Self-check via `/workflow-status`
- Sprint Review: Day 10
- Sprint Retrospective: Day 10

---

**This plan was created using BMAD Method v6 - Phase 4 (Implementation Planning)**

*To begin implementation: Run `/dev-story STORY-004` to start the first story.*
