/**
 * Letta Director - Real Letta-backed director agent
 *
 * Extends BaseDirector with Letta for strategic decision-making.
 * Directors don't do IC work - they only delegate and provide strategic context.
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload, WorkResult, SelectionStrategy } from '@flume/core';
import { BaseDirector, FirstMatchSelection } from '@yi/adapter';
import type { LettaClient, LettaResponse } from '../client/letta-client.js';

export interface LettaDirectorConfig {
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
 * A Director backed by Letta for strategic decision-making.
 */
export class LettaDirector extends BaseDirector {
  private lettaClient: LettaClient;
  private lettaAgentId: string | null = null;
  private systemPrompt: string;
  private tools: string[];

  constructor(
    lettaClient: LettaClient,
    config: LettaDirectorConfig = {},
    selectionStrategy: SelectionStrategy = new FirstMatchSelection()
  ) {
    super(
      {
        id: config.id ?? uuid(),
        name: config.name ?? 'Letta Director',
        role: config.role ?? 'Letta VP',
        teamId: config.teamId ?? 'default',
        skills: config.skills ?? ['strategy', 'leadership'],
        salary: config.salary ?? 250000,
      },
      selectionStrategy
    );

    this.lettaClient = lettaClient;
    this.systemPrompt = config.systemPrompt ?? this.buildDefaultSystemPrompt();
    this.tools = config.tools ?? [];
  }

  /**
   * Build default system prompt for director.
   */
  private buildDefaultSystemPrompt(): string {
    return `You are ${this.name}, a director/VP on the ${this.teamId} team.
Your role is: ${this.role}

As a director, you:
1. Provide strategic direction and context for tasks
2. Make high-level decisions about task prioritization
3. Ensure tasks align with team mission and goals
4. Do NOT execute tasks directly - you delegate

When asked to provide strategic context:
- Consider the broader business impact
- Identify key stakeholders and dependencies
- Suggest success metrics and acceptance criteria
- Add any executive-level insights`;
  }

  /**
   * Initialize the Letta agent on the server.
   */
  async initialize(): Promise<void> {
    if (this.lettaAgentId) return;

    console.log(`[${this.name}] Creating Letta director agent...`);

    const agent = await this.lettaClient.createAgent({
      name: `yi-dir-${this.id}`,
      description: `Yi Director: ${this.name} (${this.role})`,
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
            isDirector: true,
          }),
        },
        {
          label: 'organization',
          value: JSON.stringify({
            directReports: this.subordinates.map(s => ({
              id: s.id,
              name: s.name,
              role: s.role,
            })),
          }),
        },
        {
          label: 'strategic_context',
          value: 'No active strategic initiatives.',
        },
      ],
    });

    this.lettaAgentId = agent.id;
    console.log(`[${this.name}] Letta director agent created: ${this.lettaAgentId}`);
  }

  /**
   * Get the Letta agent ID.
   */
  getLettaAgentId(): string | null {
    return this.lettaAgentId;
  }

  /**
   * Override injectMemory to update Letta agent.
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
          isDirector: true,
          mission: memory.mission,
          accessLevel: memory.accessLevel,
        })
      );
    }
  }

  /**
   * Update organization context when subordinates change.
   */
  private async updateOrgContext(): Promise<void> {
    if (this.lettaAgentId) {
      await this.lettaClient.updateMemoryBlock(
        this.lettaAgentId,
        'organization',
        JSON.stringify({
          directReports: this.subordinates.map(s => ({
            id: s.id,
            name: s.name,
            role: s.role,
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
    this.updateOrgContext().catch(console.error);
  }

  /**
   * Override release to update Letta memory.
   */
  release(employeeId: string): void {
    super.release(employeeId);
    this.updateOrgContext().catch(console.error);
  }

  /**
   * Apply strategic context using Letta for intelligent enrichment.
   */
  protected async applyStrategicContext(task: TaskPayload): Promise<TaskPayload> {
    if (!this.lettaAgentId) {
      await this.initialize();
    }

    if (!this.lettaAgentId) {
      // Fallback to basic context if Letta unavailable
      return {
        ...task,
        context: {
          ...task.context,
          executiveSponsorship: true,
          strategicPriority: task.priority ?? 1,
          directorId: this.id,
        },
      };
    }

    console.log(`[${this.name}] Enriching task with strategic context via Letta`);

    // Ask Letta for strategic insights
    const message = this.buildStrategicContextRequest(task);
    const response = await this.lettaClient.sendMessage(
      this.lettaAgentId,
      message
    );

    const strategicContext = this.parseStrategicContext(response);

    return {
      ...task,
      context: {
        ...task.context,
        ...strategicContext,
        executiveSponsorship: true,
        directorId: this.id,
      },
    };
  }

  /**
   * Build message to request strategic context.
   */
  private buildStrategicContextRequest(task: TaskPayload): string {
    return `## Strategic Context Request

I need you to provide strategic context for the following task that will be delegated to my team.

**Task Objective:** ${task.objective}

**Current Context:**
\`\`\`json
${JSON.stringify(task.context ?? {}, null, 2)}
\`\`\`

**Priority:** ${task.priority ?? 'Not specified'}

Please provide your strategic analysis in JSON format with these fields:
- businessImpact: string (high/medium/low)
- keyStakeholders: string[]
- successMetrics: string[]
- risks: string[]
- recommendations: string[]
- strategicAlignment: string

Respond with ONLY the JSON object.`;
  }

  /**
   * Parse strategic context from Letta response.
   */
  private parseStrategicContext(response: LettaResponse): Record<string, unknown> {
    const assistantMessages = response.messages.filter(
      m => m.role === 'assistant' && m.text
    );

    if (assistantMessages.length === 0) {
      return { strategicNote: 'Strategic context generation failed' };
    }

    const text = assistantMessages[assistantMessages.length - 1].text ?? '';

    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } catch {
        // Parse failed
      }
    }

    // Return as narrative if not JSON
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
    console.log(`[${this.name}] No candidate found for task - escalating`);

    // Directors cannot do IC work, must escalate or fail
    return {
      status: 'failure',
      output: null,
      error: {
        code: 'NO_CANDIDATE',
        message: `No team member can handle task: ${task.objective}`,
        retryable: false,
        cause: `Director ${this.id} has no subordinate with required skills`,
      },
      metrics: {
        durationMs: Date.now() - startTime,
        delegationDepth: 0,
      },
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Cleanup Letta agent.
   */
  async terminate(): Promise<void> {
    if (this.lettaAgentId) {
      console.log(`[${this.name}] Deleting Letta director agent: ${this.lettaAgentId}`);
      try {
        await this.lettaClient.deleteAgent(this.lettaAgentId);
      } catch (error) {
        console.warn(`[${this.name}] Failed to delete Letta agent:`, error);
      }
      this.lettaAgentId = null;
    }
  }
}
