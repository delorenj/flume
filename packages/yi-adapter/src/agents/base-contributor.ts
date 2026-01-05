/**
 * Base Contributor - Abstract base class for Yi contributors
 *
 * Extends the Flume Contributor interface with Yi-specific
 * functionality like memory injection and state management.
 */

import { v4 as uuid } from 'uuid';
import type {
  Contributor,
  TaskPayload,
  WorkResult,
  EmployeeStatus,
  AgentState,
} from '@flume/core';
import { isValidTransition } from '@flume/core';
import type { YiAgent, OnboardingPacket } from '../hr/onboarding-specialist.js';

/**
 * Abstract base class for Yi contributors.
 * Provides common functionality for all Yi-wrapped agents.
 */
export abstract class BaseContributor implements Contributor, YiAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly teamId: string;
  readonly skills: string[];
  readonly salary: number;

  protected _state: AgentState = 'initializing';
  protected _currentTaskId?: string;
  protected _memory?: OnboardingPacket;

  constructor(config: {
    id?: string;
    name: string;
    role: string;
    teamId: string;
    skills: string[];
    salary?: number;
  }) {
    this.id = config.id ?? uuid();
    this.name = config.name;
    this.role = config.role;
    this.teamId = config.teamId;
    this.skills = config.skills;
    this.salary = config.salary ?? 50000;
  }

  get state(): AgentState {
    return this._state;
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

  /**
   * Report current status.
   */
  async reportStatus(): Promise<EmployeeStatus> {
    return {
      state: this._state,
      currentTaskId: this._currentTaskId,
      message: this.getStatusMessage(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Generate a human-readable status message.
   */
  protected getStatusMessage(): string {
    switch (this._state) {
      case 'initializing':
        return 'Starting up...';
      case 'onboarding':
        return 'Learning the ropes...';
      case 'idle':
        return 'Ready for work';
      case 'working':
        return `Working on task ${this._currentTaskId}`;
      case 'blocked':
        return 'Waiting for external dependency';
      case 'errored':
        return 'Encountered an error';
      case 'terminated':
        return 'No longer active';
      default:
        return `State: ${this._state}`;
    }
  }

  /**
   * Check if this contributor can handle the task.
   * Default implementation checks skill overlap.
   */
  canHandle(task: TaskPayload): boolean {
    // Must be idle to accept new work
    if (this._state !== 'idle') {
      return false;
    }

    // Check if we have relevant skills
    const taskTags = task.tags ?? [];
    const hasRelevantSkill = this.skills.some(
      (skill) =>
        taskTags.includes(skill.toLowerCase()) ||
        task.objective.toLowerCase().includes(skill.toLowerCase())
    );

    return hasRelevantSkill || taskTags.length === 0;
  }

  /**
   * Execute the task.
   * Subclasses must implement the actual work.
   */
  async execute(task: TaskPayload): Promise<WorkResult> {
    if (this._state !== 'idle') {
      return {
        status: 'failure',
        output: null,
        metrics: { durationMs: 0 },
        error: {
          code: 'AGENT_BUSY',
          message: `Agent ${this.name} is not idle (state: ${this._state})`,
          retryable: true,
        },
        completedAt: new Date().toISOString(),
      };
    }

    this._currentTaskId = task.id;
    this.transitionTo('working', `execute:${task.id}`);

    const startTime = Date.now();

    try {
      // Subclass implements this
      const output = await this.doWork(task);

      this.transitionTo('idle', `complete:${task.id}`);
      this._currentTaskId = undefined;

      return {
        status: 'success',
        output,
        metrics: {
          durationMs: Date.now() - startTime,
        },
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.transitionTo('errored', `error:${task.id}`);

      return {
        status: 'failure',
        output: null,
        metrics: {
          durationMs: Date.now() - startTime,
        },
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Inject memory during onboarding.
   */
  async injectMemory(memory: OnboardingPacket): Promise<void> {
    this.transitionTo('onboarding', 'memory_injection');
    this._memory = memory;
    console.log(`[${this.name}] Memory injected - mission: ${memory.mission}`);
  }

  /**
   * Verify readiness after onboarding.
   */
  async verifyReadiness(): Promise<boolean> {
    if (!this._memory) {
      console.log(`[${this.name}] No memory - not ready`);
      return false;
    }

    this.transitionTo('idle', 'onboarding_complete');
    return true;
  }

  /**
   * Abstract method - subclasses implement the actual work.
   */
  protected abstract doWork(task: TaskPayload): Promise<unknown>;
}
