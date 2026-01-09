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
 * Serializable state for Letta agent persistence.
 * This can be saved to the database and used to restore an agent.
 */
export interface LettaAgentState {
  /** Yi contributor ID */
  yiId: string;
  /** Letta server agent ID */
  lettaAgentId: string;
  /** Agent configuration */
  config: {
    name: string;
    role: string;
    teamId: string;
    skills: string[];
    salary: number;
    systemPrompt: string;
    tools: string[];
  };
  /** Memory block snapshots */
  memoryBlocks: Array<{
    label: string;
    value: string;
  }>;
  /** Metadata */
  metadata: {
    exportedAt: string;
    version: string;
  };
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

  // ============================================================================
  // State Persistence
  // ============================================================================

  /**
   * Export agent state for persistence.
   * Returns a serializable snapshot that can be saved to the database.
   */
  async exportState(): Promise<LettaAgentState> {
    if (!this.lettaAgentId) {
      throw new Error('Cannot export state: Letta agent not initialized');
    }

    // Fetch current agent state from Letta server
    const agent = await this.lettaClient.getAgent(this.lettaAgentId);
    if (!agent) {
      throw new Error(`Letta agent not found: ${this.lettaAgentId}`);
    }

    const state: LettaAgentState = {
      yiId: this.id,
      lettaAgentId: this.lettaAgentId,
      config: {
        name: this.name,
        role: this.role,
        teamId: this.teamId,
        skills: [...this.skills],
        salary: this.salary,
        systemPrompt: this.systemPrompt,
        tools: [...this.tools],
      },
      memoryBlocks: agent.memory.blocks.map((block) => ({
        label: block.label,
        value: block.value,
      })),
      metadata: {
        exportedAt: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    console.log(`[${this.name}] Exported agent state`);
    return state;
  }

  /**
   * Import state to update this agent's configuration.
   * Does not restore Letta server state - use restoreFromState for that.
   */
  importState(state: LettaAgentState): void {
    // Update local config from saved state
    // Note: We can't change the ID after construction in BaseContributor
    this.systemPrompt = state.config.systemPrompt;
    this.tools = [...state.config.tools];

    console.log(`[${this.name}] Imported state configuration`);
  }

  /**
   * Restore Letta agent from persisted state.
   * Will attempt to reconnect to existing Letta agent or create a new one with saved memory.
   */
  async restoreFromState(state: LettaAgentState): Promise<void> {
    console.log(`[${this.name}] Restoring from persisted state...`);

    // First, update local config
    this.importState(state);

    // Try to reconnect to existing Letta agent
    const existingAgent = await this.lettaClient.getAgent(state.lettaAgentId);

    if (existingAgent) {
      // Agent still exists on server - reconnect
      this.lettaAgentId = state.lettaAgentId;
      console.log(`[${this.name}] Reconnected to existing Letta agent: ${this.lettaAgentId}`);

      // Update memory blocks to match saved state
      for (const block of state.memoryBlocks) {
        try {
          await this.lettaClient.updateMemoryBlock(
            this.lettaAgentId,
            block.label,
            block.value
          );
        } catch (error) {
          console.warn(
            `[${this.name}] Failed to restore memory block ${block.label}:`,
            error
          );
        }
      }
    } else {
      // Agent no longer exists - recreate with saved memory
      console.log(`[${this.name}] Original Letta agent gone, recreating...`);

      const newAgent = await this.lettaClient.createAgent({
        name: `yi-${this.id}`,
        description: `Yi Contributor: ${this.name} (${this.role}) [restored]`,
        system: state.config.systemPrompt,
        tools: state.config.tools,
        memoryBlocks: state.memoryBlocks,
      });

      this.lettaAgentId = newAgent.id;
      console.log(`[${this.name}] Created new Letta agent: ${this.lettaAgentId}`);
    }

    console.log(`[${this.name}] Restoration complete`);
  }

  /**
   * Check if the Letta agent is still alive on the server.
   */
  async isAgentAlive(): Promise<boolean> {
    if (!this.lettaAgentId) return false;

    const agent = await this.lettaClient.getAgent(this.lettaAgentId);
    return agent !== null;
  }

  /**
   * Sync local memory blocks to Letta server.
   * Useful for periodic persistence.
   */
  async syncMemory(blocks: Array<{ label: string; value: string }>): Promise<void> {
    if (!this.lettaAgentId) {
      throw new Error('Cannot sync: Letta agent not initialized');
    }

    for (const block of blocks) {
      await this.lettaClient.updateMemoryBlock(
        this.lettaAgentId,
        block.label,
        block.value
      );
    }

    console.log(`[${this.name}] Synced ${blocks.length} memory blocks`);
  }

  /**
   * Get current memory blocks from Letta server.
   */
  async getMemoryBlocks(): Promise<Array<{ label: string; value: string }>> {
    if (!this.lettaAgentId) {
      throw new Error('Cannot get memory: Letta agent not initialized');
    }

    const agent = await this.lettaClient.getAgent(this.lettaAgentId);
    if (!agent) {
      throw new Error(`Letta agent not found: ${this.lettaAgentId}`);
    }

    return agent.memory.blocks.map((block) => ({
      label: block.label,
      value: block.value,
    }));
  }
}
