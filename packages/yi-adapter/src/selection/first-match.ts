/**
 * First Match Selection Strategy
 *
 * Simple strategy: iterate through candidates until one can handle the task.
 * Good for MVP and deterministic testing.
 */

import type { Employee, TaskPayload, SelectionStrategy, Contributor } from '@flume/core';

/**
 * First match selection - returns first capable candidate.
 */
export class FirstMatchSelection implements SelectionStrategy {
  readonly name = 'first-match';

  async select(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<Employee | null> {
    for (const candidate of candidates) {
      // Check if candidate is a Contributor with canHandle
      if ('canHandle' in candidate) {
        const contributor = candidate as Contributor;
        const canHandle = await Promise.resolve(contributor.canHandle(task));
        if (canHandle) {
          console.log(
            `[FirstMatch] Selected ${candidate.name} for "${task.objective}"`
          );
          return candidate;
        }
      } else {
        // Non-Contributor (Manager/Director) - check if idle
        if (candidate.state === 'idle') {
          console.log(
            `[FirstMatch] Selected ${candidate.name} (non-contributor) for "${task.objective}"`
          );
          return candidate;
        }
      }
    }

    console.log(`[FirstMatch] No candidate found for "${task.objective}"`);
    return null;
  }
}

/**
 * Round robin selection - rotate through candidates.
 */
export class RoundRobinSelection implements SelectionStrategy {
  readonly name = 'round-robin';
  private lastIndex = -1;

  async select(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<Employee | null> {
    if (candidates.length === 0) {
      return null;
    }

    // Find next capable candidate starting after last selection
    const startIndex = (this.lastIndex + 1) % candidates.length;

    for (let i = 0; i < candidates.length; i++) {
      const index = (startIndex + i) % candidates.length;
      const candidate = candidates[index];

      if (candidate && 'canHandle' in candidate) {
        const contributor = candidate as Contributor;
        const canHandle = await Promise.resolve(contributor.canHandle(task));
        if (canHandle) {
          this.lastIndex = index;
          console.log(
            `[RoundRobin] Selected ${candidate.name} (index ${index}) for "${task.objective}"`
          );
          return candidate;
        }
      } else if (candidate?.state === 'idle') {
        this.lastIndex = index;
        return candidate;
      }
    }

    return null;
  }
}
