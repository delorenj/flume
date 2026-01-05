/**
 * Claude Contributor - Claude API-backed contributor agent
 *
 * Extends BaseContributor to integrate with Anthropic's Claude API.
 * Each request creates a new conversation (stateless by default).
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import { BaseContributor } from '@yi/adapter';
import Anthropic from '@anthropic-ai/sdk';

export interface ClaudeContributorConfig {
  id?: string;
  name?: string;
  role?: string;
  teamId?: string;
  skills?: string[];
  salary?: number;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * A Contributor powered by Claude API.
 */
export class ClaudeContributor extends BaseContributor {
  private client: Anthropic;
  private model: string;
  private systemPrompt: string;
  private maxTokens: number;
  private temperature: number;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(config: ClaudeContributorConfig = {}) {
    super({
      id: config.id ?? uuid(),
      name: config.name ?? 'Claude Worker',
      role: config.role ?? 'Claude Contributor',
      teamId: config.teamId ?? 'default',
      skills: config.skills ?? ['general', 'coding', 'analysis'],
      salary: config.salary ?? 80000,
    });

    this.client = new Anthropic();
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.systemPrompt = config.systemPrompt ?? this.buildDefaultSystemPrompt();
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  /**
   * Build default system prompt.
   */
  private buildDefaultSystemPrompt(): string {
    return `You are ${this.name}, a skilled contributor on the ${this.teamId} team.
Your role is: ${this.role}
Your skills include: ${this.skills.join(', ')}

When given a task:
1. Analyze the objective carefully
2. Break down complex problems into steps
3. Provide thorough, accurate responses
4. Include code examples when relevant
5. Be concise but comprehensive

Always format your response clearly and professionally.`;
  }

  /**
   * Override injectMemory to update system prompt with team context.
   */
  async injectMemory(memory: import('@yi/adapter').OnboardingPacket): Promise<void> {
    await super.injectMemory(memory);

    // Update system prompt with team context
    this.systemPrompt = `${this.systemPrompt}

## Team Context
Mission: ${memory.mission}
Access Level: ${memory.accessLevel}
Protocols: ${memory.protocols?.join(', ') ?? 'Standard'}`;

    console.log(`[${this.name}] Memory injected, system prompt updated`);
  }

  /**
   * Execute the task using Claude API.
   */
  protected async doWork(task: TaskPayload): Promise<unknown> {
    console.log(`[${this.name}] Executing task via Claude: ${task.objective}`);

    const userMessage = this.buildTaskMessage(task);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: this.systemPrompt,
        messages: [
          ...this.conversationHistory,
          { role: 'user', content: userMessage },
        ],
      });

      // Extract text from response
      const assistantMessage = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      // Update conversation history
      this.conversationHistory.push(
        { role: 'user', content: userMessage },
        { role: 'assistant', content: assistantMessage }
      );

      // Keep history manageable
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-10);
      }

      console.log(`[${this.name}] Claude task complete`);

      return {
        status: 'completed',
        output: assistantMessage,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
        stopReason: response.stop_reason,
      };
    } catch (error) {
      console.error(`[${this.name}] Claude API error:`, error);
      throw error;
    }
  }

  /**
   * Build message for Claude from task.
   */
  private buildTaskMessage(task: TaskPayload): string {
    let message = `## Task\n\n**Objective:** ${task.objective}\n\n`;

    if (task.context) {
      message += `**Context:**\n\`\`\`json\n${JSON.stringify(task.context, null, 2)}\n\`\`\`\n\n`;
    }

    if (task.tags?.length) {
      message += `**Tags:** ${task.tags.join(', ')}\n\n`;
    }

    message += `Please complete this task and provide a detailed response.`;

    return message;
  }

  /**
   * Clear conversation history.
   */
  clearHistory(): void {
    this.conversationHistory = [];
    console.log(`[${this.name}] Conversation history cleared`);
  }

  /**
   * Get current model being used.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Update model configuration.
   */
  setModel(model: string): void {
    this.model = model;
  }
}
