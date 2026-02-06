# Flume - GOD Document

> **Guaranteed Organizational Document** - Developer-facing reference for Flume
>
> **Last Updated**: 2026-02-02
> **Domain**: Agent Orchestration
> **Status**: Active

---

## Product Overview

Flume is the **implementation-agnostic protocol** that defines the structural hierarchy, communication interfaces, and role definitions for the 33GOD Agentic Pipeline. It does not know how an agent "thinks"--it only defines how agents work, report, and delegate within a corporate structure.

The name "Flume" evokes a water channel that directs flow--tasks flow down through the corporate hierarchy from Director to Manager to Contributor, results flow back up, and Bloodbank events flow out to observability systems.

**Philosophy: Anthropomorphism as Protocol**

Flume rejects standard AI terminology (chains, nodes, tools) in favor of strictly anthropomorphic roles. This is not merely cosmetic--it provides an intuitive mental model that scales with complexity:

- **Employees** (Agents) - The base unit, capable of reporting status
- **Contributors** (Individual Contributors) - Leaf nodes that execute work
- **Managers** (Tech Leads) - Can both delegate AND execute work
- **Directors** (VPs) - Pure orchestrators that only delegate

**Key Capabilities:**
- Pure TypeScript interfaces defining agent hierarchy and communication
- Framework-agnostic design allowing any LLM backend to participate
- Comprehensive state machine for agent lifecycle management
- Bloodbank event integration for full observability
- Task routing through selection strategies
- Integration with Plane for project management

---

## Architecture Position

```mermaid
graph TB
    subgraph "33GOD Pipeline"
        PLANE[Plane<br/>Task Management]
        BB[Bloodbank<br/>Event Bus]
        FLUME[Flume<br/>Protocol Layer]
        YI[Yi Adapters<br/>Letta/Claude/Agno]
        SDK[AI SDKs]
    end

    PLANE -->|"task.created"| BB
    BB -->|"flume.task.*"| FLUME
    FLUME -->|"defines interfaces"| YI
    YI -->|"wraps"| SDK
    YI -->|"yi.agent.*"| BB
    FLUME -->|"flume.result.*"| BB
```

**Role in Pipeline**: Flume is the "USB Port" of the 33GOD agentic system. It defines the shape of the connection--how agents plug in, how tasks flow, and how results are returned. It does NOT contain the logic for Letta, Agno, or LLM inference. To build a functioning agent, you must implement these interfaces or use the official adapter layer, Yi.

**Layered Architecture:**

1. **Flume Core** (Protocol Layer) - Pure TypeScript interfaces, zero runtime dependencies
2. **Yi Adapter** (Implementation Layer) - Opinionated base classes enforcing 33GOD conventions
3. **Yi Implementations** (Concrete Layer) - Framework-specific adapters (yi-echo, yi-claude, yi-letta, yi-jelmore)

---

## Event Contracts

### Bloodbank Events Emitted

| Event Name | Routing Key | Payload Schema | Trigger Condition |
|------------|-------------|----------------|-------------------|
| `flume.task.created` | `flume.task.created` | `TaskPayload` | New task enters the system |
| `flume.task.assigned` | `flume.task.assigned` | `{taskId, agentId, assignedBy}` | Task assigned to an agent |
| `flume.task.started` | `flume.task.started` | `{taskId, agentId}` | Agent begins execution |
| `flume.task.delegated` | `flume.task.delegated` | `{taskId, fromAgentId, toAgentId, depth}` | Manager delegates to subordinate |
| `flume.task.completed` | `flume.task.completed` | `{taskId, agentId, status, durationMs}` | Task execution finishes successfully |
| `flume.task.failed` | `flume.task.failed` | `{taskId, agentId, error}` | Task execution fails |
| `flume.task.blocked` | `flume.task.blocked` | `{taskId, agentId, blockers}` | Agent blocked on external dependency |
| `flume.artifact.created` | `flume.artifact.created` | `Artifact` | Agent produces decision/brief/checkpoint |

### Bloodbank Events Consumed

| Event Name | Routing Key | Handler | Purpose |
|------------|-------------|---------|---------|
| `flume.task.created` | `flume.task.#` | Task router | Route new tasks to appropriate director |
| `flume.agent.blocked` | `flume.agent.blocked` | Escalation handler | Trigger escalation workflow |

---

## Non-Event Interfaces

### TypeScript SDK (@flume/core)

The Flume protocol is published as an npm package with zero runtime dependencies:

```bash
npm install @flume/core
```

**Core Exports:**

```typescript
// Employee hierarchy
import { Employee, Contributor, Manager, Director, Delegator } from '@flume/core';

// Task types
import { TaskPayload, TaskState, RecruitmentRequest } from '@flume/core';

// Result types
import { WorkResult, ExecutionMetrics, WorkError, Artifact } from '@flume/core';

// State machine
import { AgentState, StateTransition, isValidTransition, VALID_TRANSITIONS } from '@flume/core';

// Events
import { BloodbankEvent, EventPublisher, EventSubscriber, createEvent, EVENT_CATEGORIES } from '@flume/core';

// Integrations
import { PlaneClient, PostgresClient } from '@flume/core';
```

### CLI Interface

_Flume is a library, not a CLI tool. Walking skeletons can be run via the monorepo:_

```bash
# Run echo demonstration
npm run dev

# Run walking skeleton (basic hierarchy test)
npm run skeleton

# Run with event emission
npm run skeleton:events

# Run with RabbitMQ integration
npm run skeleton:rabbitmq

# Run full integration (RabbitMQ + PostgreSQL)
npm run skeleton:full
```

### API Interface

_Flume is a library. For REST APIs, see downstream consumers like Holocene._

---

## Technical Deep-Dive

### Technology Stack

- **Language**: TypeScript 5.3+ with Strict Mode
- **Runtime**: Node.js 20+ with ESM Modules
- **Package Manager**: npm Workspaces (Monorepo)
- **Dependencies**: Zero (Flume Core is pure protocol)

### Architecture Pattern

**Hexagonal Architecture (Ports and Adapters)**

Flume Core defines the "ports" (interfaces), and Yi provides the "adapters" (implementations). This allows:

1. **Framework Agnosticism**: New LLM frameworks require only a new Yi adapter
2. **Testability**: yi-echo provides mock implementation for testing
3. **Loose Coupling**: Protocol changes don't require implementation changes (and vice versa)

### Key Implementation Details

#### The Corporate Hierarchy

```
Employee (base)
    |
    +-- Contributor (can execute)
    |       |
    +-- Delegator (can delegate)
    |       |
    +-- Manager (extends BOTH - Tech Lead style)
    |
    +-- Director (extends only Delegator - pure orchestrator)
```

**Employee** - Base interface all agents implement:
```typescript
interface Employee {
  id: string;
  name: string;
  role: string;
  state: AgentState;
  teamId: string;
  skills: string[];
  salary: number;  // Importance metric
  reportStatus(): Promise<EmployeeStatus>;
}
```

**Contributor** - Leaf nodes that do the actual work:
```typescript
interface Contributor extends Employee {
  canHandle(task: TaskPayload): boolean | Promise<boolean>;
  execute(task: TaskPayload): Promise<WorkResult>;
}
```

**Delegator** - Has subordinates and can assign work:
```typescript
interface Delegator {
  subordinates: Employee[];
  recruit(employee: Employee): void;
  release(employeeId: string): void;
  delegate(task: TaskPayload): Promise<WorkResult>;
}
```

**Manager** - Can both delegate AND execute (Tech Lead):
```typescript
interface Manager extends Contributor, Delegator {}
```

**Director** - Pure orchestrator (VP):
```typescript
interface Director extends Employee, Delegator {}
```

#### Agent State Machine

```
                                 +-----------+
                                 | terminated|
                                 +-----------+
                                       ^
                                       |
+-------------+    +------------+    +------+    +----------+
|initializing |--->| onboarding |--->| idle |<-->| working  |
+-------------+    +------------+    +------+    +----------+
                                       |  ^        |
                                       v  |        v
                                  +--------+  +---------+
                                  | blocked|  | reviewing|
                                  +--------+  +---------+
                                       |
                                       v
                                  +---------+
                                  | errored |
                                  +---------+
```

**State Descriptions:**
- `initializing` - Being created by HR
- `onboarding` - Receiving context injection
- `idle` - Ready for work (at desk, waiting)
- `working` - Actively executing a task
- `delegating` - Waiting on subordinate to complete
- `blocked` - Waiting on external dependency
- `reviewing` - Peer review / QA phase
- `errored` - Recoverable error state
- `terminated` - Permanently stopped (fired/quit)

**Valid Transitions:**
```typescript
const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  initializing: ['onboarding', 'errored', 'terminated'],
  onboarding: ['idle', 'errored', 'terminated'],
  idle: ['working', 'delegating', 'blocked', 'errored', 'terminated'],
  working: ['idle', 'blocked', 'reviewing', 'errored', 'terminated'],
  delegating: ['idle', 'blocked', 'errored', 'terminated'],
  blocked: ['idle', 'working', 'delegating', 'errored', 'terminated'],
  reviewing: ['idle', 'errored', 'terminated'],
  errored: ['idle', 'terminated'],
  terminated: [], // Terminal state
};
```

#### Task Flow

Tasks flow through the hierarchy following corporate delegation patterns:

```
1. Human creates task in Plane
       |
       v
2. Task synced to 33GOD (flume.task.created)
       |
       v
3. Director receives high-level goal
       |
       v
4. Director delegates to Manager (flume.task.delegated)
       |
       v
5. Manager either:
   - Delegates to Contributor, OR
   - Executes directly (IC mode)
       |
       v
6. Contributor executes task (flume.task.started)
       |
       v
7. Result bubbles up (flume.task.completed)
       |
       v
8. Plane synced with status update
```

#### Selection Strategies

Managers use selection strategies to choose which subordinate handles a task:

```typescript
interface SelectionStrategy {
  name: string;
  select(task: TaskPayload, candidates: Employee[]): Promise<Employee | null>;
}
```

**Built-in Strategies:**

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `FirstMatchSelection` | Returns first capable candidate | Deterministic testing |
| `RoundRobinSelection` | Rotates through capable candidates | Load distribution |
| `SkillMatchSelection` | Highest skill overlap wins | Capability matching |
| `LLMDrivenSelection` | Ask manager's LLM to pick | Production (future) |

#### Three-Tier Onboarding

New agents receive context through three tiers:

1. **Project Context** (from Director)
   - Conversation threads, north stars, KPIs, timelines, sprint goals

2. **Tech Context** (from Learning & Development)
   - Memories, lessons learned, skills, MCP servers, tools

3. **Company Context** (from CEO/Board)
   - Coding standards, infrastructure details, security policies

```typescript
interface TeamContext {
  teamId: string;
  missionStatement: string;
  sharedKnowledgeBaseId: string;
  accessLevel: 'intern' | 'contractor' | 'full-time' | 'executive';
  projectContext?: ProjectContext;
  techContext?: TechContext;
  companyContext?: CompanyContext;
}
```

### Data Models

#### TaskPayload

```typescript
interface TaskPayload {
  id: string;                    // Unique task ID
  correlationId: string;         // Links related tasks
  parentTaskId?: string;         // For delegation chains
  objective: string;             // Human-readable goal
  context: Record<string, unknown>;  // Domain-specific data
  priority?: number;             // Higher = more important
  createdAt: string;            // ISO timestamp
  timeout?: number;             // Max execution time (ms)
  tags?: string[];              // Routing/filtering
  externalId?: string;          // Plane issue ID
  planeWorkspace?: string;      // Plane workspace slug
  planeProjectId?: string;      // Plane project ID
}
```

#### WorkResult

```typescript
interface WorkResult {
  status: 'success' | 'failure' | 'delegated' | 'blocked' | 'timeout';
  output: unknown;              // Task-specific result
  metrics: ExecutionMetrics;
  error?: WorkError;
  delegatedTo?: string;         // If delegated
  artifacts?: Artifact[];       // Produced documents
  completedAt: string;
}

interface ExecutionMetrics {
  durationMs: number;
  tokensUsed?: number;
  costUsd?: number;
  retries?: number;
  delegationDepth?: number;
}
```

### Configuration

Flume is configured through environment variables:

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/33god

# Message Broker (Bloodbank)
RABBITMQ_URL=amqp://user:pass@host:5672

# Plane Integration
PLANE_API_URL=https://plane.delo.sh
PLANE_API_KEY=plane_api_xxxxx
PLANE_WORKSPACE=33god
```

---

## Development

### Repository Structure

```
flume/
├── packages/
│   ├── flume-core/           # Protocol types (zero deps)
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── employee.ts   # Employee hierarchy
│   │   │   │   ├── task.ts       # TaskPayload, TaskState
│   │   │   │   ├── state.ts      # AgentState, transitions
│   │   │   │   ├── result.ts     # WorkResult, Artifact
│   │   │   │   └── events.ts     # BloodbankEvent
│   │   │   ├── plane/
│   │   │   │   └── plane-client.ts
│   │   │   ├── db/
│   │   │   │   └── postgres-client.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── yi-adapter/           # Base implementation
│   │   ├── src/
│   │   │   ├── agents/
│   │   │   │   ├── base-contributor.ts
│   │   │   │   ├── base-manager.ts
│   │   │   │   └── base-director.ts
│   │   │   ├── hr/
│   │   │   │   ├── hr-department.ts
│   │   │   │   └── onboarding-specialist.ts
│   │   │   ├── selection/
│   │   │   │   ├── first-match.ts
│   │   │   │   ├── round-robin.ts
│   │   │   │   ├── skill-match.ts
│   │   │   │   └── llm-driven.ts
│   │   │   ├── memory/
│   │   │   │   ├── strategy.ts
│   │   │   │   └── team-context.ts
│   │   │   ├── events/
│   │   │   │   └── bloodbank-publisher.ts
│   │   │   ├── sync/
│   │   │   │   └── plane-sync.ts
│   │   │   └── boot/
│   │   │       ├── boot-sequence.ts
│   │   │       └── shutdown.ts
│   │   └── package.json
│   │
│   ├── yi-echo/              # Test adapter (no LLM)
│   │   ├── src/
│   │   │   ├── agents/
│   │   │   │   ├── echo-contributor.ts
│   │   │   │   ├── echo-manager.ts
│   │   │   │   ├── echo-director.ts
│   │   │   │   └── echo-failing.ts
│   │   │   ├── factory/
│   │   │   │   └── echo-factory.ts
│   │   │   └── memory/
│   │   │       └── echo-memory.ts
│   │   └── package.json
│   │
│   ├── yi-claude/            # Claude API adapter
│   ├── yi-letta/             # Letta agent adapter
│   └── yi-jelmore/           # Zellij terminal adapter
│
├── database/
│   ├── schema.sql            # Full schema
│   └── migrations/           # Incremental migrations
│
├── docs/
│   └── architecture-*.md
│
├── package.json              # Workspace root
└── GOD.md                    # This document
```

### Setup

```bash
# Clone the repository
git clone https://github.com/33GOD/flume.git
cd flume

# Install dependencies
npm install

# Set up database (if using persistence)
psql -h 192.168.1.12 -U delorenj -d 33god -f database/schema.sql
```

### Running Locally

```bash
# Run echo demonstration
npm run dev

# Run with events (requires RabbitMQ)
export RABBITMQ_URL=amqp://guest:guest@localhost:5672
npm run skeleton:events

# Run full integration (requires RabbitMQ + PostgreSQL)
export DATABASE_URL=postgresql://delorenj:xxx@192.168.1.12:5432/33god
npm run skeleton:full
```

### Testing

```bash
# Run all unit tests
npm test

# Run integration tests (requires Docker services)
npm run test:integration

# Run specific adapter tests
npm run test:integration:echo
npm run test:integration:claude
npm run test:integration:letta
```

---

## Deployment

Flume is a library published to npm. Consumers include:

- **Yi Adapters** - Import `@flume/core` for protocol types
- **Holocene** - Import for agent state queries
- **Custom Orchestrators** - Implement Flume interfaces directly

### Publishing

```bash
# Build all packages
npm run build

# Publish to npm (with changesets)
npx changeset publish
```

### Version Strategy

- **Major**: Breaking changes to protocol interfaces
- **Minor**: New features, new event types
- **Patch**: Bug fixes, documentation updates

---

## References

- **Domain Doc**: `docs/domains/agent-orchestration/GOD.md`
- **System Doc**: `docs/GOD.md`
- **Source**: `flume/`
- **Architecture Design**: `flume/docs/architecture-flume-2026-01-05.md`
- **Original Ideation**: `flume/docs/Flume_and_Yi_Ideation.md`
- **Database Schema**: `flume/database/schema.sql`
- **Plane Instance**: https://plane.delo.sh/33god/

---

## Appendix A: Complete Event Catalog

### Yi Agent Lifecycle Events

| Event | Description | Data |
|-------|-------------|------|
| `yi.agent.created` | New agent instantiated | `{agentId, name, role, teamId}` |
| `yi.agent.onboarding` | Agent receiving context | `{agentId, contextLevel}` |
| `yi.agent.state.changed` | State transition | `{agentId, fromState, toState, trigger}` |
| `yi.agent.terminated` | Agent shut down | `{agentId, reason}` |

### Flume Task Events

| Event | Description | Data |
|-------|-------------|------|
| `flume.task.created` | Task enters system | `TaskPayload` |
| `flume.task.assigned` | Task assigned | `{taskId, agentId, assignedBy}` |
| `flume.task.started` | Execution begins | `{taskId, agentId}` |
| `flume.task.delegated` | Manager delegates | `{taskId, fromAgentId, toAgentId, depth}` |
| `flume.task.completed` | Task succeeds | `{taskId, agentId, status, durationMs}` |
| `flume.task.failed` | Task fails | `{taskId, agentId, error}` |
| `flume.task.blocked` | Agent blocked | `{taskId, agentId, blockers}` |

### Selection Events

| Event | Description | Data |
|-------|-------------|------|
| `yi.selection.started` | Selection begins | `{taskId, managerId, candidateCount}` |
| `yi.selection.candidate.evaluated` | Candidate checked | `{taskId, candidateId, canHandle}` |
| `yi.selection.completed` | Selection done | `{taskId, selectedAgentId, strategyUsed}` |

### Team Events

| Event | Description | Data |
|-------|-------------|------|
| `yi.team.recruit.requested` | Manager needs help | `RecruitmentRequest` |
| `yi.team.member.added` | Agent joins team | `{teamId, agentId, managerId}` |
| `yi.team.member.removed` | Agent leaves team | `{teamId, agentId, reason}` |

### Artifact Events

| Event | Description | Data |
|-------|-------------|------|
| `flume.artifact.created` | Document produced | `Artifact` |

---

## Appendix B: Database Schema Summary

The Flume/Yi schema in PostgreSQL includes:

| Table | Purpose |
|-------|---------|
| `projects` | Flume-managed projects with directors |
| `teams` | Yi-managed teams with shared knowledge |
| `employees` | Yi nodes (agents) with skills and state |
| `tasks` | Flume tasks synced with Plane |
| `memory_shards` | Agent memory pointers |
| `agent_state_history` | Full state transition audit |
| `sessions` | Jelmore execution sessions |
| `artifacts` | Decision/brief/checkpoint documents |
| `bloodbank_events` | Event sourcing archive |
| `daily_standups` | Async status reports |
| `peer_reviews` | Performance evaluations |

**Key Views:**
- `v_agent_state_distribution` - Active agents by state
- `v_task_throughput` - Task completion by agent
- `v_delegation_depth` - Delegation chain analysis
- `v_team_composition` - Team structure overview

---

## Appendix C: Implementing a Custom Agent

To create a custom agent without using Yi adapters:

```typescript
import type { Contributor, TaskPayload, WorkResult, EmployeeStatus, AgentState } from '@flume/core';

class MyCustomAgent implements Contributor {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly teamId: string;
  readonly skills: string[];
  readonly salary: number;

  private _state: AgentState = 'idle';

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.role = 'Custom Agent';
    this.teamId = 'custom-team';
    this.skills = ['custom'];
    this.salary = 50000;
  }

  get state(): AgentState {
    return this._state;
  }

  async reportStatus(): Promise<EmployeeStatus> {
    return {
      state: this._state,
      message: 'Ready for work',
      timestamp: new Date().toISOString(),
    };
  }

  canHandle(task: TaskPayload): boolean {
    return this._state === 'idle';
  }

  async execute(task: TaskPayload): Promise<WorkResult> {
    this._state = 'working';
    const startTime = Date.now();

    try {
      // Your custom logic here
      const output = await this.doWork(task);

      this._state = 'idle';
      return {
        status: 'success',
        output,
        metrics: { durationMs: Date.now() - startTime },
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      this._state = 'errored';
      return {
        status: 'failure',
        output: null,
        metrics: { durationMs: Date.now() - startTime },
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        completedAt: new Date().toISOString(),
      };
    }
  }

  private async doWork(task: TaskPayload): Promise<unknown> {
    // Implement your agent's logic
    return { result: `Processed: ${task.objective}` };
  }
}
```

---

## Appendix D: Glossary

| Term | Definition |
|------|------------|
| **Employee** | Base agent interface; can report status |
| **Contributor** | Leaf node agent that executes tasks |
| **Manager** | Agent that can both delegate and execute |
| **Director** | Pure orchestrator; only delegates |
| **Delegator** | Interface for having subordinates |
| **TaskPayload** | Unit of work flowing through the system |
| **WorkResult** | Structured response from task execution |
| **AgentState** | Lifecycle state of an agent |
| **Selection Strategy** | Algorithm for choosing which subordinate handles a task |
| **Onboarding** | Process of injecting context into new agents |
| **Team Context** | Knowledge packet given to agents during onboarding |
| **Yi** | Opinionated adapter layer wrapping AI SDKs |
| **Echo** | Mock implementation for testing without LLM costs |
| **Bloodbank** | RabbitMQ event bus for 33GOD ecosystem |
| **Plane** | External project management system |
