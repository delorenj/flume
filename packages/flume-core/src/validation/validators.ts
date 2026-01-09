/**
 * Runtime Type Validation Helpers
 *
 * Provides runtime validation for Flume protocol types.
 * Use these to validate data at system boundaries (API inputs, message payloads, etc.)
 *
 * @category Validation
 */

import type { TaskPayload, TaskState, RecruitmentRequest } from '../types/task.js';
import type { WorkResult, ExecutionMetrics, WorkError, Artifact } from '../types/result.js';
import type { AgentState, StateTransition } from '../types/state.js';
import type { BloodbankEvent } from '../types/events.js';
import { VALID_TRANSITIONS, isValidTransition } from '../types/state.js';

/**
 * Validation result with detailed error information.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Individual validation error.
 */
export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

/**
 * Type guard for TaskState.
 */
export function isTaskState(value: unknown): value is TaskState {
  const validStates: TaskState[] = [
    'draft', 'open', 'ready', 'assigned', 'in_progress',
    'blocked', 'in_review', 'done', 'failed', 'cancelled'
  ];
  return typeof value === 'string' && validStates.includes(value as TaskState);
}

/**
 * Type guard for AgentState.
 */
export function isAgentState(value: unknown): value is AgentState {
  const validStates: AgentState[] = [
    'initializing', 'onboarding', 'idle', 'working', 'delegating',
    'blocked', 'reviewing', 'errored', 'terminated'
  ];
  return typeof value === 'string' && validStates.includes(value as AgentState);
}

/**
 * Validates a TaskPayload object.
 */
export function validateTaskPayload(task: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!task || typeof task !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'TaskPayload must be an object' }] };
  }

  const t = task as Record<string, unknown>;

  // Required fields
  if (typeof t.id !== 'string' || t.id.length === 0) {
    errors.push({ path: 'id', message: 'id must be a non-empty string', value: t.id });
  }

  if (typeof t.correlationId !== 'string' || t.correlationId.length === 0) {
    errors.push({ path: 'correlationId', message: 'correlationId must be a non-empty string', value: t.correlationId });
  }

  if (typeof t.objective !== 'string' || t.objective.length === 0) {
    errors.push({ path: 'objective', message: 'objective must be a non-empty string', value: t.objective });
  }

  if (t.context !== undefined && (typeof t.context !== 'object' || t.context === null)) {
    errors.push({ path: 'context', message: 'context must be an object', value: t.context });
  }

  if (typeof t.createdAt !== 'string') {
    errors.push({ path: 'createdAt', message: 'createdAt must be a string (ISO timestamp)', value: t.createdAt });
  }

  // Optional fields with type constraints
  if (t.parentTaskId !== undefined && typeof t.parentTaskId !== 'string') {
    errors.push({ path: 'parentTaskId', message: 'parentTaskId must be a string', value: t.parentTaskId });
  }

  if (t.priority !== undefined && typeof t.priority !== 'number') {
    errors.push({ path: 'priority', message: 'priority must be a number', value: t.priority });
  }

  if (t.timeout !== undefined && (typeof t.timeout !== 'number' || t.timeout <= 0)) {
    errors.push({ path: 'timeout', message: 'timeout must be a positive number', value: t.timeout });
  }

  if (t.tags !== undefined && !Array.isArray(t.tags)) {
    errors.push({ path: 'tags', message: 'tags must be an array', value: t.tags });
  } else if (Array.isArray(t.tags) && !t.tags.every(tag => typeof tag === 'string')) {
    errors.push({ path: 'tags', message: 'all tags must be strings', value: t.tags });
  }

  if (t.externalId !== undefined && typeof t.externalId !== 'string') {
    errors.push({ path: 'externalId', message: 'externalId must be a string', value: t.externalId });
  }

  if (t.planeWorkspace !== undefined && typeof t.planeWorkspace !== 'string') {
    errors.push({ path: 'planeWorkspace', message: 'planeWorkspace must be a string', value: t.planeWorkspace });
  }

  if (t.planeProjectId !== undefined && typeof t.planeProjectId !== 'string') {
    errors.push({ path: 'planeProjectId', message: 'planeProjectId must be a string', value: t.planeProjectId });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for TaskPayload.
 */
export function isTaskPayload(value: unknown): value is TaskPayload {
  return validateTaskPayload(value).valid;
}

/**
 * Validates an ExecutionMetrics object.
 */
export function validateExecutionMetrics(metrics: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!metrics || typeof metrics !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'ExecutionMetrics must be an object' }] };
  }

  const m = metrics as Record<string, unknown>;

  if (typeof m.durationMs !== 'number' || m.durationMs < 0) {
    errors.push({ path: 'durationMs', message: 'durationMs must be a non-negative number', value: m.durationMs });
  }

  if (m.tokensUsed !== undefined && (typeof m.tokensUsed !== 'number' || m.tokensUsed < 0)) {
    errors.push({ path: 'tokensUsed', message: 'tokensUsed must be a non-negative number', value: m.tokensUsed });
  }

  if (m.costUsd !== undefined && (typeof m.costUsd !== 'number' || m.costUsd < 0)) {
    errors.push({ path: 'costUsd', message: 'costUsd must be a non-negative number', value: m.costUsd });
  }

  if (m.retries !== undefined && (typeof m.retries !== 'number' || m.retries < 0 || !Number.isInteger(m.retries))) {
    errors.push({ path: 'retries', message: 'retries must be a non-negative integer', value: m.retries });
  }

  if (m.delegationDepth !== undefined && (typeof m.delegationDepth !== 'number' || m.delegationDepth < 0 || !Number.isInteger(m.delegationDepth))) {
    errors.push({ path: 'delegationDepth', message: 'delegationDepth must be a non-negative integer', value: m.delegationDepth });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for ExecutionMetrics.
 */
export function isExecutionMetrics(value: unknown): value is ExecutionMetrics {
  return validateExecutionMetrics(value).valid;
}

/**
 * Validates a WorkError object.
 */
export function validateWorkError(error: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!error || typeof error !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'WorkError must be an object' }] };
  }

  const e = error as Record<string, unknown>;

  if (typeof e.code !== 'string' || e.code.length === 0) {
    errors.push({ path: 'code', message: 'code must be a non-empty string', value: e.code });
  }

  if (typeof e.message !== 'string') {
    errors.push({ path: 'message', message: 'message must be a string', value: e.message });
  }

  if (typeof e.retryable !== 'boolean') {
    errors.push({ path: 'retryable', message: 'retryable must be a boolean', value: e.retryable });
  }

  if (e.stack !== undefined && typeof e.stack !== 'string') {
    errors.push({ path: 'stack', message: 'stack must be a string', value: e.stack });
  }

  if (e.cause !== undefined && typeof e.cause !== 'string') {
    errors.push({ path: 'cause', message: 'cause must be a string', value: e.cause });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for WorkError.
 */
export function isWorkError(value: unknown): value is WorkError {
  return validateWorkError(value).valid;
}

/**
 * Validates a WorkResult object.
 */
export function validateWorkResult(result: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!result || typeof result !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'WorkResult must be an object' }] };
  }

  const r = result as Record<string, unknown>;

  // Validate status
  const validStatuses = ['success', 'failure', 'delegated', 'blocked', 'timeout'];
  if (!validStatuses.includes(r.status as string)) {
    errors.push({ path: 'status', message: `status must be one of: ${validStatuses.join(', ')}`, value: r.status });
  }

  // Validate metrics
  if (!r.metrics || typeof r.metrics !== 'object') {
    errors.push({ path: 'metrics', message: 'metrics must be an object' });
  } else {
    const metricsResult = validateExecutionMetrics(r.metrics);
    if (!metricsResult.valid) {
      errors.push(...metricsResult.errors.map(e => ({ ...e, path: `metrics.${e.path}` })));
    }
  }

  if (typeof r.completedAt !== 'string') {
    errors.push({ path: 'completedAt', message: 'completedAt must be a string (ISO timestamp)', value: r.completedAt });
  }

  // Validate error if status is failure
  if (r.status === 'failure' && r.error) {
    const errorResult = validateWorkError(r.error);
    if (!errorResult.valid) {
      errors.push(...errorResult.errors.map(e => ({ ...e, path: `error.${e.path}` })));
    }
  }

  if (r.delegatedTo !== undefined && typeof r.delegatedTo !== 'string') {
    errors.push({ path: 'delegatedTo', message: 'delegatedTo must be a string', value: r.delegatedTo });
  }

  if (r.artifacts !== undefined && !Array.isArray(r.artifacts)) {
    errors.push({ path: 'artifacts', message: 'artifacts must be an array', value: r.artifacts });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for WorkResult.
 */
export function isWorkResult(value: unknown): value is WorkResult {
  return validateWorkResult(value).valid;
}

/**
 * Validates a BloodbankEvent object.
 */
export function validateBloodbankEvent(event: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'BloodbankEvent must be an object' }] };
  }

  const e = event as Record<string, unknown>;

  if (typeof e.event !== 'string' || e.event.length === 0) {
    errors.push({ path: 'event', message: 'event must be a non-empty string', value: e.event });
  }

  if (typeof e.version !== 'string' || e.version.length === 0) {
    errors.push({ path: 'version', message: 'version must be a non-empty string', value: e.version });
  }

  if (!e.data || typeof e.data !== 'object') {
    errors.push({ path: 'data', message: 'data must be an object' });
  }

  if (typeof e.exchange !== 'string' || e.exchange.length === 0) {
    errors.push({ path: 'exchange', message: 'exchange must be a non-empty string', value: e.exchange });
  }

  if (typeof e.routingKey !== 'string' || e.routingKey.length === 0) {
    errors.push({ path: 'routingKey', message: 'routingKey must be a non-empty string', value: e.routingKey });
  }

  if (typeof e.correlationId !== 'string' || e.correlationId.length === 0) {
    errors.push({ path: 'correlationId', message: 'correlationId must be a non-empty string', value: e.correlationId });
  }

  if (e.causationId !== undefined && typeof e.causationId !== 'string') {
    errors.push({ path: 'causationId', message: 'causationId must be a string', value: e.causationId });
  }

  if (typeof e.timestamp !== 'string') {
    errors.push({ path: 'timestamp', message: 'timestamp must be a string (ISO timestamp)', value: e.timestamp });
  }

  if (typeof e.source !== 'string' || e.source.length === 0) {
    errors.push({ path: 'source', message: 'source must be a non-empty string', value: e.source });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for BloodbankEvent.
 */
export function isBloodbankEvent(value: unknown): value is BloodbankEvent {
  return validateBloodbankEvent(value).valid;
}

/**
 * Validates a StateTransition object.
 */
export function validateStateTransition(transition: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!transition || typeof transition !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'StateTransition must be an object' }] };
  }

  const t = transition as Record<string, unknown>;

  if (typeof t.employeeId !== 'string' || t.employeeId.length === 0) {
    errors.push({ path: 'employeeId', message: 'employeeId must be a non-empty string', value: t.employeeId });
  }

  if (!isAgentState(t.fromState)) {
    errors.push({ path: 'fromState', message: 'fromState must be a valid AgentState', value: t.fromState });
  }

  if (!isAgentState(t.toState)) {
    errors.push({ path: 'toState', message: 'toState must be a valid AgentState', value: t.toState });
  }

  // Check if transition is valid
  if (isAgentState(t.fromState) && isAgentState(t.toState)) {
    if (!isValidTransition(t.fromState, t.toState)) {
      errors.push({
        path: '',
        message: `Invalid state transition from '${t.fromState}' to '${t.toState}'`,
        value: { from: t.fromState, to: t.toState }
      });
    }
  }

  if (typeof t.trigger !== 'string' || t.trigger.length === 0) {
    errors.push({ path: 'trigger', message: 'trigger must be a non-empty string', value: t.trigger });
  }

  if (typeof t.timestamp !== 'string') {
    errors.push({ path: 'timestamp', message: 'timestamp must be a string (ISO timestamp)', value: t.timestamp });
  }

  if (t.taskId !== undefined && typeof t.taskId !== 'string') {
    errors.push({ path: 'taskId', message: 'taskId must be a string', value: t.taskId });
  }

  if (t.error !== undefined && typeof t.error !== 'string') {
    errors.push({ path: 'error', message: 'error must be a string', value: t.error });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for StateTransition.
 */
export function isStateTransition(value: unknown): value is StateTransition {
  return validateStateTransition(value).valid;
}

/**
 * Validates a RecruitmentRequest object.
 */
export function validateRecruitmentRequest(request: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!request || typeof request !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'RecruitmentRequest must be an object' }] };
  }

  const r = request as Record<string, unknown>;

  if (!Array.isArray(r.requiredSkills)) {
    errors.push({ path: 'requiredSkills', message: 'requiredSkills must be an array', value: r.requiredSkills });
  } else if (!r.requiredSkills.every(skill => typeof skill === 'string')) {
    errors.push({ path: 'requiredSkills', message: 'all requiredSkills must be strings', value: r.requiredSkills });
  }

  if (typeof r.reportingToManagerId !== 'string' || r.reportingToManagerId.length === 0) {
    errors.push({ path: 'reportingToManagerId', message: 'reportingToManagerId must be a non-empty string', value: r.reportingToManagerId });
  }

  if (typeof r.teamId !== 'string' || r.teamId.length === 0) {
    errors.push({ path: 'teamId', message: 'teamId must be a non-empty string', value: r.teamId });
  }

  if (r.preferredFramework !== undefined && typeof r.preferredFramework !== 'string') {
    errors.push({ path: 'preferredFramework', message: 'preferredFramework must be a string', value: r.preferredFramework });
  }

  if (r.isContractor !== undefined && typeof r.isContractor !== 'boolean') {
    errors.push({ path: 'isContractor', message: 'isContractor must be a boolean', value: r.isContractor });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type guard for RecruitmentRequest.
 */
export function isRecruitmentRequest(value: unknown): value is RecruitmentRequest {
  return validateRecruitmentRequest(value).valid;
}

/**
 * Helper to create a TaskPayload with validation.
 * Throws ValidationError if validation fails.
 */
export function createTaskPayload(data: Partial<TaskPayload> & { id: string; correlationId: string; objective: string }): TaskPayload {
  const task: TaskPayload = {
    id: data.id,
    correlationId: data.correlationId,
    objective: data.objective,
    context: data.context ?? {},
    createdAt: data.createdAt ?? new Date().toISOString(),
    parentTaskId: data.parentTaskId,
    priority: data.priority,
    timeout: data.timeout,
    tags: data.tags,
    externalId: data.externalId,
    planeWorkspace: data.planeWorkspace,
    planeProjectId: data.planeProjectId,
  };

  const result = validateTaskPayload(task);
  if (!result.valid) {
    throw new Error(`Invalid TaskPayload: ${result.errors.map(e => `${e.path}: ${e.message}`).join(', ')}`);
  }

  return task;
}

/**
 * Helper to create a WorkResult with validation.
 * Throws ValidationError if validation fails.
 */
export function createWorkResult(data: Partial<WorkResult> & { status: WorkResult['status']; output: unknown; metrics: ExecutionMetrics }): WorkResult {
  const result: WorkResult = {
    status: data.status,
    output: data.output,
    metrics: data.metrics,
    completedAt: data.completedAt ?? new Date().toISOString(),
    error: data.error,
    delegatedTo: data.delegatedTo,
    artifacts: data.artifacts,
  };

  const validation = validateWorkResult(result);
  if (!validation.valid) {
    throw new Error(`Invalid WorkResult: ${validation.errors.map(e => `${e.path}: ${e.message}`).join(', ')}`);
  }

  return result;
}
