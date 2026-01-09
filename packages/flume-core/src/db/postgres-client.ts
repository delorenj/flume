/**
 * PostgreSQL Client - Database access layer for Flume/Yi
 *
 * Provides typed access to the 33GOD database schema.
 * Uses pg library for connection pooling.
 *
 * @category Database
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

  /**
   * Get tasks assigned to an employee.
   */
  async getTasksByEmployee(
    employeeId: string,
    options: { state?: string; limit?: number; offset?: number } = {}
  ): Promise<TaskRecord[]> {
    const conditions: string[] = ['assignee_id = $1'];
    const params: unknown[] = [employeeId];
    let paramIndex = 2;

    if (options.state) {
      conditions.push(`state = $${paramIndex}`);
      params.push(options.state);
      paramIndex++;
    }

    let query = `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;

    if (options.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(options.limit);
      paramIndex++;
    }

    if (options.offset) {
      query += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
    }

    const result = await this.query<TaskRecord>(query, params);
    return result.rows;
  }

  /**
   * Get tasks by state.
   */
  async getTasksByState(state: string): Promise<TaskRecord[]> {
    const result = await this.query<TaskRecord>(
      'SELECT * FROM tasks WHERE state = $1 ORDER BY priority, created_at',
      [state]
    );
    return result.rows;
  }

  /**
   * Get tasks completed within a date range.
   */
  async getCompletedTasksInRange(
    startDate: Date,
    endDate: Date,
    employeeId?: string
  ): Promise<TaskRecord[]> {
    const conditions: string[] = [
      'completed_at >= $1',
      'completed_at <= $2',
      "state IN ('done', 'failed')",
    ];
    const params: unknown[] = [startDate, endDate];

    if (employeeId) {
      conditions.push('assignee_id = $3');
      params.push(employeeId);
    }

    const result = await this.query<TaskRecord>(
      `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY completed_at DESC`,
      params
    );
    return result.rows;
  }

  /**
   * Get task metrics for an employee.
   */
  async getTaskMetrics(employeeId: string): Promise<TaskMetrics> {
    const [totals, recentTasks, avgCompletionTime] = await Promise.all([
      this.query<{ state: string; count: string }>(
        `SELECT state, COUNT(*) as count FROM tasks
         WHERE assignee_id = $1
         GROUP BY state`,
        [employeeId]
      ),
      this.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tasks
         WHERE assignee_id = $1 AND completed_at > NOW() - INTERVAL '7 days'`,
        [employeeId]
      ),
      this.query<{ avg_hours: string }>(
        `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 3600) as avg_hours
         FROM tasks
         WHERE assignee_id = $1 AND completed_at IS NOT NULL AND started_at IS NOT NULL`,
        [employeeId]
      ),
    ]);

    const stateCounts = totals.rows.reduce(
      (acc, row) => {
        acc[row.state] = parseInt(row.count, 10);
        return acc;
      },
      {} as Record<string, number>
    );

    return {
      employeeId,
      totalTasks: Object.values(stateCounts).reduce((a, b) => a + b, 0),
      tasksByState: stateCounts,
      completedLast7Days: parseInt(recentTasks.rows[0]?.count ?? '0', 10),
      avgCompletionTimeHours: parseFloat(avgCompletionTime.rows[0]?.avg_hours ?? '0'),
    };
  }

  /**
   * Get tasks grouped by priority.
   */
  async getTasksByPriority(): Promise<TaskPriorityBreakdown[]> {
    const result = await this.query<TaskPriorityBreakdown>(
      `SELECT
         priority,
         COUNT(*) as total,
         COUNT(CASE WHEN state = 'done' THEN 1 END) as completed,
         COUNT(CASE WHEN state = 'in_progress' THEN 1 END) as in_progress,
         COUNT(CASE WHEN state IN ('draft', 'pending') THEN 1 END) as pending
       FROM tasks
       GROUP BY priority
       ORDER BY
         CASE priority
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
         END`
    );
    return result.rows;
  }

  /**
   * Get recent task activity.
   */
  async getRecentTaskActivity(limit = 20): Promise<TaskActivityRecord[]> {
    const result = await this.query<TaskActivityRecord>(
      `SELECT
         t.id,
         t.title,
         t.state,
         t.assignee_id,
         e.name as assignee_name,
         t.priority,
         t.updated_at
       FROM tasks t
       LEFT JOIN employees e ON t.assignee_id = e.id
       ORDER BY t.updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  /**
   * Get task completion trends.
   */
  async getTaskCompletionTrends(
    days = 30,
    employeeId?: string
  ): Promise<TaskCompletionTrend[]> {
    const conditions: string[] = [
      "state IN ('done', 'failed')",
      'completed_at >= NOW() - $1::interval',
    ];
    const params: unknown[] = [`${days} days`];

    if (employeeId) {
      conditions.push('assignee_id = $2');
      params.push(employeeId);
    }

    const result = await this.query<TaskCompletionTrend>(
      `SELECT
         DATE(completed_at) as date,
         COUNT(*) as total,
         COUNT(CASE WHEN state = 'done' THEN 1 END) as completed,
         COUNT(CASE WHEN state = 'failed' THEN 1 END) as failed
       FROM tasks
       WHERE ${conditions.join(' AND ')}
       GROUP BY DATE(completed_at)
       ORDER BY date DESC`,
      params
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

  /**
   * Get state history for an employee.
   */
  async getStateHistory(
    employeeId: string,
    options: { limit?: number; since?: Date } = {}
  ): Promise<StateHistoryRecord[]> {
    const conditions = ['employee_id = $1'];
    const params: unknown[] = [employeeId];
    let paramIndex = 2;

    if (options.since) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(options.since);
      paramIndex++;
    }

    const limit = options.limit ? `LIMIT ${options.limit}` : '';

    const result = await this.query<StateHistoryRecord>(
      `SELECT * FROM agent_state_history
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       ${limit}`,
      params
    );
    return result.rows;
  }

  /**
   * Get state history for a correlation ID.
   */
  async getStateHistoryByCorrelation(correlationId: string): Promise<StateHistoryRecord[]> {
    const result = await this.query<StateHistoryRecord>(
      'SELECT * FROM agent_state_history WHERE correlation_id = $1 ORDER BY created_at',
      [correlationId]
    );
    return result.rows;
  }

  /**
   * Get employees by current state.
   */
  async getEmployeesByState(state: string): Promise<EmployeeRecord[]> {
    const result = await this.query<EmployeeRecord>(
      'SELECT * FROM employees WHERE state = $1 ORDER BY name',
      [state]
    );
    return result.rows;
  }

  /**
   * Get employees currently working on tasks.
   */
  async getActiveEmployees(): Promise<EmployeeRecord[]> {
    const result = await this.query<EmployeeRecord>(
      `SELECT * FROM employees
       WHERE state IN ('working', 'delegating', 'reviewing')
       ORDER BY name`
    );
    return result.rows;
  }

  /**
   * Get employees needing attention (errored or blocked).
   */
  async getEmployeesNeedingAttention(): Promise<EmployeeRecord[]> {
    const result = await this.query<EmployeeRecord>(
      `SELECT * FROM employees
       WHERE state IN ('errored', 'blocked')
       ORDER BY updated_at DESC`
    );
    return result.rows;
  }

  /**
   * Get agent metrics (performance statistics).
   */
  async getAgentMetrics(employeeId: string): Promise<AgentMetrics> {
    const [employee, stateChanges, recentTasks] = await Promise.all([
      this.getEmployee(employeeId),
      this.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM agent_state_history WHERE employee_id = $1',
        [employeeId]
      ),
      this.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tasks
         WHERE assignee_id = $1 AND completed_at > NOW() - INTERVAL '7 days'`,
        [employeeId]
      ),
    ]);

    return {
      employeeId,
      tasksCompleted: employee?.tasks_completed ?? 0,
      tasksFailed: employee?.tasks_failed ?? 0,
      totalStateTransitions: parseInt(stateChanges.rows[0]?.count ?? '0', 10),
      tasksLast7Days: parseInt(recentTasks.rows[0]?.count ?? '0', 10),
      currentState: employee?.state ?? 'unknown',
      successRate: employee
        ? employee.tasks_completed / Math.max(1, employee.tasks_completed + employee.tasks_failed)
        : 0,
    };
  }

  /**
   * Get state transition patterns for analysis.
   */
  async getStateTransitionPatterns(options: {
    since?: Date;
    employeeId?: string;
  } = {}): Promise<StateTransitionPattern[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.since) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(options.since);
      paramIndex++;
    }

    if (options.employeeId) {
      conditions.push(`employee_id = $${paramIndex}`);
      params.push(options.employeeId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.query<StateTransitionPattern>(
      `SELECT
         from_state,
         to_state,
         COUNT(*) as count,
         COUNT(DISTINCT employee_id) as unique_employees
       FROM agent_state_history
       ${whereClause}
       GROUP BY from_state, to_state
       ORDER BY count DESC`,
      params
    );
    return result.rows;
  }

  /**
   * Get time spent in each state for an employee.
   */
  async getStateTimeBreakdown(
    employeeId: string,
    since?: Date
  ): Promise<StateTimeBreakdown[]> {
    const params: unknown[] = [employeeId];
    const sinceCondition = since
      ? 'AND created_at >= $2'
      : '';
    if (since) params.push(since);

    const result = await this.query<StateTimeBreakdown>(
      `WITH state_durations AS (
         SELECT
           from_state,
           to_state,
           created_at,
           LEAD(created_at) OVER (PARTITION BY employee_id ORDER BY created_at) as next_transition
         FROM agent_state_history
         WHERE employee_id = $1 ${sinceCondition}
       )
       SELECT
         to_state as state,
         COUNT(*) as entry_count,
         COALESCE(SUM(EXTRACT(EPOCH FROM (next_transition - created_at))), 0) as total_seconds
       FROM state_durations
       WHERE next_transition IS NOT NULL
       GROUP BY to_state
       ORDER BY total_seconds DESC`,
      params
    );
    return result.rows;
  }
}

/**
 * State history record from database.
 */
export interface StateHistoryRecord extends Record<string, unknown> {
  id: string;
  employee_id: string;
  from_state: string;
  to_state: string;
  reason: string;
  task_id: string | null;
  correlation_id: string | null;
  error: string | null;
  created_at: Date;
}

/**
 * Agent performance metrics.
 */
export interface AgentMetrics {
  employeeId: string;
  tasksCompleted: number;
  tasksFailed: number;
  totalStateTransitions: number;
  tasksLast7Days: number;
  currentState: string;
  successRate: number;
}

/**
 * State transition pattern for analysis.
 */
export interface StateTransitionPattern {
  from_state: string;
  to_state: string;
  count: string;
  unique_employees: string;
}

/**
 * Time breakdown by state.
 */
export interface StateTimeBreakdown {
  state: string;
  entry_count: string;
  total_seconds: string;
}

/**
 * Task metrics for an employee.
 */
export interface TaskMetrics {
  employeeId: string;
  totalTasks: number;
  tasksByState: Record<string, number>;
  completedLast7Days: number;
  avgCompletionTimeHours: number;
}

/**
 * Task priority breakdown.
 */
export interface TaskPriorityBreakdown {
  priority: string;
  total: string;
  completed: string;
  in_progress: string;
  pending: string;
}

/**
 * Task activity record with assignee info.
 */
export interface TaskActivityRecord {
  id: string;
  title: string;
  state: string;
  assignee_id: string | null;
  assignee_name: string | null;
  priority: string;
  updated_at: Date;
}

/**
 * Task completion trend by date.
 */
export interface TaskCompletionTrend {
  date: Date;
  total: string;
  completed: string;
  failed: string;
}
