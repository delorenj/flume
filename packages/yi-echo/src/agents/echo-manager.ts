/**
 * Echo Manager - Mock manager that delegates to subordinates
 */

import type { TaskPayload, SelectionStrategy } from '@flume/core';
import { BaseManager, FirstMatchSelection } from '@yi/adapter';

/**
 * Echo manager - delegates using first-match strategy.
 * Can also do IC work if no subordinates available.
 */
export class EchoManager extends BaseManager {
  constructor(
    config: {
      id?: string;
      name?: string;
      role?: string;
      teamId?: string;
      skills?: string[];
      salary?: number;
    } = {},
    selectionStrategy: SelectionStrategy = new FirstMatchSelection()
  ) {
    super(
      {
        id: config.id,
        name: config.name ?? 'Echo Manager',
        role: config.role ?? 'Echo Team Lead',
        teamId: config.teamId ?? 'echo-team',
        skills: config.skills ?? ['management', 'delegation', 'echo'],
        salary: config.salary ?? 100000,
      },
      selectionStrategy
    );
  }

  /**
   * Do work directly (when no subordinates available).
   */
  protected async doWork(task: TaskPayload): Promise<string> {
    await this.simulateWork(150);

    const result = `Manager ${this.name} handled "${task.objective}" directly (IC mode)`;
    console.log(`[${this.name}] ${result}`);
    return result;
  }

  private simulateWork(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
