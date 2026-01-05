/**
 * Letta Manager - Real Letta-backed manager agent
 *
 * Extends BaseManager with Letta integration.
 * Can delegate to subordinates or do IC work via Letta.
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload, SelectionStrategy } from '@flume/core';
import { BaseManager, FirstMatchSelection } from '@yi/adapter';
import type { LettaClient, LettaResponse } from '../client/letta-client.js';

export interface LettaManagerConfig {
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
 * A Manager backed by a Letta agent for IC work.
 */
export class LettaManager extends BaseManager {
  private lettaClient: LettaClient;
  private lettaAgentId: string | null = null;
  private systemPrompt: string;
  private tools: string[];

  constructor(
    lettaClient: LettaClient,
    config: LettaManagerConfig = {},
    selectionStrategy: SelectionStrategy = new FirstMatchSelection()
  ) {
    super(
      {
        id: config.id ?? uuid(),
        name: config.name ?? 'Letta Manager',
        role: config.role ?? 'Letta Team Lead',
        teamId: config.teamId ?? 'default',
        skills: config.skills ?? ['management', 'general'],
        salary: config.salary ?? 120000,
      },
      selectionStrategy
    );

    this.lettaClient = lettaClient;
    this.systemPrompt = config.systemPrompt ?? this.buildDefaultSystemPrompt();
    this.tools = config.tools ?? [];
  }

  /**
   * Build default system prompt for manager.
   */
  private buildDefaultSystemPrompt(): string {
    return `You are ${this.name}, a team lead on the ${this.teamId} team.
Your role is: ${this.role}
Your skills include: ${this.skills.join(', ')}

As a manager, you:
1. Understand complex tasks and break them down
2. Can delegate to team members when appropriate
3. Can execute tasks directly when needed
4. Provide guidance and oversight

When asked to do IC work (no team available):
- Focus on the task objective
- Provide thorough analysis and results
- Document your approach clearly`;
  }

  /**
   * Initialize the Letta agent on the server.
   */
  async initialize(): Promise<void> {
    if (this.lettaAgentId) return;

    console.log(`[${this.name}] Creating Letta manager agent...`);

    const agent = await this.lettaClient.createAgent({
      name: `yi-mgr-${this.id}`,
      description: `Yi Manager: ${this.name} (${this.role})`,
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
            isManager: true,
          }),
        },
        {
          label: 'team_context',
          value: JSON.stringify({
            subordinates: this.subordinates.map(s => ({
              id: s.id,
              name: s.name,
              skills: s.skills,
            })),
          }),
        },
        {
          label: 'task_context',
          value: 'No active task.',
        },
      ],
    });

    this.lettaAgentId = agent.id;
    console.log(`[${this.name}] Letta manager agent created: ${this.lettaAgentId}`);
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
      await this.lettaClient.updateMemoryBlock(
        this.lettaAgentId,
        'persona',
        JSON.stringify({
          name: this.name,
          role: this.role,
          skills: this.skills,
          teamId: this.teamId,
          isManager: true,
          mission: memory.mission,
          protocols: memory.protocols,
          accessLevel: memory.accessLevel,
        })
      );
    }
  }

  /**
   * Update team context in Letta memory when subordinates change.
   */
  private async updateTeamContext(): Promise<void> {
    if (this.lettaAgentId) {
      await this.lettaClient.updateMemoryBlock(
        this.lettaAgentId,
        'team_context',
        JSON.stringify({
          subordinates: this.subordinates.map(s => ({
            id: s.id,
            name: s.name,
            skills: s.skills,
          })),
        })
      );
    }
  }

  /**
   * Override recruit to update Letta memory.
   */
  recruit(employee: import('@flume/core').Employee): void {
    super.recruit(employee);
    this.updateTeamContext().catch(console.error);
  }

  /**
   * Override release to update Letta memory.
   */
  release(employeeId: string): void {
    super.release(employeeId);
    this.updateTeamContext().catch(console.error);
  }

  /**
   * Do IC work using Letta when no subordinates can handle the task.
   */
  protected async doWork(task: TaskPayload): Promise<unknown> {
    if (!this.lettaAgentId) {
      await this.initialize();
    }

    if (!this.lettaAgentId) {
      throw new Error('Failed to initialize Letta manager agent');
    }

    console.log(`[${this.name}] Executing IC work via Letta: ${task.objective}`);

    // Update task context
    await this.lettaClient.updateMemoryBlock(
      this.lettaAgentId,
      'task_context',
      JSON.stringify({
        taskId: task.id,
        objective: task.objective,
        context: task.context,
        priority: task.priority,
        tags: task.tags,
        mode: 'ic_work', // Indicates direct execution
      })
    );

    // Build and send message
    const message = this.buildICWorkMessage(task);
    const response = await this.lettaClient.sendMessage(
      this.lettaAgentId,
      message
    );

    const result = this.extractResult(response);
    console.log(`[${this.name}] IC work complete`);

    return result;
  }

  /**
   * Build message for IC work.
   */
  private buildICWorkMessage(task: TaskPayload): string {
    let message = `## Direct Task Assignment (IC Work)\n\n`;
    message += `As a manager doing IC work, please complete this task directly.\n\n`;
    message += `**Objective:** ${task.objective}\n\n`;

    if (task.context) {
      message += `**Context:**\n\`\`\`json\n${JSON.stringify(task.context, null, 2)}\n\`\`\`\n\n`;
    }

    message += `Please provide a thorough response with your findings and recommendations.`;

    return message;
  }

  /**
   * Extract result from Letta response.
   */
  private extractResult(response: LettaResponse): unknown {
    const assistantMessages = response.messages.filter(
      m => m.role === 'assistant' && m.text
    );

    if (assistantMessages.length === 0) {
      return { status: 'completed', output: 'Task executed but no response generated.' };
    }

    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const text = lastMessage.text ?? '';

    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        // Not valid JSON
      }
    }

    return {
      status: 'completed',
      output: text,
      usage: response.usage,
    };
  }

  /**
   * Cleanup Letta agent.
   */
  async terminate(): Promise<void> {
    if (this.lettaAgentId) {
      console.log(`[${this.name}] Deleting Letta manager agent: ${this.lettaAgentId}`);
      try {
        await this.lettaClient.deleteAgent(this.lettaAgentId);
      } catch (error) {
        console.warn(`[${this.name}] Failed to delete Letta agent:`, error);
      }
      this.lettaAgentId = null;
    }
  }
}
