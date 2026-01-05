/**
 * Base Manager - Abstract base class for Yi managers
 *
 * Managers can both execute tasks AND delegate to subordinates.
 * Like a Tech Lead who manages a team but can also code.
 */

import { v4 as uuid } from 'uuid';
import type {
  Manager,
  Employee,
  TaskPayload,
  WorkResult,
  EmployeeStatus,
  AgentState,
  SelectionStrategy,
} from '@flume/core';
import { isValidTransition } from '@flume/core';
import type { YiAgent, OnboardingPacket } from '../hr/onboarding-specialist.js';

/**
 * Abstract base class for Yi managers.
 */
export abstract class BaseManager implements Manager, YiAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly teamId: string;
  readonly skills: string[];
  readonly salary: number;

  protected _state: AgentState = 'initializing';
  protected _currentTaskId?: string;
  protected _memory?: OnboardingPacket;
  protected _subordinates: Employee[] = [];

  constructor(
    config: {
      id?: string;
      name: string;
      role: string;
      teamId: string;
      skills: string[];
      salary?: number;
    },
    protected selectionStrategy: SelectionStrategy
  ) {
    this.id = config.id ?? uuid();
    this.name = config.name;
    this.role = config.role;
    this.teamId = config.teamId;
    this.skills = config.skills;
    this.salary = config.salary ?? 100000;
  }

  get state(): AgentState {
    return this._state;
  }

  get subordinates(): Employee[] {
    return [...this._subordinates];
  }

  /**
   * Transition to a new state with validation.
   */
  protected transitionTo(newState: AgentState, trigger: string): void {
    if (!isValidTransition(this._state, newState)) {
      throw new Error(
        `Invalid state transition: ${this._state} -> ${newState} (trigger: ${trigger})`
      );
    }
    console.log(
      `[${this.name}] State: ${this._state} -> ${newState} (${trigger})`
    );
    this._state = newState;
  }

  async reportStatus(): Promise<EmployeeStatus> {
    return {
      state: this._state,
      currentTaskId: this._currentTaskId,
      message: this.getStatusMessage(),
      timestamp: new Date().toISOString(),
    };
  }

  protected getStatusMessage(): string {
    const teamSize = this._subordinates.length;
    switch (this._state) {
      case 'idle':
        return `Ready. Managing ${teamSize} subordinate(s)`;
      case 'working':
        return `Working on task ${this._currentTaskId}`;
      case 'delegating':
        return `Delegating task ${this._currentTaskId}`;
      default:
        return `State: ${this._state}`;
    }
  }

  /**
   * Add an employee to the team.
   */
  recruit(employee: Employee): void {
    if (this._subordinates.find((e) => e.id === employee.id)) {
      console.log(`[${this.name}] ${employee.name} is already on the team`);
      return;
    }
    this._subordinates.push(employee);
    console.log(`[${this.name}] Recruited ${employee.name} to the team`);
  }

  /**
   * Remove an employee from the team.
   */
  release(employeeId: string): void {
    const idx = this._subordinates.findIndex((e) => e.id === employeeId);
    if (idx === -1) {
      console.log(`[${this.name}] Employee ${employeeId} not found`);
      return;
    }
    const released = this._subordinates.splice(idx, 1)[0];
    console.log(`[${this.name}] Released ${released?.name ?? employeeId}`);
  }

  /**
   * Check if this manager can handle the task.
   * A manager can handle a task if:
   * 1. They have matching skills themselves, OR
   * 2. Any of their subordinates can handle it
   */
  canHandle(task: TaskPayload): boolean {
    if (this._state !== 'idle') {
      return false;
    }

    // If manager has subordinates, they can handle anything the team can handle
    if (this._subordinates.length > 0) {
      return true; // Will delegate - actual capability checked during delegation
    }

    // No subordinates - check personal skills
    const taskTags = task.tags ?? [];
    return (
      this.skills.some((skill) =>
        taskTags.includes(skill.toLowerCase())
      ) || taskTags.length === 0
    );
  }

  /**
   * Execute the task - managers can do IC work if needed.
   */
  async execute(task: TaskPayload): Promise<WorkResult> {
    // First try to delegate
    if (this._subordinates.length > 0) {
      return this.delegate(task);
    }

    // No subordinates - do it ourselves
    return this.doWorkDirectly(task);
  }

  /**
   * Delegate the task to a subordinate.
   */
  async delegate(task: TaskPayload): Promise<WorkResult> {
    if (this._subordinates.length === 0) {
      return {
        status: 'failure',
        output: null,
        metrics: { durationMs: 0 },
        error: {
          code: 'NO_SUBORDINATES',
          message: `${this.name} has no subordinates to delegate to`,
          retryable: false,
        },
        completedAt: new Date().toISOString(),
      };
    }

    this._currentTaskId = task.id;
    this.transitionTo('delegating', `delegate:${task.id}`);

    const startTime = Date.now();

    try {
      // Use selection strategy to pick subordinate
      const chosen = await this.selectionStrategy.select(
        task,
        this._subordinates
      );

      if (!chosen) {
        this.transitionTo('idle', `no_candidate:${task.id}`);
        return {
          status: 'failure',
          output: null,
          metrics: { durationMs: Date.now() - startTime },
          error: {
            code: 'NO_CAPABLE_SUBORDINATE',
            message: `No subordinate can handle task: ${task.objective}`,
            retryable: false,
          },
          completedAt: new Date().toISOString(),
        };
      }

      console.log(
        `[${this.name}] Delegating "${task.objective}" to ${chosen.name}`
      );

      // Check if chosen is a Contributor with execute method
      if ('execute' in chosen && typeof chosen.execute === 'function') {
        const result = await (chosen as { execute: (task: TaskPayload) => Promise<WorkResult> }).execute(task);

        this.transitionTo('idle', `delegated:${task.id}`);
        this._currentTaskId = undefined;

        return {
          ...result,
          status: result.status === 'success' ? 'delegated' : result.status,
          delegatedTo: chosen.id,
          metrics: {
            ...result.metrics,
            durationMs: Date.now() - startTime,
            delegationDepth: (result.metrics.delegationDepth ?? 0) + 1,
          },
        };
      }

      throw new Error(`Chosen subordinate ${chosen.name} cannot execute tasks`);
    } catch (error) {
      this.transitionTo('errored', `delegate_error:${task.id}`);

      return {
        status: 'failure',
        output: null,
        metrics: { durationMs: Date.now() - startTime },
        error: {
          code: 'DELEGATION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Do the work directly (IC mode).
   */
  protected async doWorkDirectly(task: TaskPayload): Promise<WorkResult> {
    this._currentTaskId = task.id;
    this.transitionTo('working', `work:${task.id}`);

    const startTime = Date.now();

    try {
      const output = await this.doWork(task);

      this.transitionTo('idle', `complete:${task.id}`);
      this._currentTaskId = undefined;

      return {
        status: 'success',
        output,
        metrics: { durationMs: Date.now() - startTime },
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.transitionTo('errored', `error:${task.id}`);

      return {
        status: 'failure',
        output: null,
        metrics: { durationMs: Date.now() - startTime },
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        completedAt: new Date().toISOString(),
      };
    }
  }

  async injectMemory(memory: OnboardingPacket): Promise<void> {
    this.transitionTo('onboarding', 'memory_injection');
    this._memory = memory;
    console.log(`[${this.name}] Memory injected - mission: ${memory.mission}`);
  }

  async verifyReadiness(): Promise<boolean> {
    if (!this._memory) {
      return false;
    }
    this.transitionTo('idle', 'onboarding_complete');
    return true;
  }

  /**
   * Abstract - subclasses implement actual work.
   */
  protected abstract doWork(task: TaskPayload): Promise<unknown>;
}
