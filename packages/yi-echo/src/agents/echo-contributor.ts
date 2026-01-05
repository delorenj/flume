/**
 * Echo Contributor - Mock contributor that echoes task completion
 */

import type { TaskPayload } from '@flume/core';
import { BaseContributor } from '@yi/adapter';

/**
 * Echo contributor - returns "I did [task]!" without any LLM.
 * Perfect for testing the architecture flow.
 */
export class EchoContributor extends BaseContributor {
  constructor(config: {
    id?: string;
    name?: string;
    role?: string;
    teamId?: string;
    skills?: string[];
    salary?: number;
  } = {}) {
    super({
      id: config.id,
      name: config.name ?? 'Echo IC',
      role: config.role ?? 'Echo Contributor',
      teamId: config.teamId ?? 'echo-team',
      skills: config.skills ?? ['echo', 'testing', 'mock'],
      salary: config.salary ?? 50000,
    });
  }

  /**
   * Echo the task completion.
   */
  protected async doWork(task: TaskPayload): Promise<string> {
    // Simulate some work
    await this.simulateWork(100);

    const result = `I completed "${task.objective}" successfully!`;
    console.log(`[${this.name}] ${result}`);
    return result;
  }

  /**
   * Simulate work with a delay.
   */
  private simulateWork(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Slow echo contributor - adds artificial delay.
 * Use for testing timeout handling.
 */
export class EchoSlowContributor extends EchoContributor {
  constructor(
    private delayMs: number = 2000,
    config: {
      id?: string;
      name?: string;
      teamId?: string;
      skills?: string[];
    } = {}
  ) {
    super({
      ...config,
      name: config.name ?? 'Slow Echo IC',
      role: 'Slow Echo Contributor',
    });
  }

  protected async doWork(task: TaskPayload): Promise<string> {
    console.log(`[${this.name}] Working slowly (${this.delayMs}ms delay)...`);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return `I slowly completed "${task.objective}"`;
  }
}
