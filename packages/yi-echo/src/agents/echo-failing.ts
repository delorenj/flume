/**
 * Echo Failing Contributor - Mock agent that fails randomly
 * Use for testing error handling and retry logic.
 */

import type { TaskPayload } from '@flume/core';
import { BaseContributor } from '@yi/adapter';

/**
 * Echo failing contributor - throws errors randomly.
 */
export class EchoFailingContributor extends BaseContributor {
  constructor(
    private failureRate: number = 0.2, // 20% failure rate
    config: {
      id?: string;
      name?: string;
      teamId?: string;
      skills?: string[];
    } = {}
  ) {
    super({
      id: config.id,
      name: config.name ?? 'Failing Echo IC',
      role: 'Unreliable Echo Contributor',
      teamId: config.teamId ?? 'echo-team',
      skills: config.skills ?? ['echo', 'chaos', 'testing'],
      salary: 40000,
    });
  }

  protected async doWork(task: TaskPayload): Promise<string> {
    await this.simulateWork(100);

    // Random failure
    if (Math.random() < this.failureRate) {
      throw new Error(
        `Random failure while executing "${task.objective}" (${this.failureRate * 100}% failure rate)`
      );
    }

    return `I completed "${task.objective}" (survived the chaos)`;
  }

  private simulateWork(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Echo timeout contributor - never completes.
 * Use for testing timeout handling.
 */
export class EchoTimeoutContributor extends BaseContributor {
  constructor(
    config: {
      id?: string;
      name?: string;
      teamId?: string;
      skills?: string[];
    } = {}
  ) {
    super({
      id: config.id,
      name: config.name ?? 'Timeout Echo IC',
      role: 'Never-Finishing Contributor',
      teamId: config.teamId ?? 'echo-team',
      skills: config.skills ?? ['echo', 'timeout', 'testing'],
      salary: 30000,
    });
  }

  protected async doWork(task: TaskPayload): Promise<never> {
    console.log(`[${this.name}] Starting task... (will never complete)`);

    // Never resolve - simulate infinite hang
    return new Promise(() => {
      // Intentionally never resolves
    });
  }
}
