/**
 * @flume/core - Pure Protocol Layer
 *
 * Flume defines the "corporate charter" for agent orchestration.
 * These interfaces know nothing about Letta, Agno, or any specific implementation.
 * They only know "Corporate Hierarchy."
 *
 * A developer can implement Manager and Contributor interfaces directly,
 * bypassing Yi entirely if they want raw control.
 *
 * ## Core Concepts
 *
 * - **Tasks**: The atomic unit of work flowing through the system
 * - **Employees**: The corporate hierarchy (Contributor, Manager, Director)
 * - **Results**: Structured responses from task execution
 * - **Events**: Bloodbank integration for observability
 * - **States**: Agent lifecycle management
 *
 * ## Integration Points
 *
 * - **Plane**: Project management sync for task visibility
 * - **PostgreSQL**: Persistence layer for state and history
 *
 * @packageDocumentation
 * @module @flume/core
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

// Validation
export * from './validation/validators.js';

// State Machine
export * from './state/state-machine.js';
