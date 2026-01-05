/**
 * Claude Director - Claude API-backed director agent
 *
 * Extends BaseDirector with Claude for strategic decision-making.
 * Directors only delegate - they don't do IC work.
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload, WorkResult, SelectionStrategy } from '@flume/core';
import { BaseDirector, FirstMatchSelection } from '@yi/adapter';
import Anthropic from '@anthropic-ai/sdk';

export interface ClaudeDirectorConfig {
  id?: string;
  name?: string;
  role?: string;
  teamId?: string;
  skills?: string[];
  salary?: number;
  model?: string;
  systemPrompt?: string;
}

/**
 * A Director using Claude for strategic context generation.
 */
export class ClaudeDirector extends BaseDirector {
  private client: Anthropic;
  private model: string;
  private systemPrompt: string;

  constructor(
    config: ClaudeDirectorConfig = {},
    selectionStrategy: SelectionStrategy = new FirstMatchSelection()
  ) {
    super(
      {
        id: config.id ?? uuid(),
        name: config.name ?? 'Claude Director',
        role: config.role ?? 'Claude VP',
        teamId: config.teamId ?? 'default',
        skills: config.skills ?? ['strategy', 'leadership'],
        salary: config.salary ?? 280000,
      },
      selectionStrategy
    );

    this.client = new Anthropic();
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.systemPrompt = config.systemPrompt ?? this.buildDefaultSystemPrompt();
  }

  /**
   * Build default system prompt.
   */
  private buildDefaultSystemPrompt(): string {
    return `You are ${this.name}, a director/VP providing strategic guidance.
Your role is: ${this.role}

As a director, you:
1. Provide strategic context and direction
2. Identify business impact and stakeholders
3. Define success metrics and risks
4. Align tasks with organizational goals

When asked to provide strategic context, respond with structured JSON containing:
- businessImpact: "high" | "medium" | "low"
- keyStakeholders: string[]
- successMetrics: string[]
- risks: string[]
- recommendations: string[]
- strategicAlignment: string (how this aligns with team/company goals)`;
  }

  /**
   * Override injectMemory to update system prompt.
   */
  async injectMemory(memory: import('@yi/adapter').OnboardingPacket): Promise<void> {
    await super.injectMemory(memory);

    this.systemPrompt = `${this.systemPrompt}

## Organization Context
Mission: ${memory.mission}
Access Level: ${memory.accessLevel}`;
  }

  /**
   * Apply strategic context using Claude.
   */
  protected async applyStrategicContext(task: TaskPayload): Promise<TaskPayload> {
    console.log(`[${this.name}] Generating strategic context via Claude`);

    const message = this.buildStrategicContextRequest(task);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: this.systemPrompt,
        messages: [{ role: 'user', content: message }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      const strategicContext = this.parseStrategicContext(text);

      return {
        ...task,
        context: {
          ...task.context,
          ...strategicContext,
          executiveSponsorship: true,
          directorId: this.id,
        },
      };
    } catch (error) {
      console.warn(`[${this.name}] Failed to generate strategic context:`, error);

      // Fallback to basic context
      return {
        ...task,
        context: {
          ...task.context,
          executiveSponsorship: true,
          directorId: this.id,
          strategicNote: 'Context generation failed - proceeding with task',
        },
      };
    }
  }

  /**
   * Build strategic context request message.
   */
  private buildStrategicContextRequest(task: TaskPayload): string {
    return `Provide strategic context for this task in JSON format.

**Task:** ${task.objective}
**Priority:** ${task.priority ?? 'Not specified'}
**Current Context:** ${JSON.stringify(task.context ?? {}, null, 2)}

Respond with ONLY a JSON object containing businessImpact, keyStakeholders, successMetrics, risks, recommendations, and strategicAlignment.`;
  }

  /**
   * Parse strategic context from Claude response.
   */
  private parseStrategicContext(text: string): Record<string, unknown> {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } catch {
        // Parse failed
      }
    }

    return {
      strategicDirection: text,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Handle case when no candidate can handle the task.
   */
  protected async handleNoCandidate(
    task: TaskPayload,
    startTime: number
  ): Promise<WorkResult> {
    console.log(`[${this.name}] No candidate found - escalating`);

    return {
      status: 'failure',
      output: null,
      error: {
        code: 'NO_CANDIDATE',
        message: `No team member can handle: ${task.objective}`,
        retryable: false,
        cause: `Director ${this.id} cannot find capable subordinate`,
      },
      metrics: {
        durationMs: Date.now() - startTime,
        delegationDepth: 0,
      },
      completedAt: new Date().toISOString(),
    };
  }
}
