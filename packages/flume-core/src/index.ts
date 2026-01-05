/**
 * @flume/core - Pure Protocol Layer
 *
 * Flume defines the "corporate charter" for agent orchestration.
 * These interfaces know nothing about Letta, Agno, or any specific implementation.
 * They only know "Corporate Hierarchy."
 *
 * A developer can implement Manager and Contributor interfaces directly,
 * bypassing Yi entirely if they want raw control.
 */

// Re-export all types
export * from './types/task.js';
export * from './types/result.js';
export * from './types/employee.js';
export * from './types/events.js';
export * from './types/state.js';

// Plane integration
export * from './plane/plane-client.js';

// Database
export * from './db/postgres-client.js';
