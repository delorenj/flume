/**
 * LLM-Driven Selection Strategy
 *
 * Uses an LLM to pick the best candidate based on task requirements.
 * This is the preferred strategy for Yi managers using Letta/Claude.
 */

import type { Employee, TaskPayload, SelectionStrategy } from '@flume/core';

/**
 * LLM provider interface for selection decisions.
 */
export interface LLMProvider {
  /**
   * Ask the LLM to pick the best candidate.
   * @param prompt - Selection prompt with task and candidates
   * @returns Index of chosen candidate or -1 if none suitable
   */
  selectCandidate(prompt: string): Promise<number>;
}

/**
 * LLM-driven selection strategy.
 * Falls back to first-match if LLM fails.
 */
export class LLMDrivenSelection implements SelectionStrategy {
  readonly name = 'llm-driven';

  constructor(
    private llmProvider: LLMProvider,
    private fallbackToFirstMatch = true
  ) {}

  async select(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<Employee | null> {
    if (candidates.length === 0) {
      return null;
    }

    try {
      const prompt = this.buildSelectionPrompt(task, candidates);
      const selectedIndex = await this.llmProvider.selectCandidate(prompt);

      if (selectedIndex >= 0 && selectedIndex < candidates.length) {
        const chosen = candidates[selectedIndex];
        if (chosen) {
          console.log(
            `[LLMSelection] LLM selected ${chosen.name} for "${task.objective}"`
          );
          return chosen;
        }
      }

      console.log(`[LLMSelection] LLM returned invalid index: ${selectedIndex}`);
    } catch (error) {
      console.error(`[LLMSelection] LLM selection failed:`, error);
    }

    // Fallback to first-match
    if (this.fallbackToFirstMatch) {
      console.log(`[LLMSelection] Falling back to first-match`);
      return this.firstMatch(task, candidates);
    }

    return null;
  }

  /**
   * Build a prompt for the LLM to make a selection.
   */
  private buildSelectionPrompt(
    task: TaskPayload,
    candidates: Employee[]
  ): string {
    const candidateList = candidates
      .map((c, i) => {
        const skills = c.skills.join(', ');
        return `${i}. ${c.name} (${c.role}) - Skills: ${skills} - State: ${c.state}`;
      })
      .join('\n');

    return `
You are a manager selecting the best team member for a task.

TASK:
- Objective: ${task.objective}
- Priority: ${task.priority ?? 'normal'}
- Tags: ${task.tags?.join(', ') ?? 'none'}

AVAILABLE TEAM MEMBERS:
${candidateList}

Select the best team member for this task. Consider:
1. Skill match with task requirements
2. Current availability (prefer 'idle' state)
3. Role appropriateness

Respond with ONLY the number (0-${candidates.length - 1}) of your selection.
If no one is suitable, respond with -1.
`.trim();
  }

  /**
   * Fallback first-match selection.
   */
  private async firstMatch(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<Employee | null> {
    for (const candidate of candidates) {
      if (candidate.state === 'idle') {
        return candidate;
      }
    }
    return null;
  }
}

/**
 * Mock LLM provider for testing.
 * Always picks the first idle candidate.
 */
export class MockLLMProvider implements LLMProvider {
  async selectCandidate(prompt: string): Promise<number> {
    // Parse candidate count from prompt
    const match = prompt.match(/\(0-(\d+)\)/);
    if (!match) {
      return 0;
    }

    // Just return 0 (first candidate) for mock
    console.log(`[MockLLM] Received selection prompt, returning 0`);
    return 0;
  }
}
