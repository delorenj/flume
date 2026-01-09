---
modified: 2026-01-03T07:12:16-05:00
---
# Flume & Yi Architecture
## 33GOD Agent Orchestration System

**Status:** Architecture Review
**Date:** 2026-01-03
**Authors:** Jarad DeLorenzo, Claude (Architecture Review)

---

## 1. Executive Summary

This document defines the architecture for **Flume** (the agent tree protocol) and **Yi** (the opinionated adapter layer) within the 33GOD ecosystem. It integrates with existing components:

- **Bloodbank**: Event bus for all state changes
- **Plane**: External task management UI/API
- **Holocene**: Observability dashboard
- **iMi**: Worktree management
- **Jelmore**: Session execution layer
- **Agent Forge**: Agent creation (HR)

---

## 2. Core Interfaces (Flume Protocol)

### 2.1 Philosophy

Flume defines **what** agents are and **how** they communicate. It knows nothing about Letta, Agno, or any specific implementation. It speaks only in corporate hierarchy terms.

### 2.2 Base Types

```typescript
// ═══════════════════════════════════════════════════════════════
// FLUME CORE PROTOCOL - Implementation Agnostic
// ═══════════════════════════════════════════════════════════════

/**
 * Every Bloodbank event must be traceable
 */
export interface Traceable {
    correlationId: string;      // Links related events across the pipeline
    causationId?: string;       // What event caused this one
    timestamp: Date;
    source: string;             // Component that emitted (e.g., "yi.manager.arch-001")
}

/**
 * Task payload - the unit of work in Flume
 */
export interface TaskPayload extends Traceable {
    id: string;
    parentTaskId?: string;      // For recursive delegation
    planeIssueId?: string;      // Link to Plane work-item
    
    // Content (processed through PM → Architect → QA pipeline)
    rawTask?: string;           // Original markdown
    title: string;
    description: string;
    requirements?: string[];
    plan?: string;
    acceptanceCriteria?: string[];
    
    // Matching
    idealCandidate?: string;    // Skills/traits needed
    priority: 'critical' | 'high' | 'medium' | 'low';
    
    // Context
    context: Record<string, any>;
    repoId?: string;
    projectId?: string;
}

/**
 * Work result - returned from task execution
 */
export interface WorkResult extends Traceable {
    taskId: string;
    status: 'success' | 'failure' | 'delegated' | 'blocked' | 'timeout';
    output: any;
    
    // Observability
    metrics: {
        durationMs: number;
        tokenCount?: number;
        delegationDepth: number;
        retryCount: number;
    };
    
    // Artifacts produced
    artifacts?: {
        type: 'decision' | 'brief' | 'checkpoint' | 'recommendation' | 'code';
        id: string;
    }[];
    
    // Error handling
    error?: {
        code: string;
        message: string;
        recoverable: boolean;
        suggestedAction?: string;
    };
}
```

### 2.3 Agent States

```typescript
/**
 * Agent lifecycle states for observability
 */
export type AgentState = 
    | 'initializing'    // Being created by HR
    | 'onboarding'      // Receiving context injection
    | 'idle'            // Ready for work
    | 'working'         // Actively executing task
    | 'delegating'      // Waiting on subordinate
    | 'blocked'         // Waiting on external dependency
    | 'reviewing'       // Peer review / QA
    | 'errored'         // Recoverable error state
    | 'terminated';     // Permanently stopped

/**
 * State transition with Bloodbank event emission
 */
export interface StateTransition extends Traceable {
    agentId: string;
    fromState: AgentState;
    toState: AgentState;
    reason: string;
    taskId?: string;
}
```

### 2.4 Agent Role Hierarchy

```typescript
/**
 * Base capability - all agents can report status
 */
export interface Employee {
    id: string;
    role: string;
    state: AgentState;
    currentTaskId?: string;
    
    // Identity
    agentType: 'letta' | 'agno' | 'claude' | 'smolagents' | 'custom';
    personality?: string;
    background?: string;
    
    // Observability
    reportStatus(): Promise<EmployeeStatus>;
    getStateHistory(): Promise<StateTransition[]>;
}

export interface EmployeeStatus {
    state: AgentState;
    currentTask?: TaskPayload;
    uptime: number;
    tasksCompleted: number;
    tasksFailed: number;
    lastActivity: Date;
}

/**
 * Individual Contributor - executes tasks directly
 */
export interface Contributor extends Employee {
    skills: string[];
    domainsOfExpertise: string[];    // Injected via context
    domainsOfExperience: string[];   // Learned via sessions
    
    // Core capability
    canHandle(task: TaskPayload): Promise<CanHandleResult>;
    execute(task: TaskPayload): Promise<WorkResult>;
}

export interface CanHandleResult {
    canHandle: boolean;
    confidence: number;          // 0-1 confidence score
    reasoning?: string;          // Why this agent thinks it can/can't handle
    estimatedDuration?: number;  // MS estimate
}

/**
 * Delegator - can assign work to subordinates
 */
export interface Delegator extends Employee {
    subordinates: Employee[];
    
    // Delegation capability
    delegate(task: TaskPayload): Promise<WorkResult>;
    
    // Team management
    recruit(agent: Employee): Promise<void>;
    dismiss(agentId: string, reason: string): Promise<void>;
    getTeamStatus(): Promise<EmployeeStatus[]>;
}

/**
 * Manager - can BOTH delegate AND execute (like a Tech Lead)
 */
export interface Manager extends Contributor, Delegator {
    // Managers can choose to do IC work or delegate
    // Selection strategy is implementation-specific (Yi layer)
}

/**
 * Director - can ONLY delegate (pure orchestrator)
 */
export interface Director extends Delegator {
    // Directors never execute tasks themselves
    // They only orchestrate their team
}
```

---

## 3. Yi Adapter Layer

### 3.1 Philosophy

Yi is the **opinionated wrapper** that:
1. Adapts Letta/Agno/etc to the Flume protocol
2. Enforces 33GOD conventions (memory strategy, Bloodbank events)
3. Provides selection strategies for delegation
4. Integrates with HR (Agent Forge) and Onboarding

### 3.2 Memory Strategy

```typescript
/**
 * Yi enforces unified memory management across all agent types
 */
export interface YiMemoryStrategy {
    // Sync shared team context
    syncTeamContext(teamId: string, context: TeamContext): Promise<void>;
    
    // Individual agent memory operations
    injectMemory(agentId: string, memory: MemoryShard): Promise<void>;
    recallMemory(agentId: string, query: string): Promise<any>;
    
    // Checkpoint operations (for rollback)
    createCheckpoint(agentId: string): Promise<string>;
    restoreCheckpoint(agentId: string, checkpointId: string): Promise<void>;
}

export interface MemoryShard {
    id: string;
    type: 'qdrant' | 'agentfile' | 'neo4j' | 'letta-core' | 'custom';
    pointer: string;    // URI to actual memory location
    created: Date;
    isActive: boolean;
}

export interface TeamContext {
    teamId: string;
    missionStatement: string;
    sharedKnowledgeBaseId: string;
    protocols: string[];         // Team-specific guidelines
    accessLevel: 'intern' | 'full-time' | 'senior' | 'lead' | 'executive';
}
```

### 3.3 Selection Strategy

```typescript
/**
 * How a Manager/Director picks which subordinate handles a task
 */
export interface SelectionStrategy {
    name: string;
    
    select(
        task: TaskPayload, 
        candidates: Contributor[],
        context: SelectionContext
    ): Promise<SelectionResult>;
}

export interface SelectionContext {
    managerAgentId: string;
    teamHistory: TaskAssignment[];    // Recent assignments
    urgency: 'immediate' | 'normal' | 'background';
}

export interface SelectionResult {
    selectedAgentId: string;
    reasoning: string;              // For observability
    confidence: number;
    alternativeCandidates: {
        agentId: string;
        confidence: number;
    }[];
}

// Built-in strategies
export class LLMDrivenSelection implements SelectionStrategy {
    name = 'llm-driven';
    // Ask the manager's underlying LLM to pick
}

export class FirstMatchSelection implements SelectionStrategy {
    name = 'first-match';
    // Iterate until canHandle returns true
}

export class ConfidenceWeightedSelection implements SelectionStrategy {
    name = 'confidence-weighted';
    // Pick highest confidence from canHandle results
}

export class RoundRobinSelection implements SelectionStrategy {
    name = 'round-robin';
    // Rotate through capable agents
}
```

### 3.4 HR Department (Agent Forge Integration)

```typescript
/**
 * HR handles agent lifecycle: creation, onboarding, termination
 */
export interface HRDepartment {
    // Recruitment
    fulfillRequest(req: RecruitmentRequest): Promise<Employee>;
    findCandidates(requirements: string[]): Promise<AgentBlueprint[]>;
    
    // Lifecycle
    terminate(agentId: string, reason: string): Promise<void>;
    reassign(agentId: string, newTeamId: string): Promise<void>;
    
    // Performance
    conductReview(agentId: string): Promise<PeerReview>;
}

export interface RecruitmentRequest {
    requiredSkills: string[];
    preferredAgentType?: string;
    teamId: string;
    reportingToId: string;
    role: 'contributor' | 'manager' | 'director';
    urgency: 'immediate' | 'normal' | 'background';
}

export interface AgentBlueprint {
    // Output from Agent Forge (BMAD method)
    id: string;
    agentType: string;
    systemPrompt: string;
    skills: string[];
    personality: string;
    background: string;
}
```

### 3.5 Onboarding Specialist

```typescript
/**
 * Onboarding injects context into raw agents
 */
export interface OnboardingSpecialist {
    orient(
        rawAgent: Employee, 
        context: TeamContext,
        memoryShard?: MemoryShard
    ): Promise<Employee>;
    
    verifyReadiness(agentId: string): Promise<OnboardingResult>;
}

export interface OnboardingResult {
    ready: boolean;
    verificationSteps: {
        step: string;
        passed: boolean;
        details?: string;
    }[];
    failureReason?: string;
}
```

---

## 4. Bloodbank Event Integration

### 4.1 Event Categories

All state changes emit Bloodbank events. Events follow the pattern:
`{component}.{entity}.{action}`

```typescript
// Agent lifecycle events
'yi.agent.created'
'yi.agent.onboarding.started'
'yi.agent.onboarding.completed'
'yi.agent.onboarding.failed'
'yi.agent.state.changed'
'yi.agent.terminated'

// Task events
'flume.task.created'
'flume.task.assigned'
'flume.task.accepted'
'flume.task.delegated'
'flume.task.started'
'flume.task.completed'
'flume.task.failed'
'flume.task.blocked'
'flume.task.unblocked'

// Selection events (for observability)
'yi.selection.started'
'yi.selection.completed'
'yi.selection.candidate.evaluated'

// Team events
'yi.team.recruit.requested'
'yi.team.member.added'
'yi.team.member.removed'

// Artifact events
'flume.artifact.decision.created'
'flume.artifact.brief.created'
'flume.artifact.checkpoint.created'
'flume.artifact.recommendation.created'
```

### 4.2 Event Schema

```typescript
export interface BloodbankEvent extends Traceable {
    event: string;                    // e.g., 'yi.agent.state.changed'
    version: string;                  // Schema version
    data: Record<string, any>;
    
    // Routing
    exchange: string;                 // '33god.events'
    routingKey: string;               // e.g., 'yi.agent.state'
}

// Example: State change event
const stateChangeEvent: BloodbankEvent = {
    event: 'yi.agent.state.changed',
    version: '1.0.0',
    correlationId: 'corr-123',
    causationId: 'task-456',
    timestamp: new Date(),
    source: 'yi.manager.arch-001',
    exchange: '33god.events',
    routingKey: 'yi.agent.state',
    data: {
        agentId: 'arch-001',
        fromState: 'idle',
        toState: 'working',
        taskId: 'task-789',
        reason: 'Accepted task for implementation'
    }
};
```

---

## 5. Plane Integration Strategy

### 5.1 Hybrid Approach

Use Plane as the **UI layer** for human interaction while 33GOD maintains **shadow records** with extended metadata.

```
┌─────────────────────────────────────────────────────────────┐
│                        Human Users                           │
│                    (via Plane UI/API)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      Plane Instance                          │
│                    plane.delo.sh                             │
│  - Work Items (Issues)                                       │
│  - Cycles (Sprints)                                          │
│  - Modules                                                   │
│  - Native UI                                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │ Webhooks / API Sync
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   33GOD Shadow Layer                         │
│  - Extended Task metadata (IdealCandidate, RawTask, etc.)   │
│  - Custom Lifecycle state machines                           │
│  - Agent assignment tracking                                 │
│  - Bloodbank event emission                                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                       Bloodbank                              │
│           Event Bus (RabbitMQ / Commands & Events)           │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Sync Strategy

```typescript
/**
 * Plane sync service - bidirectional sync between Plane and 33GOD
 */
export interface PlaneSyncService {
    // Plane → 33GOD
    onPlaneIssueCreated(planeIssue: PlaneWorkItem): Promise<void>;
    onPlaneIssueUpdated(planeIssue: PlaneWorkItem): Promise<void>;
    
    // 33GOD → Plane
    syncTaskToPlane(task: TaskPayload): Promise<string>;  // Returns Plane issue ID
    updatePlaneStatus(taskId: string, status: string): Promise<void>;
    
    // Comments/Activity
    addPlaneComment(issueId: string, comment: string): Promise<void>;
}
```

---

## 6. Global 33GOD Database Schema

### 6.1 Design Principles

1. **Single Source of Truth**: Each entity has one canonical table
2. **Event Sourcing Ready**: All state changes logged
3. **Plane Integration**: Foreign keys to Plane IDs where applicable
4. **Observability First**: Rich metadata for Holocene queries

### 6.2 Core Schema

```sql
-- ═══════════════════════════════════════════════════════════════
-- 33GOD GLOBAL SCHEMA
-- PostgreSQL 15+
-- ═══════════════════════════════════════════════════════════════

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ───────────────────────────────────────────────────────────────
-- ENUMS
-- ───────────────────────────────────────────────────────────────

CREATE TYPE agent_type AS ENUM (
    'letta', 'agno', 'claude', 'smolagents', 'custom'
);

CREATE TYPE agent_state AS ENUM (
    'initializing', 'onboarding', 'idle', 'working', 
    'delegating', 'blocked', 'reviewing', 'errored', 'terminated'
);

CREATE TYPE agent_role AS ENUM (
    'contributor', 'manager', 'director'
);

CREATE TYPE task_priority AS ENUM (
    'critical', 'high', 'medium', 'low'
);

CREATE TYPE task_state AS ENUM (
    'draft', 'open', 'ready', 'assigned', 'in_progress', 
    'blocked', 'in_review', 'done', 'closed'
);

CREATE TYPE artifact_type AS ENUM (
    'decision', 'brief', 'checkpoint', 'recommendation', 'code'
);

CREATE TYPE memory_type AS ENUM (
    'qdrant', 'agentfile', 'neo4j', 'letta_core', 'custom'
);

-- ───────────────────────────────────────────────────────────────
-- CORE TABLES
-- ───────────────────────────────────────────────────────────────

-- Projects (Flume managed)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    plane_project_id VARCHAR(255),  -- Link to Plane
    
    -- Leadership
    director_id UUID,               -- FK to employees
    project_manager_id UUID,
    engineering_director_id UUID,
    qa_director_id UUID,
    
    -- Metadata
    prd_path VARCHAR(500),
    roadmap_path VARCHAR(500),
    mvp_acceptance_criteria JSONB,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Repositories (iMi managed)
CREATE TABLE repos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id),
    name VARCHAR(255) NOT NULL,
    github_url VARCHAR(500),
    local_path VARCHAR(500) NOT NULL,
    
    -- Leadership
    lead_architect_id UUID,
    project_manager_id UUID,
    qa_lead_id UUID,
    
    -- Metadata
    prd_path VARCHAR(500),
    stack VARCHAR(100),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Teams (Yi managed)
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    project_id UUID REFERENCES projects(id),
    
    mission_statement TEXT,
    shared_knowledge_base_id VARCHAR(255),
    protocols JSONB,
    
    manager_id UUID,  -- FK to employees
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employees (Yi Nodes)
CREATE TABLE employees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Identity
    name VARCHAR(255) NOT NULL,
    role agent_role NOT NULL,
    agent_type agent_type NOT NULL,
    
    -- Personality (from Agent Forge)
    personality TEXT,
    background TEXT,
    system_prompt TEXT,
    
    -- State
    state agent_state NOT NULL DEFAULT 'initializing',
    current_task_id UUID,
    
    -- Team membership
    team_id UUID REFERENCES teams(id),
    reports_to_id UUID REFERENCES employees(id),
    
    -- Metrics
    salary INTEGER DEFAULT 50000,  -- Anthropomorphized importance
    tasks_completed INTEGER DEFAULT 0,
    tasks_failed INTEGER DEFAULT 0,
    
    -- Skills
    skills TEXT[],
    domains_of_expertise TEXT[],   -- Injected
    domains_of_experience TEXT[],  -- Learned
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    terminated_at TIMESTAMPTZ
);

-- Memory Shards
CREATE TABLE memory_shards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID REFERENCES employees(id) NOT NULL,
    
    type memory_type NOT NULL,
    pointer VARCHAR(500) NOT NULL,  -- URI to actual storage
    is_active BOOLEAN DEFAULT false,
    
    metadata JSONB,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deactivated_at TIMESTAMPTZ
);

-- Tasks (Flume managed, synced with Plane)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Plane integration
    plane_issue_id VARCHAR(255),
    plane_workspace_slug VARCHAR(255),
    plane_project_id VARCHAR(255),
    
    -- Hierarchy
    parent_task_id UUID REFERENCES tasks(id),
    project_id UUID REFERENCES projects(id),
    repo_id UUID REFERENCES repos(id),
    
    -- Content pipeline
    raw_task TEXT,                  -- Original markdown
    title VARCHAR(500) NOT NULL,
    description TEXT,
    requirements JSONB,             -- PM processed
    plan TEXT,                      -- Architect processed
    acceptance_criteria JSONB,      -- QA processed
    
    -- State
    state task_state NOT NULL DEFAULT 'draft',
    priority task_priority NOT NULL DEFAULT 'medium',
    lifecycle_type VARCHAR(100) DEFAULT 'standard',
    
    -- Assignment
    assignee_id UUID REFERENCES employees(id),
    active_employee_id UUID REFERENCES employees(id),
    ideal_candidate TEXT,
    
    -- Tracking
    correlation_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    
    created_by_employee_id UUID REFERENCES employees(id),
    created_by_human VARCHAR(255),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Task Contributors (many-to-many)
CREATE TABLE task_contributors (
    task_id UUID REFERENCES tasks(id) NOT NULL,
    employee_id UUID REFERENCES employees(id) NOT NULL,
    
    contribution_type VARCHAR(100),  -- 'primary', 'reviewer', 'pair'
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    
    PRIMARY KEY (task_id, employee_id)
);

-- Sessions (Jelmore managed)
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Context
    task_id UUID REFERENCES tasks(id),
    employee_id UUID REFERENCES employees(id) NOT NULL,
    repo_id UUID REFERENCES repos(id),
    worktree_id UUID,  -- FK to iMi worktrees
    
    -- Zellij
    zellij_session_name VARCHAR(255),
    zellij_pane_id VARCHAR(255),
    
    -- Execution
    agentic_tool VARCHAR(100),  -- 'claude-code', 'opencode', 'gptme', etc.
    model VARCHAR(100),
    
    -- Metrics
    prompt_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    
    -- State
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    exit_reason VARCHAR(255)
);

-- Artifacts
CREATE TABLE artifacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    type artifact_type NOT NULL,
    title VARCHAR(500),
    content TEXT,
    metadata JSONB,
    
    -- Context
    session_id UUID REFERENCES sessions(id),
    task_id UUID REFERENCES tasks(id),
    employee_id UUID REFERENCES employees(id),
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent State History (for observability)
CREATE TABLE agent_state_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID REFERENCES employees(id) NOT NULL,
    
    from_state agent_state,
    to_state agent_state NOT NULL,
    reason TEXT,
    
    task_id UUID REFERENCES tasks(id),
    correlation_id UUID,
    causation_id UUID,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily Standups
CREATE TABLE daily_standups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID REFERENCES employees(id) NOT NULL,
    
    yesterday TEXT,
    today TEXT,
    blockers TEXT,
    
    requested_hitl BOOLEAN DEFAULT false,
    hitl_request_details TEXT,
    
    submitted_at TIMESTAMPTZ DEFAULT NOW()
);

-- Peer Reviews
CREATE TABLE peer_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    employee_id UUID REFERENCES employees(id) NOT NULL,
    reviewer_id UUID REFERENCES employees(id),
    
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    
    strengths TEXT,
    areas_for_improvement TEXT,
    recommendations TEXT,
    
    overall_rating INTEGER CHECK (overall_rating BETWEEN 1 AND 5),
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bloodbank Event Log (for replay/audit)
CREATE TABLE bloodbank_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    event VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL,
    
    correlation_id UUID NOT NULL,
    causation_id UUID,
    source VARCHAR(255) NOT NULL,
    
    exchange VARCHAR(255) NOT NULL,
    routing_key VARCHAR(255) NOT NULL,
    
    data JSONB NOT NULL,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────
-- INDEXES
-- ───────────────────────────────────────────────────────────────

CREATE INDEX idx_employees_state ON employees(state);
CREATE INDEX idx_employees_team ON employees(team_id);
CREATE INDEX idx_employees_reports_to ON employees(reports_to_id);

CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_plane_issue ON tasks(plane_issue_id);
CREATE INDEX idx_tasks_correlation ON tasks(correlation_id);

CREATE INDEX idx_sessions_employee ON sessions(employee_id);
CREATE INDEX idx_sessions_task ON sessions(task_id);

CREATE INDEX idx_state_history_employee ON agent_state_history(employee_id);
CREATE INDEX idx_state_history_created ON agent_state_history(created_at);

CREATE INDEX idx_bloodbank_correlation ON bloodbank_events(correlation_id);
CREATE INDEX idx_bloodbank_event ON bloodbank_events(event);
CREATE INDEX idx_bloodbank_created ON bloodbank_events(created_at);

-- ───────────────────────────────────────────────────────────────
-- TRIGGERS
-- ───────────────────────────────────────────────────────────────

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_repos_updated_at
    BEFORE UPDATE ON repos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_employees_updated_at
    BEFORE UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

---

## 7. Walking Skeleton Implementation Plan

### Phase 1: Foundation (Week 1)

```
[ ] Create 33GOD Postgres database
[ ] Apply schema migrations
[ ] Create Flume core TypeScript package
    [ ] Base types (TaskPayload, WorkResult, etc.)
    [ ] Agent interfaces (Employee, Contributor, Manager, Director)
    [ ] State machine types
[ ] Create Yi adapter package
    [ ] YiMemoryStrategy interface
    [ ] SelectionStrategy interface
    [ ] HRDepartment interface
    [ ] OnboardingSpecialist interface
```

### Phase 2: Echo Implementation (Week 2)

```
[ ] EchoMemory - In-memory mock
[ ] EchoContributor - Returns "I completed [task]!"
[ ] EchoManager - LLM-driven selection (uses Claude API)
[ ] EchoDirector - Pure delegation
[ ] EchoHR - Creates echo agents
[ ] EchoOnboarding - Logs context injection

Failure testing:
[ ] EchoFailingContributor - Throws 20% of time
[ ] EchoSlowContributor - 2s delay
[ ] EchoTimeoutContributor - Never completes
```

### Phase 3: Bloodbank Integration (Week 3)

```
[ ] Event publisher utility
[ ] State change → Event emission
[ ] Task lifecycle → Event emission
[ ] Event consumer for logging
[ ] Verify events in RabbitMQ dashboard
```

### Phase 4: Plane Sync (Week 4)

```
[ ] Plane API client
[ ] Webhook receiver for Plane events
[ ] Sync service implementation
[ ] Create task → Plane issue sync
[ ] Update status → Plane status sync
```

### Phase 5: End-to-End Test (Week 5)

```
[ ] Boot: Initialize HR, Onboarding, Director, Manager, 2x Contributor
[ ] Recruit: HR creates agents, Onboarding injects context
[ ] Create: Human creates task in Plane
[ ] Sync: Task synced to 33GOD
[ ] Assign: Director delegates to Manager
[ ] Execute: Manager delegates to Contributor
[ ] Complete: Result bubbles up
[ ] Observe: All events in Bloodbank log
[ ] Verify: Holocene can query state
```

---

## 8. Observability Requirements

### 8.1 What Must Be Observable

1. **Agent State**: Current state of every agent, with history
2. **Task Flow**: Where is each task, who's working on it
3. **Delegation Chain**: Who delegated to whom, with reasoning
4. **Selection Decisions**: Why was this agent chosen
5. **Failures**: What failed, why, what's the recovery path
6. **Performance**: Duration, token usage, retry counts

### 8.2 Holocene Queries

```sql
-- Active agents by state
SELECT state, COUNT(*) 
FROM employees 
WHERE state != 'terminated' 
GROUP BY state;

-- Task throughput by agent
SELECT e.name, COUNT(t.id) as completed
FROM employees e
JOIN tasks t ON t.active_employee_id = e.id
WHERE t.state = 'done'
  AND t.completed_at > NOW() - INTERVAL '7 days'
GROUP BY e.id, e.name
ORDER BY completed DESC;

-- Delegation depth analysis
WITH RECURSIVE delegation_chain AS (
    SELECT id, parent_task_id, 1 as depth
    FROM tasks
    WHERE parent_task_id IS NULL
    
    UNION ALL
    
    SELECT t.id, t.parent_task_id, dc.depth + 1
    FROM tasks t
    JOIN delegation_chain dc ON t.parent_task_id = dc.id
)
SELECT MAX(depth) as max_depth, AVG(depth) as avg_depth
FROM delegation_chain;
```

---

## 9. Open Questions

1. **Mixed Teams**: Can a Letta Manager share memory with a Claude Contributor?
   - Proposal: Team-level vector store, individual implementations translate

2. **Task Claiming**: Multiple agents might try to claim same task
   - Proposal: Optimistic locking with Bloodbank arbitration

3. **Swarms**: How do swarms (many ICs, no manager) fit the model?
   - Proposal: `Swarm` interface that implements `Delegator` with different semantics

4. **Escalation**: What happens when an agent is stuck?
   - Proposal: Timeout → `blocked` state → escalate to manager → potential HITL

---

## 10. Next Actions

1. **Immediate**: Review this architecture with Jarad
2. **This Week**: Create Postgres database, apply schema
3. **Next Week**: Implement Phase 1 (Foundation)
4. **Ongoing**: Update DeLoDocs with architecture decisions

