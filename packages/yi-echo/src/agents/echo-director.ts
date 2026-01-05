/**
 * Echo Director - Mock director that only delegates
 */

import type { TaskPayload, SelectionStrategy } from '@flume/core';
import { BaseDirector, FirstMatchSelection } from '@yi/adapter';

/**
 * Echo director - pure orchestrator, only delegates.
 * Adds strategic context to tasks before delegation.
 */
export class EchoDirector extends BaseDirector {
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
        name: config.name ?? 'Echo Director',
        role: config.role ?? 'VP of Echo Operations',
        teamId: config.teamId ?? 'echo-team',
        skills: config.skills ?? ['strategy', 'leadership', 'delegation'],
        salary: config.salary ?? 200000,
      },
      selectionStrategy
    );
  }

  /**
   * Add strategic context before delegation.
   */
  protected async applyStrategicContext(
    task: TaskPayload
  ): Promise<TaskPayload> {
    console.log(`[${this.name}] Adding strategic context to task`);

    return {
      ...task,
      context: {
        ...task.context,
        strategicDirection: `Priority task from ${this.name}`,
        executiveSponsorship: true,
      },
    };
  }
}
