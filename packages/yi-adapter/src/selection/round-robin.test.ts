/**
 * Unit tests for RoundRobinSelection strategy
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RoundRobinSelection } from './first-match.js';
import type { Employee, Contributor, TaskPayload, AgentState, EmployeeStatus } from '@flume/core';

/**
 * Create a mock Contributor for testing
 */
function createMockContributor(
  overrides: Partial<Contributor> & { canHandleResult?: boolean } = {}
): Contributor {
  const canHandleResult = overrides.canHandleResult ?? true;
  return {
    id: overrides.id ?? `contributor-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'Test Contributor',
    role: overrides.role ?? 'Developer',
    state: overrides.state ?? 'idle',
    teamId: overrides.teamId ?? 'team-1',
    skills: overrides.skills ?? ['typescript'],
    salary: overrides.salary ?? 100000,
    reportStatus: vi.fn().mockResolvedValue({
      state: overrides.state ?? 'idle',
      message: 'Ready',
      timestamp: new Date().toISOString(),
    } as EmployeeStatus),
    canHandle: vi.fn().mockReturnValue(canHandleResult),
    execute: vi.fn().mockResolvedValue({
      taskId: 'task-1',
      status: 'completed',
      output: 'Done',
      artifacts: [],
      metrics: { startTime: '', endTime: '', duration: 0 },
    }),
  };
}

/**
 * Create a mock Employee (non-Contributor) for testing
 */
function createMockEmployee(
  overrides: Partial<Employee> = {}
): Employee {
  return {
    id: overrides.id ?? `employee-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'Test Employee',
    role: overrides.role ?? 'Manager',
    state: overrides.state ?? 'idle',
    teamId: overrides.teamId ?? 'team-1',
    skills: overrides.skills ?? ['leadership'],
    salary: overrides.salary ?? 150000,
    reportStatus: vi.fn().mockResolvedValue({
      state: overrides.state ?? 'idle',
      message: 'Ready',
      timestamp: new Date().toISOString(),
    } as EmployeeStatus),
  };
}

/**
 * Create a mock TaskPayload for testing
 */
function createMockTask(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2)}`,
    objective: overrides.objective ?? 'Test objective',
    context: overrides.context ?? 'Test context',
    origin: overrides.origin ?? { agentId: 'test-origin', timestamp: new Date().toISOString() },
  };
}

describe('RoundRobinSelection', () => {
  let strategy: RoundRobinSelection;

  beforeEach(() => {
    strategy = new RoundRobinSelection();
    vi.clearAllMocks();
  });

  describe('name property', () => {
    it('should have the correct name', () => {
      expect(strategy.name).toBe('round-robin');
    });
  });

  describe('select with empty candidates', () => {
    it('should return null when no candidates provided', async () => {
      const task = createMockTask();
      const result = await strategy.select(task, []);
      expect(result).toBeNull();
    });
  });

  describe('select with single candidate', () => {
    it('should select the only candidate if they can handle the task', async () => {
      const task = createMockTask();
      const contributor = createMockContributor({ name: 'Solo Developer' });

      const result = await strategy.select(task, [contributor]);

      expect(result).toBe(contributor);
      expect(contributor.canHandle).toHaveBeenCalledWith(task);
    });

    it('should return null if single candidate cannot handle the task', async () => {
      const task = createMockTask();
      const contributor = createMockContributor({
        name: 'Unavailable Dev',
        canHandleResult: false,
      });

      const result = await strategy.select(task, [contributor]);

      expect(result).toBeNull();
    });
  });

  describe('round-robin rotation with multiple agents', () => {
    it('should rotate through candidates on successive calls', async () => {
      const task = createMockTask();
      const agents = [
        createMockContributor({ id: 'agent-0', name: 'Agent 0' }),
        createMockContributor({ id: 'agent-1', name: 'Agent 1' }),
        createMockContributor({ id: 'agent-2', name: 'Agent 2' }),
      ];

      // First call should select agent-0 (starting from index 0)
      const result1 = await strategy.select(task, agents);
      expect(result1?.id).toBe('agent-0');

      // Second call should select agent-1
      const result2 = await strategy.select(task, agents);
      expect(result2?.id).toBe('agent-1');

      // Third call should select agent-2
      const result3 = await strategy.select(task, agents);
      expect(result3?.id).toBe('agent-2');
    });

    it('should wrap around to the beginning after reaching the end', async () => {
      const task = createMockTask();
      const agents = [
        createMockContributor({ id: 'agent-0', name: 'Agent 0' }),
        createMockContributor({ id: 'agent-1', name: 'Agent 1' }),
      ];

      // Exhaust the list
      await strategy.select(task, agents); // agent-0
      await strategy.select(task, agents); // agent-1

      // Should wrap back to agent-0
      const result = await strategy.select(task, agents);
      expect(result?.id).toBe('agent-0');
    });
  });

  describe('skipping agents that cannot handle the task', () => {
    it('should skip agents that cannot handle the task', async () => {
      const task = createMockTask();
      const agents = [
        createMockContributor({ id: 'agent-0', name: 'Agent 0', canHandleResult: false }),
        createMockContributor({ id: 'agent-1', name: 'Agent 1', canHandleResult: true }),
        createMockContributor({ id: 'agent-2', name: 'Agent 2', canHandleResult: false }),
      ];

      // Should skip agent-0 and select agent-1
      const result = await strategy.select(task, agents);
      expect(result?.id).toBe('agent-1');
    });

    it('should return null if no agent can handle the task', async () => {
      const task = createMockTask();
      const agents = [
        createMockContributor({ id: 'agent-0', canHandleResult: false }),
        createMockContributor({ id: 'agent-1', canHandleResult: false }),
        createMockContributor({ id: 'agent-2', canHandleResult: false }),
      ];

      const result = await strategy.select(task, agents);
      expect(result).toBeNull();
    });

    it('should continue rotation after skipping agents', async () => {
      const task = createMockTask();
      const agents = [
        createMockContributor({ id: 'agent-0', canHandleResult: true }),
        createMockContributor({ id: 'agent-1', canHandleResult: false }), // Will be skipped
        createMockContributor({ id: 'agent-2', canHandleResult: true }),
      ];

      // First call: agent-0
      const result1 = await strategy.select(task, agents);
      expect(result1?.id).toBe('agent-0');

      // Second call: should try agent-1, skip it, select agent-2
      const result2 = await strategy.select(task, agents);
      expect(result2?.id).toBe('agent-2');

      // Third call: should try agent-0 (wrap), select it
      const result3 = await strategy.select(task, agents);
      expect(result3?.id).toBe('agent-0');
    });
  });

  describe('handling non-Contributor employees', () => {
    it('should select idle non-Contributors', async () => {
      const task = createMockTask();
      const employee = createMockEmployee({ id: 'manager-1', state: 'idle' });

      const result = await strategy.select(task, [employee]);
      expect(result?.id).toBe('manager-1');
    });

    it('should skip busy non-Contributors', async () => {
      const task = createMockTask();
      const busyManager = createMockEmployee({ id: 'manager-1', state: 'working' });
      const idleManager = createMockEmployee({ id: 'manager-2', state: 'idle' });

      const result = await strategy.select(task, [busyManager, idleManager]);
      expect(result?.id).toBe('manager-2');
    });
  });

  describe('mixed Contributors and non-Contributors', () => {
    it('should handle mixed candidate types correctly', async () => {
      const task = createMockTask();
      const contributors = [
        createMockContributor({ id: 'contributor-0' }),
        createMockEmployee({ id: 'manager-1', state: 'idle' }),
        createMockContributor({ id: 'contributor-2' }),
      ];

      // Should rotate through all types
      const result1 = await strategy.select(task, contributors);
      expect(result1?.id).toBe('contributor-0');

      const result2 = await strategy.select(task, contributors);
      expect(result2?.id).toBe('manager-1');

      const result3 = await strategy.select(task, contributors);
      expect(result3?.id).toBe('contributor-2');
    });
  });

  describe('tracks last-selected index correctly', () => {
    it('should update lastIndex after each selection', async () => {
      const task = createMockTask();
      const agents = [
        createMockContributor({ id: 'agent-0' }),
        createMockContributor({ id: 'agent-1' }),
        createMockContributor({ id: 'agent-2' }),
        createMockContributor({ id: 'agent-3' }),
        createMockContributor({ id: 'agent-4' }),
      ];

      // Select multiple times and verify the pattern
      const selections: string[] = [];
      for (let i = 0; i < 10; i++) {
        const result = await strategy.select(task, agents);
        if (result) {
          selections.push(result.id);
        }
      }

      // Should cycle through 0,1,2,3,4,0,1,2,3,4
      expect(selections).toEqual([
        'agent-0',
        'agent-1',
        'agent-2',
        'agent-3',
        'agent-4',
        'agent-0',
        'agent-1',
        'agent-2',
        'agent-3',
        'agent-4',
      ]);
    });

    it('should maintain index state independently per strategy instance', async () => {
      const task = createMockTask();
      const agents = [
        createMockContributor({ id: 'agent-0' }),
        createMockContributor({ id: 'agent-1' }),
      ];

      const strategy1 = new RoundRobinSelection();
      const strategy2 = new RoundRobinSelection();

      // Advance strategy1
      await strategy1.select(task, agents); // agent-0
      await strategy1.select(task, agents); // agent-1

      // strategy2 should start fresh
      const result = await strategy2.select(task, agents);
      expect(result?.id).toBe('agent-0');
    });
  });

  describe('async canHandle', () => {
    it('should handle async canHandle methods', async () => {
      const task = createMockTask();
      const asyncContributor = createMockContributor({ id: 'async-agent' });
      (asyncContributor.canHandle as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const result = await strategy.select(task, [asyncContributor]);
      expect(result?.id).toBe('async-agent');
    });
  });
});
