/**
 * Unit tests for runtime type validators
 */
import { describe, it, expect } from 'vitest';
import {
  isTaskState,
  isAgentState,
  validateTaskPayload,
  isTaskPayload,
  validateExecutionMetrics,
  isExecutionMetrics,
  validateWorkError,
  isWorkError,
  validateWorkResult,
  isWorkResult,
  validateBloodbankEvent,
  isBloodbankEvent,
  validateStateTransition,
  isStateTransition,
  validateRecruitmentRequest,
  isRecruitmentRequest,
  createTaskPayload,
  createWorkResult,
} from './validators.js';

describe('Type Guards', () => {
  describe('isTaskState', () => {
    it('should return true for valid task states', () => {
      const validStates = ['draft', 'open', 'ready', 'assigned', 'in_progress', 'blocked', 'in_review', 'done', 'failed', 'cancelled'];
      validStates.forEach(state => {
        expect(isTaskState(state)).toBe(true);
      });
    });

    it('should return false for invalid task states', () => {
      expect(isTaskState('invalid')).toBe(false);
      expect(isTaskState('')).toBe(false);
      expect(isTaskState(null)).toBe(false);
      expect(isTaskState(undefined)).toBe(false);
      expect(isTaskState(123)).toBe(false);
    });
  });

  describe('isAgentState', () => {
    it('should return true for valid agent states', () => {
      const validStates = ['initializing', 'onboarding', 'idle', 'working', 'delegating', 'blocked', 'reviewing', 'errored', 'terminated'];
      validStates.forEach(state => {
        expect(isAgentState(state)).toBe(true);
      });
    });

    it('should return false for invalid agent states', () => {
      expect(isAgentState('invalid')).toBe(false);
      expect(isAgentState('')).toBe(false);
      expect(isAgentState(null)).toBe(false);
    });
  });
});

describe('validateTaskPayload', () => {
  const validTask = {
    id: 'task-123',
    correlationId: 'corr-456',
    objective: 'Test objective',
    context: { key: 'value' },
    createdAt: '2026-01-05T12:00:00Z',
  };

  it('should validate a valid TaskPayload', () => {
    const result = validateTaskPayload(validTask);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should fail if not an object', () => {
    expect(validateTaskPayload(null).valid).toBe(false);
    expect(validateTaskPayload('string').valid).toBe(false);
    expect(validateTaskPayload(123).valid).toBe(false);
  });

  it('should fail if id is missing or invalid', () => {
    const result = validateTaskPayload({ ...validTask, id: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'id')).toBe(true);
  });

  it('should fail if correlationId is missing or invalid', () => {
    const result = validateTaskPayload({ ...validTask, correlationId: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'correlationId')).toBe(true);
  });

  it('should fail if objective is missing or invalid', () => {
    const result = validateTaskPayload({ ...validTask, objective: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'objective')).toBe(true);
  });

  it('should fail if context is not an object', () => {
    const result = validateTaskPayload({ ...validTask, context: 'string' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'context')).toBe(true);
  });

  it('should validate optional fields correctly', () => {
    const taskWithOptional = {
      ...validTask,
      parentTaskId: 'parent-123',
      priority: 5,
      timeout: 30000,
      tags: ['tag1', 'tag2'],
      externalId: 'ext-123',
      planeWorkspace: '33god',
      planeProjectId: 'proj-123',
    };
    const result = validateTaskPayload(taskWithOptional);
    expect(result.valid).toBe(true);
  });

  it('should fail if timeout is not positive', () => {
    const result = validateTaskPayload({ ...validTask, timeout: -1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'timeout')).toBe(true);
  });

  it('should fail if tags contains non-strings', () => {
    const result = validateTaskPayload({ ...validTask, tags: ['valid', 123] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'tags')).toBe(true);
  });
});

describe('isTaskPayload', () => {
  it('should return true for valid TaskPayload', () => {
    const validTask = {
      id: 'task-123',
      correlationId: 'corr-456',
      objective: 'Test objective',
      context: {},
      createdAt: '2026-01-05T12:00:00Z',
    };
    expect(isTaskPayload(validTask)).toBe(true);
  });

  it('should return false for invalid TaskPayload', () => {
    expect(isTaskPayload({ id: '' })).toBe(false);
  });
});

describe('validateExecutionMetrics', () => {
  const validMetrics = {
    durationMs: 1000,
  };

  it('should validate valid metrics', () => {
    const result = validateExecutionMetrics(validMetrics);
    expect(result.valid).toBe(true);
  });

  it('should fail if durationMs is negative', () => {
    const result = validateExecutionMetrics({ durationMs: -1 });
    expect(result.valid).toBe(false);
  });

  it('should validate optional fields', () => {
    const metricsWithOptional = {
      durationMs: 1000,
      tokensUsed: 500,
      costUsd: 0.01,
      retries: 2,
      delegationDepth: 1,
    };
    const result = validateExecutionMetrics(metricsWithOptional);
    expect(result.valid).toBe(true);
  });

  it('should fail if retries is not an integer', () => {
    const result = validateExecutionMetrics({ durationMs: 100, retries: 1.5 });
    expect(result.valid).toBe(false);
  });
});

describe('validateWorkError', () => {
  const validError = {
    code: 'ERR_001',
    message: 'Something went wrong',
    retryable: true,
  };

  it('should validate valid error', () => {
    const result = validateWorkError(validError);
    expect(result.valid).toBe(true);
  });

  it('should fail if code is empty', () => {
    const result = validateWorkError({ ...validError, code: '' });
    expect(result.valid).toBe(false);
  });

  it('should fail if retryable is not boolean', () => {
    const result = validateWorkError({ ...validError, retryable: 'yes' });
    expect(result.valid).toBe(false);
  });

  it('should validate optional stack and cause', () => {
    const errorWithOptional = {
      ...validError,
      stack: 'Error\n  at ...',
      cause: 'Original error',
    };
    const result = validateWorkError(errorWithOptional);
    expect(result.valid).toBe(true);
  });
});

describe('validateWorkResult', () => {
  const validResult = {
    status: 'success',
    output: { data: 'result' },
    metrics: { durationMs: 1000 },
    completedAt: '2026-01-05T12:00:00Z',
  };

  it('should validate valid result', () => {
    const result = validateWorkResult(validResult);
    expect(result.valid).toBe(true);
  });

  it('should fail for invalid status', () => {
    const result = validateWorkResult({ ...validResult, status: 'invalid' });
    expect(result.valid).toBe(false);
  });

  it('should validate all valid statuses', () => {
    const statuses = ['success', 'failure', 'delegated', 'blocked', 'timeout'];
    statuses.forEach(status => {
      const result = validateWorkResult({ ...validResult, status });
      expect(result.valid).toBe(true);
    });
  });

  it('should validate failure with error', () => {
    const failureResult = {
      ...validResult,
      status: 'failure',
      error: {
        code: 'ERR_001',
        message: 'Failed',
        retryable: false,
      },
    };
    const result = validateWorkResult(failureResult);
    expect(result.valid).toBe(true);
  });

  it('should propagate metrics validation errors', () => {
    const result = validateWorkResult({
      ...validResult,
      metrics: { durationMs: -1 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path.startsWith('metrics'))).toBe(true);
  });
});

describe('validateBloodbankEvent', () => {
  const validEvent = {
    event: 'yi.agent.created',
    version: '1.0.0',
    data: { agentId: 'agent-123' },
    exchange: 'amq.topic',
    routingKey: 'yi.agent.created',
    correlationId: 'corr-456',
    timestamp: '2026-01-05T12:00:00Z',
    source: 'yi.boot',
  };

  it('should validate valid event', () => {
    const result = validateBloodbankEvent(validEvent);
    expect(result.valid).toBe(true);
  });

  it('should fail if event is empty', () => {
    const result = validateBloodbankEvent({ ...validEvent, event: '' });
    expect(result.valid).toBe(false);
  });

  it('should validate optional causationId', () => {
    const eventWithCausation = {
      ...validEvent,
      causationId: 'cause-123',
    };
    const result = validateBloodbankEvent(eventWithCausation);
    expect(result.valid).toBe(true);
  });

  it('should fail if data is not an object', () => {
    const result = validateBloodbankEvent({ ...validEvent, data: 'string' });
    expect(result.valid).toBe(false);
  });
});

describe('validateStateTransition', () => {
  const validTransition = {
    employeeId: 'emp-123',
    fromState: 'idle',
    toState: 'working',
    trigger: 'task_assigned',
    timestamp: '2026-01-05T12:00:00Z',
  };

  it('should validate valid transition', () => {
    const result = validateStateTransition(validTransition);
    expect(result.valid).toBe(true);
  });

  it('should fail for invalid fromState', () => {
    const result = validateStateTransition({ ...validTransition, fromState: 'invalid' });
    expect(result.valid).toBe(false);
  });

  it('should fail for invalid toState', () => {
    const result = validateStateTransition({ ...validTransition, toState: 'invalid' });
    expect(result.valid).toBe(false);
  });

  it('should fail for invalid state transitions', () => {
    // terminated is a terminal state - cannot transition from it
    const result = validateStateTransition({
      ...validTransition,
      fromState: 'terminated',
      toState: 'idle',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Invalid state transition'))).toBe(true);
  });

  it('should allow valid state transitions', () => {
    const validTransitions = [
      { from: 'initializing', to: 'onboarding' },
      { from: 'onboarding', to: 'idle' },
      { from: 'idle', to: 'working' },
      { from: 'working', to: 'blocked' },
      { from: 'blocked', to: 'idle' },
      { from: 'errored', to: 'idle' },
    ];

    validTransitions.forEach(({ from, to }) => {
      const result = validateStateTransition({
        ...validTransition,
        fromState: from,
        toState: to,
      });
      expect(result.valid).toBe(true);
    });
  });

  it('should validate optional taskId and error', () => {
    const transitionWithOptional = {
      ...validTransition,
      taskId: 'task-123',
      error: 'Some error occurred',
    };
    const result = validateStateTransition(transitionWithOptional);
    expect(result.valid).toBe(true);
  });
});

describe('validateRecruitmentRequest', () => {
  const validRequest = {
    requiredSkills: ['python', 'typescript'],
    reportingToManagerId: 'mgr-123',
    teamId: 'team-456',
  };

  it('should validate valid request', () => {
    const result = validateRecruitmentRequest(validRequest);
    expect(result.valid).toBe(true);
  });

  it('should fail if requiredSkills is not an array', () => {
    const result = validateRecruitmentRequest({ ...validRequest, requiredSkills: 'python' });
    expect(result.valid).toBe(false);
  });

  it('should fail if requiredSkills contains non-strings', () => {
    const result = validateRecruitmentRequest({ ...validRequest, requiredSkills: ['python', 123] });
    expect(result.valid).toBe(false);
  });

  it('should fail if reportingToManagerId is empty', () => {
    const result = validateRecruitmentRequest({ ...validRequest, reportingToManagerId: '' });
    expect(result.valid).toBe(false);
  });

  it('should validate optional fields', () => {
    const requestWithOptional = {
      ...validRequest,
      preferredFramework: 'letta',
      isContractor: true,
    };
    const result = validateRecruitmentRequest(requestWithOptional);
    expect(result.valid).toBe(true);
  });
});

describe('createTaskPayload', () => {
  it('should create a valid TaskPayload', () => {
    const task = createTaskPayload({
      id: 'task-123',
      correlationId: 'corr-456',
      objective: 'Test objective',
    });

    expect(task.id).toBe('task-123');
    expect(task.correlationId).toBe('corr-456');
    expect(task.objective).toBe('Test objective');
    expect(task.context).toEqual({});
    expect(task.createdAt).toBeDefined();
  });

  it('should preserve optional fields', () => {
    const task = createTaskPayload({
      id: 'task-123',
      correlationId: 'corr-456',
      objective: 'Test objective',
      priority: 5,
      tags: ['urgent'],
    });

    expect(task.priority).toBe(5);
    expect(task.tags).toEqual(['urgent']);
  });

  it('should throw on invalid input', () => {
    expect(() => createTaskPayload({
      id: '',
      correlationId: 'corr-456',
      objective: 'Test',
    })).toThrow('Invalid TaskPayload');
  });
});

describe('createWorkResult', () => {
  it('should create a valid WorkResult', () => {
    const result = createWorkResult({
      status: 'success',
      output: { data: 'result' },
      metrics: { durationMs: 1000 },
    });

    expect(result.status).toBe('success');
    expect(result.output).toEqual({ data: 'result' });
    expect(result.metrics.durationMs).toBe(1000);
    expect(result.completedAt).toBeDefined();
  });

  it('should throw on invalid input', () => {
    expect(() => createWorkResult({
      status: 'invalid' as any,
      output: null,
      metrics: { durationMs: 100 },
    })).toThrow('Invalid WorkResult');
  });
});
