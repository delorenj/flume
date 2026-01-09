/**
 * Unit tests for PostgresClient state query methods
 *
 * These tests mock the database pool to test query construction
 * without requiring an actual database connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostgresClient } from './postgres-client.js';

describe('PostgresClient', () => {
  let client: PostgresClient;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();

    client = new PostgresClient({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
    });

    // Directly inject mock pool to bypass actual connection
    // This allows testing query construction without DB
    (client as unknown as { pool: unknown }).pool = {
      query: mockQuery,
      connect: vi.fn().mockResolvedValue({ release: vi.fn() }),
      end: vi.fn(),
    };
    (client as unknown as { connected: boolean }).connected = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getEmployeesByState', () => {
    it('should fetch employees by state', async () => {
      const mockRows = [
        {
          id: 'emp-1',
          name: 'Agent One',
          role: 'contributor',
          team_id: 'team-1',
          skills: ['typescript'],
          salary: 50000,
          state: 'working',
          agent_type: 'claude',
          personality: null,
          background: null,
          system_prompt: null,
          reports_to_id: null,
          tasks_completed: 5,
          tasks_failed: 0,
          domains_of_expertise: [],
          domains_of_experience: [],
          mcp_servers: [],
          created_at: new Date(),
          updated_at: new Date(),
          terminated_at: null,
        },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getEmployeesByState('working');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('state = $1'),
        ['working']
      );
      expect(result).toHaveLength(1);
      expect(result[0].state).toBe('working');
    });
  });

  describe('getActiveEmployees', () => {
    it('should fetch employees in working states', async () => {
      const mockRows = [
        {
          id: 'emp-1',
          name: 'Agent One',
          role: 'contributor',
          team_id: 'team-1',
          skills: [],
          salary: 50000,
          state: 'working',
          agent_type: 'claude',
          personality: null,
          background: null,
          system_prompt: null,
          reports_to_id: null,
          tasks_completed: 5,
          tasks_failed: 0,
          domains_of_expertise: [],
          domains_of_experience: [],
          mcp_servers: [],
          created_at: new Date(),
          updated_at: new Date(),
          terminated_at: null,
        },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getActiveEmployees();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("state IN ('working', 'delegating', 'reviewing')"),
        undefined
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('getEmployeesNeedingAttention', () => {
    it('should fetch employees in error or blocked state', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await client.getEmployeesNeedingAttention();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("state IN ('errored', 'blocked')"),
        undefined
      );
    });
  });

  describe('getAgentMetrics', () => {
    it('should return aggregated metrics for an employee', async () => {
      const mockEmployee = {
        id: 'emp-123',
        name: 'Test Agent',
        role: 'contributor',
        team_id: 'team-1',
        skills: ['typescript'],
        salary: 50000,
        state: 'idle',
        agent_type: 'claude',
        personality: null,
        background: null,
        system_prompt: null,
        reports_to_id: null,
        tasks_completed: 10,
        tasks_failed: 2,
        domains_of_expertise: [],
        domains_of_experience: [],
        mcp_servers: [],
        created_at: new Date(),
        updated_at: new Date(),
        terminated_at: null,
      };

      // First call: getEmployee query
      mockQuery.mockResolvedValueOnce({ rows: [mockEmployee] });
      // Second call: state change count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '25' }] });
      // Third call: recent tasks count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });

      const result = await client.getAgentMetrics('emp-123');

      expect(result.employeeId).toBe('emp-123');
      expect(result.tasksCompleted).toBe(10);
      expect(result.tasksFailed).toBe(2);
      expect(result.totalStateTransitions).toBe(25);
      expect(result.tasksLast7Days).toBe(5);
      expect(result.currentState).toBe('idle');
      expect(result.successRate).toBeCloseTo(0.833, 2);
    });

    it('should return zeros for non-existent employee', async () => {
      // First call: getEmployee returns null
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Second call: state change count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
      // Third call: recent tasks count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const result = await client.getAgentMetrics('emp-nonexistent');

      expect(result.tasksCompleted).toBe(0);
      expect(result.tasksFailed).toBe(0);
      expect(result.totalStateTransitions).toBe(0);
      expect(result.currentState).toBe('unknown');
    });
  });

  describe('getStateTransitionPatterns', () => {
    it('should return state transition patterns', async () => {
      const mockRows = [
        { from_state: 'idle', to_state: 'working', count: '50', unique_employees: '5' },
        { from_state: 'working', to_state: 'idle', count: '45', unique_employees: '5' },
        { from_state: 'working', to_state: 'errored', count: '5', unique_employees: '3' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getStateTransitionPatterns();

      expect(result).toHaveLength(3);
      expect(result[0].from_state).toBe('idle');
      expect(result[0].to_state).toBe('working');
      expect(result[0].count).toBe('50');
    });

    it('should filter by employee ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await client.getStateTransitionPatterns({ employeeId: 'emp-123' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('employee_id = $1'),
        expect.arrayContaining(['emp-123'])
      );
    });

    it('should filter by since date', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const since = new Date('2026-01-01');

      await client.getStateTransitionPatterns({ since });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('created_at >= $1'),
        [since]
      );
    });
  });

  describe('getStateTimeBreakdown', () => {
    it('should return time breakdown by state', async () => {
      const mockRows = [
        { state: 'idle', entry_count: '10', total_seconds: '36000' },
        { state: 'working', entry_count: '15', total_seconds: '28800' },
        { state: 'errored', entry_count: '2', total_seconds: '7200' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getStateTimeBreakdown('emp-123');

      expect(result).toHaveLength(3);
      expect(result[0].state).toBe('idle');
      expect(result[0].entry_count).toBe('10');
      expect(result[0].total_seconds).toBe('36000');
    });

    it('should filter by since date', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const since = new Date('2026-01-01');

      await client.getStateTimeBreakdown('emp-123', since);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('created_at >= $2'),
        ['emp-123', since]
      );
    });
  });

  // ============================================================================
  // Task History Tests
  // ============================================================================

  describe('getTasksByEmployee', () => {
    it('should fetch tasks assigned to an employee', async () => {
      const mockRows = [
        {
          id: 'task-1',
          correlation_id: 'corr-1',
          title: 'Test Task',
          state: 'done',
          assignee_id: 'emp-123',
          created_at: new Date(),
        },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getTasksByEmployee('emp-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('assignee_id = $1'),
        ['emp-123']
      );
      expect(result).toHaveLength(1);
      expect(result[0].assignee_id).toBe('emp-123');
    });

    it('should filter by state', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await client.getTasksByEmployee('emp-123', { state: 'done' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('state = $2'),
        ['emp-123', 'done']
      );
    });

    it('should support pagination', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await client.getTasksByEmployee('emp-123', { limit: 10, offset: 20 });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/LIMIT \$\d.*OFFSET \$\d/),
        expect.arrayContaining(['emp-123', 10, 20])
      );
    });
  });

  describe('getTasksByState', () => {
    it('should fetch tasks by state', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await client.getTasksByState('in_progress');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('state = $1'),
        ['in_progress']
      );
    });
  });

  describe('getCompletedTasksInRange', () => {
    it('should fetch tasks completed in date range', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const startDate = new Date('2026-01-01');
      const endDate = new Date('2026-01-31');

      await client.getCompletedTasksInRange(startDate, endDate);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('completed_at >= $1'),
        [startDate, endDate]
      );
    });

    it('should filter by employee', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const startDate = new Date('2026-01-01');
      const endDate = new Date('2026-01-31');

      await client.getCompletedTasksInRange(startDate, endDate, 'emp-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('assignee_id = $3'),
        [startDate, endDate, 'emp-123']
      );
    });
  });

  describe('getTaskMetrics', () => {
    it('should return task metrics for an employee', async () => {
      // First call: state breakdown
      mockQuery.mockResolvedValueOnce({
        rows: [
          { state: 'done', count: '10' },
          { state: 'failed', count: '2' },
          { state: 'in_progress', count: '3' },
        ],
      });
      // Second call: recent tasks count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });
      // Third call: avg completion time
      mockQuery.mockResolvedValueOnce({ rows: [{ avg_hours: '2.5' }] });

      const result = await client.getTaskMetrics('emp-123');

      expect(result.employeeId).toBe('emp-123');
      expect(result.totalTasks).toBe(15);
      expect(result.tasksByState.done).toBe(10);
      expect(result.tasksByState.failed).toBe(2);
      expect(result.completedLast7Days).toBe(5);
      expect(result.avgCompletionTimeHours).toBe(2.5);
    });
  });

  describe('getTasksByPriority', () => {
    it('should return tasks grouped by priority', async () => {
      const mockRows = [
        { priority: 'critical', total: '5', completed: '3', in_progress: '2', pending: '0' },
        { priority: 'high', total: '10', completed: '5', in_progress: '3', pending: '2' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getTasksByPriority();

      expect(result).toHaveLength(2);
      expect(result[0].priority).toBe('critical');
      expect(result[0].total).toBe('5');
    });
  });

  describe('getRecentTaskActivity', () => {
    it('should return recent task activity', async () => {
      const mockRows = [
        {
          id: 'task-1',
          title: 'Recent Task',
          state: 'done',
          assignee_id: 'emp-1',
          assignee_name: 'Agent One',
          priority: 'high',
          updated_at: new Date(),
        },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getRecentTaskActivity(10);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $1'),
        [10]
      );
      expect(result).toHaveLength(1);
      expect(result[0].assignee_name).toBe('Agent One');
    });
  });

  describe('getTaskCompletionTrends', () => {
    it('should return task completion trends', async () => {
      const mockRows = [
        { date: new Date('2026-01-05'), total: '10', completed: '8', failed: '2' },
        { date: new Date('2026-01-04'), total: '5', completed: '5', failed: '0' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await client.getTaskCompletionTrends(7);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('NOW() - $1::interval'),
        ['7 days']
      );
      expect(result).toHaveLength(2);
    });

    it('should filter by employee', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await client.getTaskCompletionTrends(30, 'emp-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('assignee_id = $2'),
        ['30 days', 'emp-123']
      );
    });
  });
});
