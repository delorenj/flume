/**
 * Employee Types - The corporate hierarchy
 *
 * The naming convention follows corporate anthropomorphization:
 * - Employee: Base interface (can report status)
 * - Contributor: Leaf node (can execute tasks)
 * - Delegator: Has subordinates (can assign work)
 * - Manager: Branch node (can delegate AND execute)
 * - Director: Pure orchestrator (can ONLY delegate)
 *
 * @category Employee
 */

import type { TaskPayload } from './task.js';
import type { WorkResult } from './result.js';
import type { AgentState } from './state.js';

/**
 * Base interface for all agents in the hierarchy.
 * Every agent, regardless of role, can report their status.
 */
export interface Employee {
  /** Unique employee/agent ID */
  id: string;

  /** Human-readable name */
  name: string;

  /** Role title (e.g., "Senior Backend Developer") */
  role: string;

  /** Current state of the agent */
  state: AgentState;

  /** Team this employee belongs to */
  teamId: string;

  /** Skills this employee has */
  skills: string[];

  /** Importance metric (simplified leveling) */
  salary: number;

  /** Report current status (like a daily standup) */
  reportStatus(): Promise<EmployeeStatus>;
}

/**
 * Status report from an employee.
 */
export interface EmployeeStatus {
  /** Current state */
  state: AgentState;

  /** Current task being worked on (if any) */
  currentTaskId?: string;

  /** Brief status message */
  message: string;

  /** When this status was generated */
  timestamp: string;

  /** Any blockers preventing work */
  blockers?: string[];
}

/**
 * Contributor - The leaf node / Individual Contributor (IC).
 * Contributors can execute tasks but cannot delegate.
 */
export interface Contributor extends Employee {
  /**
   * Check if this contributor can handle the given task.
   * Used by selection strategies to find capable agents.
   */
  canHandle(task: TaskPayload): boolean | Promise<boolean>;

  /**
   * Execute the task and return the result.
   * This is where the actual work happens.
   */
  execute(task: TaskPayload): Promise<WorkResult>;
}

/**
 * Delegator - Has subordinates and can assign work.
 * This is a capability interface, not a standalone role.
 */
export interface Delegator {
  /** Direct reports / subordinates */
  subordinates: Employee[];

  /**
   * Add an employee to this delegator's team.
   * (HR sends new hires here after onboarding)
   */
  recruit(employee: Employee): void;

  /**
   * Remove an employee from the team.
   */
  release(employeeId: string): void;

  /**
   * Delegate a task to a subordinate.
   * The delegator chooses which subordinate handles the task.
   */
  delegate(task: TaskPayload): Promise<WorkResult>;
}

/**
 * Manager - Branch node that can both delegate AND execute.
 * Like a Tech Lead who manages a team but can also code.
 */
export interface Manager extends Contributor, Delegator {
  // Managers inherit both execution ability and delegation ability
}

/**
 * Director - Pure orchestrator that can ONLY delegate.
 * Like a VP who coordinates teams but doesn't do IC work.
 */
export interface Director extends Employee, Delegator {
  // Directors cannot execute tasks directly - only delegate
}

/**
 * Selection strategy for choosing which subordinate handles a task.
 * Injected into Delegators to control task routing.
 */
export interface SelectionStrategy {
  /** Strategy name for logging/debugging */
  name: string;

  /**
   * Select the best subordinate for the given task.
   * Returns null if no subordinate can handle it.
   */
  select(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<Employee | null>;
}
