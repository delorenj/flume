/**
 * Unit tests for FirstMatchSelection strategy
 */
import { describe, it, expect, vi } from 'vitest';
import { FirstMatchSelection } from './first-match.js';
import type { Employee, TaskPayload, Contributor, AgentState } from '@flume/core';

/**
 * Create a mock task payload for testing.
 */
function createMockTask(objective = 'Test objective'): TaskPayload {
  return {
    id: 'task-123',
    correlationId: 'corr-456',
    objective,
    context: {},
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a mock Contributor that can handle tasks.
 */
function createMockContributor(
  name: string,
  canHandle: boolean | (() => boolean | Promise<boolean>) = true,
  state: AgentState = 'idle'
): Contributor {
  const canHandleFn = typeof canHandle === 'function' ? canHandle : () => canHandle;
  return {
    id: `contrib-${name}`,
    name,
    role: 'contributor',
    teamId: 'team-1',
    skills: ['testing'],
    salary: 50000,
    state,
    canHandle: vi.fn(canHandleFn),
    execute: vi.fn(),
    reportStatus: vi.fn(),
  };
}

/**
 * Create a mock Employee that is NOT a Contributor (Manager/Director).
 */
function createMockEmployee(name: string, state: AgentState = 'idle'): Employee {
  return {
    id: `emp-${name}`,
    name,
    role: 'manager',
    teamId: 'team-1',
    skills: ['management'],
    salary: 75000,
    state,
    reportStatus: vi.fn(),
  };
}

describe('FirstMatchSelection', () => {
  describe('basic selection', () => {
    it('should have the correct name', () => {
      const strategy = new FirstMatchSelection();
      expect(strategy.name).toBe('first-match');
    });

    it('should return null for empty candidates array', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();

      const result = await strategy.select(task, []);

      expect(result).toBeNull();
    });

    it('should select the first capable contributor', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [
        createMockContributor('Agent 1', false),
        createMockContributor('Agent 2', true),
        createMockContributor('Agent 3', true),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Agent 2');
    });

    it('should return null when no candidate can handle the task', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [
        createMockContributor('Agent 1', false),
        createMockContributor('Agent 2', false),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).toBeNull();
    });
  });

  describe('with single candidate', () => {
    it('should select the only candidate if they can handle the task', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [createMockContributor('Solo Developer', true)];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Solo Developer');
    });

    it('should return null if the only candidate cannot handle the task', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [createMockContributor('Unavailable Agent', false)];

      const result = await strategy.select(task, candidates);

      expect(result).toBeNull();
    });
  });

  describe('non-Contributor handling', () => {
    it('should select idle non-Contributor (Manager/Director)', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [createMockEmployee('Manager', 'idle')];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Manager');
    });

    it('should skip non-idle non-Contributors', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [
        createMockEmployee('Busy Manager', 'working'),
        createMockContributor('Available Contributor', true),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Available Contributor');
    });

    it('should return null for non-idle non-Contributor with no other candidates', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [createMockEmployee('Busy Manager', 'working')];

      const result = await strategy.select(task, candidates);

      expect(result).toBeNull();
    });
  });

  describe('mixed Contributors and non-Contributors', () => {
    it('should handle mixed candidate types correctly', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [
        createMockContributor('Contributor 1', false), // Can't handle
        createMockEmployee('Manager', 'working'),      // Not idle
        createMockContributor('Contributor 2', true),  // Can handle - should be selected
        createMockEmployee('Director', 'idle'),         // Idle but comes after
      ];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Contributor 2');
    });

    it('should select first idle non-Contributor when contributors cannot handle', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const candidates = [
        createMockContributor('Busy Contributor', false),
        createMockEmployee('Manager', 'idle'),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Manager');
    });
  });

  describe('async canHandle', () => {
    it('should handle async canHandle methods', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const asyncCanHandle = async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return true;
      };
      const candidates = [createMockContributor('Async Contributor', asyncCanHandle)];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Async Contributor');
    });

    it('should skip candidates with async canHandle returning false', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const asyncCanHandleFalse = async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return false;
      };
      const asyncCanHandleTrue = async () => true;
      const candidates = [
        createMockContributor('Cannot Handle', asyncCanHandleFalse),
        createMockContributor('Can Handle', asyncCanHandleTrue),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Can Handle');
    });
  });

  describe('order preservation', () => {
    it('should always select the first matching candidate', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();

      // Run selection multiple times - should always return Agent 1
      for (let i = 0; i < 5; i++) {
        const candidates = [
          createMockContributor('Agent 1', true),
          createMockContributor('Agent 2', true),
          createMockContributor('Agent 3', true),
        ];

        const result = await strategy.select(task, candidates);

        expect(result?.name).toBe('Agent 1');
      }
    });
  });

  describe('canHandle invocation', () => {
    it('should call canHandle on each contributor until one matches', async () => {
      const strategy = new FirstMatchSelection();
      const task = createMockTask();
      const contributor1 = createMockContributor('Agent 1', false);
      const contributor2 = createMockContributor('Agent 2', true);
      const contributor3 = createMockContributor('Agent 3', true);

      await strategy.select(task, [contributor1, contributor2, contributor3]);

      expect(contributor1.canHandle).toHaveBeenCalledWith(task);
      expect(contributor2.canHandle).toHaveBeenCalledWith(task);
      // Should not be called since agent 2 matched
      expect(contributor3.canHandle).not.toHaveBeenCalled();
    });
  });
});
