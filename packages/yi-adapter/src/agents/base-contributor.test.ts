/**
 * Unit tests for BaseContributor abstract class
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseContributor } from './base-contributor.js';
import type { TaskPayload } from '@flume/core';

/**
 * Concrete implementation of BaseContributor for testing.
 */
class TestContributor extends BaseContributor {
  public workResult: unknown = { success: true };
  public shouldThrow = false;
  public throwError: Error | null = null;

  protected async doWork(task: TaskPayload): Promise<unknown> {
    if (this.shouldThrow) {
      throw this.throwError ?? new Error('Test error');
    }
    return this.workResult;
  }

  // Expose protected methods for testing
  public testTransitionTo(state: Parameters<BaseContributor['transitionTo']>[0], trigger: string): void {
    this.transitionTo(state, trigger);
  }

  public getMemory() {
    return this._memory;
  }

  public getCurrentTaskId() {
    return this._currentTaskId;
  }
}

/**
 * Create a mock task for testing.
 */
function createMockTask(options: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: 'task-123',
    correlationId: 'corr-456',
    objective: 'Test objective',
    context: {},
    createdAt: new Date().toISOString(),
    ...options,
  };
}

describe('BaseContributor', () => {
  let contributor: TestContributor;

  beforeEach(() => {
    contributor = new TestContributor({
      name: 'Test Contributor',
      role: 'developer',
      teamId: 'team-1',
      skills: ['typescript', 'testing'],
    });
  });

  describe('constructor', () => {
    it('should create contributor with provided values', () => {
      const contrib = new TestContributor({
        id: 'custom-id',
        name: 'Custom Name',
        role: 'engineer',
        teamId: 'team-2',
        skills: ['python'],
        salary: 100000,
      });

      expect(contrib.id).toBe('custom-id');
      expect(contrib.name).toBe('Custom Name');
      expect(contrib.role).toBe('engineer');
      expect(contrib.teamId).toBe('team-2');
      expect(contrib.skills).toEqual(['python']);
      expect(contrib.salary).toBe(100000);
    });

    it('should generate UUID when id not provided', () => {
      expect(contributor.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('should use default salary when not provided', () => {
      expect(contributor.salary).toBe(50000);
    });

    it('should initialize in initializing state', () => {
      expect(contributor.state).toBe('initializing');
    });
  });

  describe('state transitions', () => {
    it('should transition from initializing to onboarding', () => {
      contributor.testTransitionTo('onboarding', 'test');
      expect(contributor.state).toBe('onboarding');
    });

    it('should throw on invalid state transition', () => {
      expect(() => contributor.testTransitionTo('working', 'invalid')).toThrow(
        'Invalid state transition: initializing -> working'
      );
    });

    it('should support full lifecycle transitions', async () => {
      // initializing -> onboarding
      contributor.testTransitionTo('onboarding', 'start');
      expect(contributor.state).toBe('onboarding');

      // onboarding -> idle
      contributor.testTransitionTo('idle', 'ready');
      expect(contributor.state).toBe('idle');

      // idle -> working
      contributor.testTransitionTo('working', 'task');
      expect(contributor.state).toBe('working');

      // working -> idle
      contributor.testTransitionTo('idle', 'done');
      expect(contributor.state).toBe('idle');
    });
  });

  describe('reportStatus', () => {
    it('should report current status', async () => {
      const status = await contributor.reportStatus();

      expect(status.state).toBe('initializing');
      expect(status.currentTaskId).toBeUndefined();
      expect(status.message).toBe('Starting up...');
      expect(status.timestamp).toBeDefined();
    });

    it('should include current task id when working', async () => {
      // Setup: get to idle state
      contributor.testTransitionTo('onboarding', 'start');
      contributor.testTransitionTo('idle', 'ready');

      // Start executing (this sets currentTaskId)
      const task = createMockTask();
      const executePromise = contributor.execute(task);

      // Status should show working state and task id
      // Note: we need to check immediately or the execution will complete
      expect(contributor.state).toBe('working');
      expect(contributor.getCurrentTaskId()).toBe('task-123');

      await executePromise;
    });

    it('should report different messages for different states', async () => {
      // onboarding
      contributor.testTransitionTo('onboarding', 'start');
      let status = await contributor.reportStatus();
      expect(status.message).toBe('Learning the ropes...');

      // idle
      contributor.testTransitionTo('idle', 'ready');
      status = await contributor.reportStatus();
      expect(status.message).toBe('Ready for work');
    });
  });

  describe('canHandle', () => {
    beforeEach(async () => {
      // Get to idle state
      contributor.testTransitionTo('onboarding', 'start');
      contributor.testTransitionTo('idle', 'ready');
    });

    it('should return false when not idle', async () => {
      contributor.testTransitionTo('working', 'task');

      const task = createMockTask();
      expect(contributor.canHandle(task)).toBe(false);
    });

    it('should return true when idle and no tags', () => {
      const task = createMockTask({ tags: [] });
      expect(contributor.canHandle(task)).toBe(true);
    });

    it('should return true when task tags match skills', () => {
      const task = createMockTask({ tags: ['typescript'] });
      expect(contributor.canHandle(task)).toBe(true);
    });

    it('should return true when objective contains skill name', () => {
      const task = createMockTask({ objective: 'Write TypeScript tests' });
      expect(contributor.canHandle(task)).toBe(true);
    });

    it('should return false when tags do not match skills', () => {
      const task = createMockTask({ tags: ['rust', 'c++'] });
      expect(contributor.canHandle(task)).toBe(false);
    });

    it('should match skill in lowercase task tags', () => {
      // Implementation lowercases the skill, not the tag
      // So this matches because 'typescript'.toLowerCase() === 'typescript'
      const task = createMockTask({ tags: ['typescript'] });
      expect(contributor.canHandle(task)).toBe(true);
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      // Get to idle state
      contributor.testTransitionTo('onboarding', 'start');
      contributor.testTransitionTo('idle', 'ready');
    });

    it('should execute task successfully', async () => {
      contributor.workResult = { data: 'test result' };
      const task = createMockTask();

      const result = await contributor.execute(task);

      expect(result.status).toBe('success');
      expect(result.output).toEqual({ data: 'test result' });
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAt).toBeDefined();
      expect(contributor.state).toBe('idle');
    });

    it('should return failure when not idle', async () => {
      contributor.testTransitionTo('working', 'other_task');

      const task = createMockTask();
      const result = await contributor.execute(task);

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('AGENT_BUSY');
      expect(result.error?.retryable).toBe(true);
    });

    it('should handle execution errors', async () => {
      contributor.shouldThrow = true;
      contributor.throwError = new Error('Something went wrong');

      const task = createMockTask();
      const result = await contributor.execute(task);

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toBe('Something went wrong');
      expect(contributor.state).toBe('errored');
    });

    it('should track current task id during execution', async () => {
      const task = createMockTask({ id: 'my-task-id' });

      // Start execution
      const promise = contributor.execute(task);

      // During execution, task id should be set
      expect(contributor.getCurrentTaskId()).toBe('my-task-id');

      await promise;

      // After completion, task id should be cleared
      expect(contributor.getCurrentTaskId()).toBeUndefined();
    });

    it('should measure duration correctly', async () => {
      // Simulate work that takes some time
      contributor.workResult = new Promise(resolve => {
        setTimeout(() => resolve({ done: true }), 50);
      });

      const task = createMockTask();
      const result = await contributor.execute(task);

      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(40); // Allow some tolerance
    });
  });

  describe('memory injection and onboarding', () => {
    it('should inject memory during onboarding', async () => {
      const memory = {
        mission: 'Test the code',
        tools: ['vitest', 'typescript'],
        protocols: ['TDD', 'Code Review'],
      };

      await contributor.injectMemory(memory);

      expect(contributor.state).toBe('onboarding');
      expect(contributor.getMemory()).toEqual(memory);
    });

    it('should verify readiness after memory injection', async () => {
      const memory = {
        mission: 'Test the code',
        tools: ['vitest'],
        protocols: [],
      };

      await contributor.injectMemory(memory);
      const isReady = await contributor.verifyReadiness();

      expect(isReady).toBe(true);
      expect(contributor.state).toBe('idle');
    });

    it('should not be ready without memory', async () => {
      // Manually transition to onboarding
      contributor.testTransitionTo('onboarding', 'manual');

      const isReady = await contributor.verifyReadiness();

      expect(isReady).toBe(false);
    });
  });

  describe('status messages', () => {
    it('should return initializing message', async () => {
      const contrib = new TestContributor({
        name: 'Test',
        role: 'dev',
        teamId: 'team',
        skills: [],
      });
      const status = await contrib.reportStatus();
      expect(status.message).toBe('Starting up...');
    });

    it('should return onboarding message', async () => {
      const contrib = new TestContributor({
        name: 'Test',
        role: 'dev',
        teamId: 'team',
        skills: [],
      });
      contrib.testTransitionTo('onboarding', 'start');
      const status = await contrib.reportStatus();
      expect(status.message).toBe('Learning the ropes...');
    });

    it('should return idle message', async () => {
      const contrib = new TestContributor({
        name: 'Test',
        role: 'dev',
        teamId: 'team',
        skills: [],
      });
      contrib.testTransitionTo('onboarding', 'start');
      contrib.testTransitionTo('idle', 'ready');
      const status = await contrib.reportStatus();
      expect(status.message).toBe('Ready for work');
    });

    it('should return working message with task id', async () => {
      const contrib = new TestContributor({
        name: 'Test',
        role: 'dev',
        teamId: 'team',
        skills: [],
      });
      contrib.testTransitionTo('onboarding', 'start');
      contrib.testTransitionTo('idle', 'ready');

      // Start task execution
      const task = createMockTask({ id: 'test-task-999' });
      contrib.workResult = new Promise(resolve => setTimeout(() => resolve({}), 100));
      const executePromise = contrib.execute(task);

      // Wait a tick for state to transition
      await new Promise(resolve => setTimeout(resolve, 10));

      const status = await contrib.reportStatus();
      expect(status.message).toBe('Working on task test-task-999');

      await executePromise;
    });

    it('should return blocked message', async () => {
      const contrib = new TestContributor({
        name: 'Test',
        role: 'dev',
        teamId: 'team',
        skills: [],
      });
      contrib.testTransitionTo('onboarding', 'start');
      contrib.testTransitionTo('idle', 'ready');
      contrib.testTransitionTo('working', 'task');
      contrib.testTransitionTo('blocked', 'waiting');
      const status = await contrib.reportStatus();
      expect(status.message).toBe('Waiting for external dependency');
    });

    it('should return errored message', async () => {
      const contrib = new TestContributor({
        name: 'Test',
        role: 'dev',
        teamId: 'team',
        skills: [],
      });
      contrib.testTransitionTo('onboarding', 'start');
      contrib.testTransitionTo('idle', 'ready');
      contrib.testTransitionTo('working', 'task');
      contrib.testTransitionTo('errored', 'error');
      const status = await contrib.reportStatus();
      expect(status.message).toBe('Encountered an error');
    });

    it('should return terminated message', async () => {
      const contrib = new TestContributor({
        name: 'Test',
        role: 'dev',
        teamId: 'team',
        skills: [],
      });
      contrib.testTransitionTo('onboarding', 'start');
      contrib.testTransitionTo('idle', 'ready');
      contrib.testTransitionTo('terminated', 'shutdown');
      const status = await contrib.reportStatus();
      expect(status.message).toBe('No longer active');
    });
  });
});
