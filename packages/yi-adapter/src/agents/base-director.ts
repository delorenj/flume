/**
 * Base Director - Abstract base class for Yi directors
 *
 * Directors can ONLY delegate - they never do IC work.
 * Like a VP who coordinates teams but doesn't code.
 */

import { v4 as uuid } from 'uuid';
import type {
  Director,
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
 * Abstract base class for Yi directors.
 */
export abstract class BaseDirector implements Director, YiAgent {
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
    this.salary = config.salary ?? 200000;
  }

  get state(): AgentState {
    return this._state;
  }

  get subordinates(): Employee[] {
    return [...this._subordinates];
  }

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
    const managersManaged = this._subordinates.filter(
      (s) => 'subordinates' in s
    ).length;
    const totalTeamSize = this._subordinates.length;

    return {
      state: this._state,
      currentTaskId: this._currentTaskId,
      message: `Overseeing ${managersManaged} managers, ${totalTeamSize} total reports`,
      timestamp: new Date().toISOString(),
    };
  }

  recruit(employee: Employee): void {
    if (this._subordinates.find((e) => e.id === employee.id)) {
      console.log(`[${this.name}] ${employee.name} already reports to me`);
      return;
    }
    this._subordinates.push(employee);
    console.log(`[${this.name}] ${employee.name} now reports to me`);
  }

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
   * Directors ONLY delegate - this is their core function.
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
      // Directors may apply additional strategic logic before selecting
      const strategicTask = await this.applyStrategicContext(task);

      // Use selection strategy
      const chosen = await this.selectionStrategy.select(
        strategicTask,
        this._subordinates
      );

      if (!chosen) {
        this.transitionTo('idle', `no_candidate:${task.id}`);

        // Directors might escalate - implement in subclass
        return this.handleNoCandidate(task, startTime);
      }

      console.log(
        `[${this.name}] Delegating "${task.objective}" to ${chosen.name}`
      );

      // Execute via delegation chain
      let result: WorkResult;

      if ('delegate' in chosen && typeof chosen.delegate === 'function') {
        // Subordinate is a Manager/Director - delegate further
        result = await (chosen as { delegate: (task: TaskPayload) => Promise<WorkResult> }).delegate(strategicTask);
      } else if ('execute' in chosen && typeof chosen.execute === 'function') {
        // Subordinate is a Contributor - execute directly
        result = await (chosen as { execute: (task: TaskPayload) => Promise<WorkResult> }).execute(strategicTask);
      } else {
        throw new Error(`Subordinate ${chosen.name} cannot handle tasks`);
      }

      this.transitionTo('idle', `delegated:${task.id}`);
      this._currentTaskId = undefined;

      return {
        ...result,
        delegatedTo: chosen.id,
        metrics: {
          ...result.metrics,
          durationMs: Date.now() - startTime,
          delegationDepth: (result.metrics.delegationDepth ?? 0) + 1,
        },
      };
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
   * Apply strategic context to task before delegation.
   * Directors can enrich tasks with high-level direction.
   */
  protected async applyStrategicContext(
    task: TaskPayload
  ): Promise<TaskPayload> {
    // Default: pass through unchanged
    // Subclasses can add strategic context
    return task;
  }

  /**
   * Handle case where no subordinate can handle the task.
   * Directors might escalate to CEO or request new hires.
   */
  protected async handleNoCandidate(
    task: TaskPayload,
    startTime: number
  ): Promise<WorkResult> {
    // Default: fail with clear message
    return {
      status: 'failure',
      output: null,
      metrics: { durationMs: Date.now() - startTime },
      error: {
        code: 'NO_CAPABLE_SUBORDINATE',
        message: `No subordinate can handle: ${task.objective}. May need escalation or new hire.`,
        retryable: false,
      },
      completedAt: new Date().toISOString(),
    };
  }

  async injectMemory(memory: OnboardingPacket): Promise<void> {
    this.transitionTo('onboarding', 'memory_injection');
    this._memory = memory;
    console.log(
      `[${this.name}] Strategic memory injected - mission: ${memory.mission}`
    );
  }

  async verifyReadiness(): Promise<boolean> {
    if (!this._memory) {
      return false;
    }
    this.transitionTo('idle', 'onboarding_complete');
    return true;
  }
}
