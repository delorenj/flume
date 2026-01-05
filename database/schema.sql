-- Flume/Yi Database Schema
-- 33GOD Ecosystem - Agent Orchestration Layer
--
-- Connection: postgresql://delorenj:REDACTED_CREDENTIAL@192.168.1.12:5432/33god

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- ENUMS
-- ============================================================================

-- Agent states following corporate lifecycle
CREATE TYPE agent_state AS ENUM (
  'initializing',  -- Being created by HR
  'onboarding',    -- Receiving context injection
  'idle',          -- Ready for work
  'working',       -- Actively executing task
  'delegating',    -- Waiting on subordinate
  'blocked',       -- External dependency
  'reviewing',     -- Peer review / QA
  'errored',       -- Recoverable error
  'terminated'     -- Permanently stopped
);

-- Task states following workflow semantics
CREATE TYPE task_state AS ENUM (
  'draft',         -- Initial creation
  'open',          -- Available for processing
  'ready',         -- Can be accepted
  'assigned',      -- Has assignee
  'in_progress',   -- Active work
  'blocked',       -- Dependency wait
  'in_review',     -- QA phase
  'done',          -- Complete
  'failed',        -- Execution failed
  'cancelled'      -- Manually cancelled
);

-- Employee role types
CREATE TYPE employee_role AS ENUM (
  'contributor',   -- Leaf node - does work
  'manager',       -- Branch node - can delegate AND execute
  'director'       -- Pure orchestrator - only delegates
);

-- Memory shard types
CREATE TYPE memory_type AS ENUM (
  'qdrant',        -- Vector store
  'agentfile',     -- File-based
  'neo4j',         -- Graph database
  'letta_core',    -- Letta native
  'redis',         -- Cache/session
  'custom'         -- Other
);

-- Artifact types (33GOD standard)
CREATE TYPE artifact_type AS ENUM (
  'decision',      -- Decision record
  'brief',         -- Project brief
  'checkpoint',    -- Progress checkpoint
  'recommendation',-- Strategic recommendation
  'code',          -- Code artifact
  'document'       -- General document
);

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Projects - Flume-managed with directors and managers
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  director_id UUID,  -- Foreign key added after employees table

  -- Plane integration
  plane_workspace_slug VARCHAR(100),
  plane_project_id VARCHAR(100),

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Teams - Yi-managed with shared knowledge base
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,

  -- Knowledge sharing
  shared_knowledge_base_id VARCHAR(255),
  mission_statement TEXT,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employees - Yi nodes (agents) with skills and memory
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  role VARCHAR(255) NOT NULL,
  role_type employee_role NOT NULL DEFAULT 'contributor',

  -- Team membership
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  manager_id UUID REFERENCES employees(id) ON DELETE SET NULL,

  -- Current state
  state agent_state NOT NULL DEFAULT 'initializing',
  current_task_id UUID,  -- Forward reference to tasks

  -- Skills and capabilities
  skills TEXT[] DEFAULT ARRAY[]::TEXT[],
  salary INTEGER DEFAULT 50000,  -- Importance metric

  -- Agent framework details
  framework VARCHAR(50),  -- letta, agno, claude, smolagents, echo
  framework_agent_id VARCHAR(255),  -- ID in external system

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add director FK to projects
ALTER TABLE projects
  ADD CONSTRAINT fk_project_director
  FOREIGN KEY (director_id)
  REFERENCES employees(id) ON DELETE SET NULL;

-- Memory shards - Agent memory pointers
CREATE TABLE memory_shards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  type memory_type NOT NULL DEFAULT 'custom',
  pointer VARCHAR(500) NOT NULL,  -- URI to actual memory
  is_active BOOLEAN DEFAULT FALSE,

  -- Metadata
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one active shard per employee
CREATE UNIQUE INDEX idx_memory_shard_active
  ON memory_shards(employee_id)
  WHERE is_active = TRUE;

-- Tasks - Flume-managed, synced with Plane
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Task details
  objective TEXT NOT NULL,
  context JSONB DEFAULT '{}',
  priority INTEGER DEFAULT 0,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  timeout_ms INTEGER,

  -- Hierarchy
  parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  correlation_id UUID NOT NULL,  -- Links related tasks

  -- Assignment
  state task_state NOT NULL DEFAULT 'draft',
  assigned_to UUID REFERENCES employees(id) ON DELETE SET NULL,
  delegated_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  delegation_depth INTEGER DEFAULT 0,

  -- Results
  result_status VARCHAR(50),
  result_output JSONB,
  result_metrics JSONB DEFAULT '{}',
  result_error JSONB,

  -- Plane integration
  plane_issue_id VARCHAR(100),
  plane_workspace_slug VARCHAR(100),
  plane_project_id VARCHAR(100),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add current task FK to employees
ALTER TABLE employees
  ADD CONSTRAINT fk_employee_current_task
  FOREIGN KEY (current_task_id)
  REFERENCES tasks(id) ON DELETE SET NULL;

-- Task contributors - Many-to-many for task participation
CREATE TABLE task_contributors (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'executor',  -- executor, reviewer, delegator
  joined_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (task_id, employee_id)
);

-- Agent state history - Full observability
CREATE TABLE agent_state_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  from_state agent_state NOT NULL,
  to_state agent_state NOT NULL,
  trigger VARCHAR(255) NOT NULL,

  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  error TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions - Jelmore-managed execution sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  -- Zellij integration
  zellij_session_name VARCHAR(255),
  zellij_pane VARCHAR(50),

  -- Session state
  status VARCHAR(50) DEFAULT 'active',  -- active, completed, terminated

  -- Timestamps
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- Artifacts - Decision, brief, checkpoint, recommendation
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  type artifact_type NOT NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily standups - Async status reports
CREATE TABLE daily_standups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  state agent_state NOT NULL,
  current_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  blockers TEXT[] DEFAULT ARRAY[]::TEXT[],

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Peer reviews - Performance evaluations
CREATE TABLE peer_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reviewer_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reviewee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,

  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  feedback TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bloodbank events - Event sourcing log
CREATE TABLE bloodbank_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Event identification
  event VARCHAR(255) NOT NULL,
  version VARCHAR(50) NOT NULL DEFAULT '1.0.0',

  -- Traceability
  correlation_id UUID NOT NULL,
  causation_id UUID,
  source VARCHAR(255) NOT NULL,

  -- Routing
  exchange VARCHAR(255) NOT NULL DEFAULT 'amq.topic',
  routing_key VARCHAR(255) NOT NULL,

  -- Payload
  data JSONB NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Tasks
CREATE INDEX idx_tasks_correlation ON tasks(correlation_id);
CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_plane_issue ON tasks(plane_issue_id);

-- Employees
CREATE INDEX idx_employees_team ON employees(team_id);
CREATE INDEX idx_employees_manager ON employees(manager_id);
CREATE INDEX idx_employees_state ON employees(state);
CREATE INDEX idx_employees_framework ON employees(framework);

-- Agent state history
CREATE INDEX idx_state_history_employee ON agent_state_history(employee_id);
CREATE INDEX idx_state_history_created ON agent_state_history(created_at);

-- Bloodbank events
CREATE INDEX idx_bloodbank_correlation ON bloodbank_events(correlation_id);
CREATE INDEX idx_bloodbank_event ON bloodbank_events(event);
CREATE INDEX idx_bloodbank_created ON bloodbank_events(created_at);
CREATE INDEX idx_bloodbank_routing ON bloodbank_events(routing_key);

-- Memory shards
CREATE INDEX idx_memory_shards_employee ON memory_shards(employee_id);

-- Sessions
CREATE INDEX idx_sessions_task ON sessions(task_id);
CREATE INDEX idx_sessions_employee ON sessions(employee_id);

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Active agents by state (Holocene dashboard)
CREATE VIEW v_agent_state_distribution AS
SELECT
  state,
  role_type,
  COUNT(*) as count
FROM employees
WHERE state != 'terminated'
GROUP BY state, role_type
ORDER BY role_type, state;

-- Task throughput by agent (last 7 days)
CREATE VIEW v_task_throughput AS
SELECT
  e.id as employee_id,
  e.name,
  e.role_type,
  COUNT(t.id) as completed_tasks,
  AVG((t.result_metrics->>'durationMs')::INTEGER) as avg_duration_ms
FROM employees e
LEFT JOIN tasks t ON t.assigned_to = e.id
  AND t.state = 'done'
  AND t.completed_at > NOW() - INTERVAL '7 days'
GROUP BY e.id, e.name, e.role_type
ORDER BY completed_tasks DESC;

-- Delegation chain depth analysis
CREATE VIEW v_delegation_depth AS
WITH RECURSIVE delegation_chain AS (
  SELECT id, parent_task_id, 1 as depth
  FROM tasks
  WHERE parent_task_id IS NULL

  UNION ALL

  SELECT t.id, t.parent_task_id, dc.depth + 1
  FROM tasks t
  JOIN delegation_chain dc ON t.parent_task_id = dc.id
)
SELECT
  MAX(depth) as max_depth,
  AVG(depth) as avg_depth,
  COUNT(*) as total_tasks
FROM delegation_chain;

-- Team composition
CREATE VIEW v_team_composition AS
SELECT
  t.id as team_id,
  t.name as team_name,
  p.name as project_name,
  COUNT(e.id) as member_count,
  COUNT(CASE WHEN e.role_type = 'director' THEN 1 END) as directors,
  COUNT(CASE WHEN e.role_type = 'manager' THEN 1 END) as managers,
  COUNT(CASE WHEN e.role_type = 'contributor' THEN 1 END) as contributors
FROM teams t
LEFT JOIN projects p ON t.project_id = p.id
LEFT JOIN employees e ON e.team_id = t.id
GROUP BY t.id, t.name, p.name;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update timestamps on modification
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_employees_updated
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_tasks_updated
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_projects_updated
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_teams_updated
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Log agent state transitions
CREATE OR REPLACE FUNCTION log_agent_state_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO agent_state_history (
      employee_id, from_state, to_state, trigger, task_id
    ) VALUES (
      NEW.id, OLD.state, NEW.state, 'db_update', NEW.current_task_id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_log_state_change
  AFTER UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION log_agent_state_change();

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Insert default project and team for Echo testing
INSERT INTO projects (id, name, description, plane_workspace_slug)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Flume/Yi Walking Skeleton',
  'Echo implementation for architecture validation',
  '33god'
);

INSERT INTO teams (id, name, project_id, mission_statement, shared_knowledge_base_id)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Echo Team',
  '00000000-0000-0000-0000-000000000001',
  'Build and maintain the 33GOD agentic pipeline',
  'default'
);

-- ============================================================================
-- GRANTS
-- ============================================================================

-- Grant permissions to application user (if different from owner)
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO flume_app;
-- GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO flume_app;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO flume_app;
