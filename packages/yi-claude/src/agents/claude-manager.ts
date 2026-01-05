/**
 * Claude Manager - Claude API-backed manager agent
 *
 * Extends BaseManager with Claude integration.
 * Can delegate to subordinates or do IC work via Claude.
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload, SelectionStrategy } from '@flume/core';
import { BaseManager, FirstMatchSelection } from '@yi/adapter';
import Anthropic from '@anthropic-ai/sdk';

export interface ClaudeManagerConfig {
  id?: string;
  name?: string;
  role?: string;
  teamId?: string;
  skills?: string[];
  salary?: number;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
}

/**
 * A Manager powered by Claude API for IC work.
 */
export class ClaudeManager extends BaseManager {
  private client: Anthropic;
  private model: string;
  private systemPrompt: string;
  private maxTokens: number;

  constructor(
    config: ClaudeManagerConfig = {},
    selectionStrategy: SelectionStrategy = new FirstMatchSelection()
  ) {
    super(
      {
        id: config.id ?? uuid(),
        name: config.name ?? 'Claude Manager',
        role: config.role ?? 'Claude Team Lead',
        teamId: config.teamId ?? 'default',
        skills: config.skills ?? ['management', 'general'],
        salary: config.salary ?? 130000,
      },
      selectionStrategy
    );

    this.client = new Anthropic();
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.systemPrompt = config.systemPrompt ?? this.buildDefaultSystemPrompt();
    this.maxTokens = config.maxTokens ?? 4096;
  }

  /**
   * Build default system prompt.
   */
  private buildDefaultSystemPrompt(): string {
    return `You are ${this.name}, a team lead on the ${this.teamId} team.
Your role is: ${this.role}
Your skills include: ${this.skills.join(', ')}

As a manager, you:
1. Can analyze complex tasks and provide solutions
2. Understand technical requirements deeply
3. Provide clear, actionable outputs
4. Consider team context and constraints

When doing IC work:
- Focus on delivering quality results
- Be thorough in your analysis
- Provide concrete recommendations`;
  }

  /**
   * Override injectMemory to update system prompt.
   */
  async injectMemory(memory: import('@yi/adapter').OnboardingPacket): Promise<void> {
    await super.injectMemory(memory);

    this.systemPrompt = `${this.systemPrompt}

## Team Context
Mission: ${memory.mission}
Access Level: ${memory.accessLevel}
Team Size: ${this.subordinates.length} direct reports`;
  }

  /**
   * Do IC work using Claude when no subordinates can handle the task.
   */
  protected async doWork(task: TaskPayload): Promise<unknown> {
    console.log(`[${this.name}] Executing IC work via Claude: ${task.objective}`);

    const message = this.buildICWorkMessage(task);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: this.systemPrompt,
        messages: [{ role: 'user', content: message }],
      });

      const output = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      console.log(`[${this.name}] IC work complete`);

      return {
        status: 'completed',
        output,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      console.error(`[${this.name}] Claude API error:`, error);
      throw error;
    }
  }

  /**
   * Build message for IC work.
   */
  private buildICWorkMessage(task: TaskPayload): string {
    let message = `## Manager IC Work Assignment\n\n`;
    message += `As a team lead handling this task directly:\n\n`;
    message += `**Objective:** ${task.objective}\n\n`;

    if (task.context) {
      message += `**Context:**\n\`\`\`json\n${JSON.stringify(task.context, null, 2)}\n\`\`\`\n\n`;
    }

    message += `Provide a comprehensive solution with your analysis and recommendations.`;

    return message;
  }
}
