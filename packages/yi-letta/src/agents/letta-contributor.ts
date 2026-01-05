/**
 * Letta Contributor - Real Letta-backed contributor agent
 *
 * Extends BaseContributor to integrate with a Letta server.
 * Each LettaContributor corresponds to a Letta agent instance.
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import { BaseContributor } from '@yi/adapter';
import type { LettaClient, LettaAgent, LettaResponse } from '../client/letta-client.js';

export interface LettaContributorConfig {
  id?: string;
  name?: string;
  role?: string;
  teamId?: string;
  skills?: string[];
  salary?: number;
  systemPrompt?: string;
  tools?: string[];
}

/**
 * A Contributor backed by a Letta agent.
 */
export class LettaContributor extends BaseContributor {
  private lettaClient: LettaClient;
  private lettaAgentId: string | null = null;
  private systemPrompt: string;
  private tools: string[];

  constructor(
    lettaClient: LettaClient,
    config: LettaContributorConfig = {}
  ) {
    super({
      id: config.id ?? uuid(),
      name: config.name ?? 'Letta Worker',
      role: config.role ?? 'Letta Contributor',
      teamId: config.teamId ?? 'default',
      skills: config.skills ?? ['general'],
      salary: config.salary ?? 75000,
    });

    this.lettaClient = lettaClient;
    this.systemPrompt = config.systemPrompt ?? this.buildDefaultSystemPrompt();
    this.tools = config.tools ?? [];
  }

  /**
   * Build default system prompt for work tasks.
   */
  private buildDefaultSystemPrompt(): string {
    return `You are ${this.name}, a skilled contributor on the ${this.teamId} team.
Your role is: ${this.role}
Your skills include: ${this.skills.join(', ')}

When given a task:
1. Understand the objective and requirements
2. Break down complex tasks into steps
3. Execute each step carefully
4. Report your progress and results clearly

Always be thorough, precise, and communicate your findings.`;
  }

  /**
   * Initialize the Letta agent on the server.
   */
  async initialize(): Promise<void> {
    if (this.lettaAgentId) return;

    console.log(`[${this.name}] Creating Letta agent...`);

    const agent = await this.lettaClient.createAgent({
      name: `yi-${this.id}`,
      description: `Yi Contributor: ${this.name} (${this.role})`,
      system: this.systemPrompt,
      tools: this.tools,
      memoryBlocks: [
        {
          label: 'persona',
          value: JSON.stringify({
            name: this.name,
            role: this.role,
            skills: this.skills,
            teamId: this.teamId,
          }),
        },
        {
          label: 'task_context',
          value: 'No active task.',
        },
      ],
    });

    this.lettaAgentId = agent.id;
    console.log(`[${this.name}] Letta agent created: ${this.lettaAgentId}`);
  }

  /**
   * Get the Letta agent ID.
   */
  getLettaAgentId(): string | null {
    return this.lettaAgentId;
  }

  /**
   * Override injectMemory to also update Letta agent memory.
   */
  async injectMemory(memory: import('@yi/adapter').OnboardingPacket): Promise<void> {
    await super.injectMemory(memory);

    if (this.lettaAgentId) {
      // Update Letta agent's memory block with team context
      await this.lettaClient.updateMemoryBlock(
        this.lettaAgentId,
        'persona',
        JSON.stringify({
          name: this.name,
          role: this.role,
          skills: this.skills,
          teamId: this.teamId,
          mission: memory.mission,
          protocols: memory.protocols,
          accessLevel: memory.accessLevel,
        })
      );
    }
  }

  /**
   * Execute the task using Letta agent.
   */
  protected async doWork(task: TaskPayload): Promise<unknown> {
    if (!this.lettaAgentId) {
      await this.initialize();
    }

    if (!this.lettaAgentId) {
      throw new Error('Failed to initialize Letta agent');
    }

    console.log(`[${this.name}] Executing task via Letta: ${task.objective}`);

    // Update task context in agent memory
    await this.lettaClient.updateMemoryBlock(
      this.lettaAgentId,
      'task_context',
      JSON.stringify({
        taskId: task.id,
        objective: task.objective,
        context: task.context,
        priority: task.priority,
        tags: task.tags,
      })
    );

    // Build the task message
    const taskMessage = this.buildTaskMessage(task);

    // Send to Letta and collect response
    const response = await this.lettaClient.sendMessage(
      this.lettaAgentId,
      taskMessage
    );

    // Extract the result from messages
    const result = this.extractResult(response);

    console.log(`[${this.name}] Letta task complete`);

    return result;
  }

  /**
   * Build a message to send to Letta for task execution.
   */
  private buildTaskMessage(task: TaskPayload): string {
    let message = `## Task Assignment\n\n`;
    message += `**Objective:** ${task.objective}\n\n`;

    if (task.context) {
      message += `**Context:**\n\`\`\`json\n${JSON.stringify(task.context, null, 2)}\n\`\`\`\n\n`;
    }

    if (task.tags?.length) {
      message += `**Tags:** ${task.tags.join(', ')}\n\n`;
    }

    message += `Please complete this task and provide a detailed response with your findings and results.`;

    return message;
  }

  /**
   * Extract the final result from Letta response messages.
   */
  private extractResult(response: LettaResponse): unknown {
    // Find the last assistant message with text content
    const assistantMessages = response.messages.filter(
      m => m.role === 'assistant' && m.text
    );

    if (assistantMessages.length === 0) {
      return { status: 'completed', output: 'Task executed but no response generated.' };
    }

    const lastMessage = assistantMessages[assistantMessages.length - 1];

    // Try to parse as JSON if it looks like JSON
    const text = lastMessage.text ?? '';
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        // Not valid JSON, return as string
      }
    }

    return {
      status: 'completed',
      output: text,
      usage: response.usage,
    };
  }

  /**
   * Cleanup: delete the Letta agent when terminating.
   */
  async terminate(): Promise<void> {
    if (this.lettaAgentId) {
      console.log(`[${this.name}] Deleting Letta agent: ${this.lettaAgentId}`);
      try {
        await this.lettaClient.deleteAgent(this.lettaAgentId);
      } catch (error) {
        console.warn(`[${this.name}] Failed to delete Letta agent:`, error);
      }
      this.lettaAgentId = null;
    }
  }
}
