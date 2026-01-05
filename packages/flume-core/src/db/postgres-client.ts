/**
 * PostgreSQL Client - Database access layer for Flume/Yi
 *
 * Provides typed access to the 33GOD database schema.
 * Uses pg library for connection pooling.
 */

import type { Pool, PoolClient, QueryResult } from 'pg';

/**
 * Database configuration.
 */
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;  // Max pool size
}

/**
 * Default database configuration for 33GOD.
 */
export const DEFAULT_DATABASE_CONFIG: DatabaseConfig = {
  host: process.env.POSTGRES_HOST ?? '192.168.1.12',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? '33god',
  user: process.env.POSTGRES_USER ?? 'delorenj',
  password: process.env.POSTGRES_PASSWORD ?? '',
  max: 10,
};

/**
 * Employee record from database.
 */
export interface EmployeeRecord extends Record<string, unknown> {
  id: string;
  name: string;
  role: 'contributor' | 'manager' | 'director';
  agent_type: 'letta' | 'agno' | 'claude' | 'smolagents' | 'custom';
  personality: string | null;
  background: string | null;
  system_prompt: string | null;
  state: string;
  current_task_id: string | null;
  team_id: string | null;
  reports_to_id: string | null;
  salary: number;
  tasks_completed: number;
  tasks_failed: number;
  skills: string[];
  domains_of_expertise: string[];
  domains_of_experience: string[];
  mcp_servers: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  terminated_at: Date | null;
}

/**
 * Task record from database.
 */
export interface TaskRecord extends Record<string, unknown> {
  id: string;
  title: string;
  description: string | null;
  requirements: Record<string, unknown> | null;
  acceptance_criteria: Record<string, unknown> | null;
  plan: string | null;
  priority: string;  // task_priority enum
  state: string;     // task_state enum
  parent_task_id: string | null;
  project_id: string | null;
  repo_id: string | null;
  correlation_id: string;
  assignee_id: string | null;
  active_employee_id: string | null;
  created_by_employee_id: string | null;
  created_by_human: string | null;
  plane_issue_id: string | null;
  plane_workspace_slug: string | null;
  plane_project_id: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

/**
 * Team record from database.
 */
export interface TeamRecord extends Record<string, unknown> {
  id: string;
  name: string;
  project_id: string | null;
  shared_knowledge_base_id: string | null;
  mission_statement: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Project record from database.
 */
export interface ProjectRecord extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  director_id: string | null;
  plane_workspace_slug: string | null;
  plane_project_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Bloodbank event record from database.
 */
export interface BloodbankEventRecord extends Record<string, unknown> {
  id: string;
  event: string;
  version: string;
  correlation_id: string;
  causation_id: string | null;
  source: string;
  exchange: string;
  routing_key: string;
  data: Record<string, unknown>;
  created_at: Date;
}

/**
 * PostgreSQL client for Flume/Yi.
 */
export class PostgresClient {
  private pool: Pool | null = null;
  private connected = false;

  constructor(private config: DatabaseConfig = DEFAULT_DATABASE_CONFIG) {}

  /**
   * Connect to the database.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      // Dynamic import to avoid requiring pg during testing
      const { Pool } = await import('pg');
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        max: this.config.max,
      });

      // Test connection
      const client = await this.pool.connect();
      client.release();

      this.connected = true;
      console.log(`[Postgres] Connected to ${this.config.host}:${this.config.port}/${this.config.database}`);
    } catch (error) {
      console.error('[Postgres] Connection failed:', error);
      throw error;
    }
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.connected = false;
      console.log('[Postgres] Disconnected');
    }
  }

  /**
   * Execute a query.
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    return this.pool.query<T>(sql, params);
  }

  /**
   * Get a client for transactions.
   */
  async getClient(): Promise<PoolClient> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    return this.pool.connect();
  }

  // ============================================================================
  // Employee Operations
  // ============================================================================

  /**
   * Create an employee.
   */
  async createEmployee(employee: {
    id: string;
    name: string;
    role: 'contributor' | 'manager' | 'director';
    agentType?: 'letta' | 'agno' | 'claude' | 'smolagents' | 'custom';
    teamId?: string;
    reportsToId?: string;
    skills?: string[];
    salary?: number;
    personality?: string;
    background?: string;
    systemPrompt?: string;
  }): Promise<EmployeeRecord> {
    const result = await this.query<EmployeeRecord>(
      `INSERT INTO employees (id, name, role, agent_type, team_id, reports_to_id, skills, salary, personality, background, system_prompt, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'initializing')
       RETURNING *`,
      [
        employee.id,
        employee.name,
        employee.role,
        employee.agentType ?? 'custom',
        employee.teamId ?? null,
        employee.reportsToId ?? null,
        employee.skills ?? [],
        employee.salary ?? 50000,
        employee.personality ?? null,
        employee.background ?? null,
        employee.systemPrompt ?? null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get an employee by ID.
   */
  async getEmployee(id: string): Promise<EmployeeRecord | null> {
    const result = await this.query<EmployeeRecord>(
      'SELECT * FROM employees WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Update employee state.
   */
  async updateEmployeeState(id: string, state: string, taskId?: string): Promise<void> {
    await this.query(
      'UPDATE employees SET state = $2, current_task_id = $3, updated_at = NOW() WHERE id = $1',
      [id, state, taskId ?? null]
    );
  }

  /**
   * Get employees by team.
   */
  async getEmployeesByTeam(teamId: string): Promise<EmployeeRecord[]> {
    const result = await this.query<EmployeeRecord>(
      'SELECT * FROM employees WHERE team_id = $1 ORDER BY role, name',
      [teamId]
    );
    return result.rows;
  }

  /**
   * Get subordinates of a manager.
   */
  async getSubordinates(managerId: string): Promise<EmployeeRecord[]> {
    const result = await this.query<EmployeeRecord>(
      'SELECT * FROM employees WHERE reports_to_id = $1 ORDER BY name',
      [managerId]
    );
    return result.rows;
  }

  // ============================================================================
  // Task Operations
  // ============================================================================

  /**
   * Create a task.
   */
  async createTask(task: {
    id: string;
    correlationId: string;
    title: string;
    description?: string;
    requirements?: Record<string, unknown>;
    acceptanceCriteria?: Record<string, unknown>;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    parentTaskId?: string;
    projectId?: string;
    assigneeId?: string;
    createdByEmployeeId?: string;
    createdByHuman?: string;
    planeIssueId?: string;
    planeWorkspaceSlug?: string;
    planeProjectId?: string;
  }): Promise<TaskRecord> {
    const result = await this.query<TaskRecord>(
      `INSERT INTO tasks (
        id, correlation_id, title, description, requirements, acceptance_criteria,
        priority, parent_task_id, project_id, assignee_id, created_by_employee_id,
        created_by_human, plane_issue_id, plane_workspace_slug, plane_project_id, state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'draft')
      RETURNING *`,
      [
        task.id,
        task.correlationId,
        task.title,
        task.description ?? null,
        task.requirements ?? null,
        task.acceptanceCriteria ?? null,
        task.priority ?? 'medium',
        task.parentTaskId ?? null,
        task.projectId ?? null,
        task.assigneeId ?? null,
        task.createdByEmployeeId ?? null,
        task.createdByHuman ?? null,
        task.planeIssueId ?? null,
        task.planeWorkspaceSlug ?? null,
        task.planeProjectId ?? null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get a task by ID.
   */
  async getTask(id: string): Promise<TaskRecord | null> {
    const result = await this.query<TaskRecord>(
      'SELECT * FROM tasks WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Update task state.
   */
  async updateTaskState(id: string, state: string): Promise<void> {
    const updates: string[] = ['state = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, state];

    if (state === 'in_progress') {
      updates.push('started_at = COALESCE(started_at, NOW())');
    } else if (['done', 'failed', 'cancelled'].includes(state)) {
      updates.push('completed_at = NOW()');
    }

    await this.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $1`,
      params
    );
  }

  /**
   * Update task result.
   */
  async updateTaskResult(
    id: string,
    status: string,
    output: unknown,
    metrics: Record<string, unknown>,
    error?: Record<string, unknown>
  ): Promise<void> {
    await this.query(
      `UPDATE tasks SET
        result_status = $2,
        result_output = $3,
        result_metrics = $4,
        result_error = $5,
        completed_at = NOW(),
        updated_at = NOW()
       WHERE id = $1`,
      [id, status, JSON.stringify(output), metrics, error ?? null]
    );
  }

  /**
   * Get tasks by correlation ID.
   */
  async getTasksByCorrelation(correlationId: string): Promise<TaskRecord[]> {
    const result = await this.query<TaskRecord>(
      'SELECT * FROM tasks WHERE correlation_id = $1 ORDER BY created_at',
      [correlationId]
    );
    return result.rows;
  }

  // ============================================================================
  // Team Operations
  // ============================================================================

  /**
   * Create a team.
   */
  async createTeam(team: {
    id: string;
    name: string;
    projectId?: string;
    missionStatement?: string;
    sharedKnowledgeBaseId?: string;
  }): Promise<TeamRecord> {
    const result = await this.query<TeamRecord>(
      `INSERT INTO teams (id, name, project_id, mission_statement, shared_knowledge_base_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        team.id,
        team.name,
        team.projectId ?? null,
        team.missionStatement ?? null,
        team.sharedKnowledgeBaseId ?? null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get a team by ID.
   */
  async getTeam(id: string): Promise<TeamRecord | null> {
    const result = await this.query<TeamRecord>(
      'SELECT * FROM teams WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  // ============================================================================
  // Bloodbank Event Operations
  // ============================================================================

  /**
   * Store a Bloodbank event.
   */
  async storeEvent(event: {
    id: string;
    event: string;
    version: string;
    correlationId: string;
    causationId?: string;
    source: string;
    exchange: string;
    routingKey: string;
    data: Record<string, unknown>;
  }): Promise<BloodbankEventRecord> {
    const result = await this.query<BloodbankEventRecord>(
      `INSERT INTO bloodbank_events (id, event, version, correlation_id, causation_id, source, exchange, routing_key, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        event.id,
        event.event,
        event.version,
        event.correlationId,
        event.causationId ?? null,
        event.source,
        event.exchange,
        event.routingKey,
        event.data,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get events by correlation ID.
   */
  async getEventsByCorrelation(correlationId: string): Promise<BloodbankEventRecord[]> {
    const result = await this.query<BloodbankEventRecord>(
      'SELECT * FROM bloodbank_events WHERE correlation_id = $1 ORDER BY created_at',
      [correlationId]
    );
    return result.rows;
  }

  // ============================================================================
  // Agent State History
  // ============================================================================

  /**
   * Log agent state transition.
   */
  async logStateTransition(
    employeeId: string,
    fromState: string,
    toState: string,
    reason: string,
    taskId?: string,
    correlationId?: string
  ): Promise<void> {
    await this.query(
      `INSERT INTO agent_state_history (employee_id, from_state, to_state, reason, task_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [employeeId, fromState, toState, reason, taskId ?? null, correlationId ?? null]
    );
  }
}
