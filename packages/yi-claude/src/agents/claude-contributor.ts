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
  /** Enable streaming by default */
  enableStreaming?: boolean;
}

/**
 * Callback for streaming events.
 */
export interface StreamEventHandler {
  /** Called when text delta arrives */
  onTextDelta?: (delta: string) => void;
  /** Called when content block starts */
  onContentBlockStart?: (blockIndex: number, type: string) => void;
  /** Called when content block ends */
  onContentBlockStop?: (blockIndex: number) => void;
  /** Called when message is complete */
  onMessageComplete?: (message: string, usage: { inputTokens: number; outputTokens: number }) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

/**
 * Streaming execution result.
 */
export interface StreamingResult {
  /** Full text output (available after stream completes) */
  fullText: string;
  /** Usage statistics */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Model used */
  model: string;
  /** Stop reason */
  stopReason: string | null;
}

/**
 * JSON Schema property definition for tool inputs.
 */
export interface ToolInputProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: ToolInputProperty;
  properties?: Record<string, ToolInputProperty>;
  required?: string[];
}

/**
 * Tool definition for Claude API.
 */
export interface ToolDefinition {
  /** Unique tool name */
  name: string;
  /** Tool description for Claude to understand when to use it */
  description: string;
  /** JSON Schema for tool inputs */
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolInputProperty>;
    required?: string[];
  };
}

/**
 * Tool executor function type.
 * Takes the parsed input and returns the result.
 */
export type ToolExecutor<T = Record<string, unknown>> = (input: T) => Promise<string | object>;

/**
 * Result from tool use execution.
 */
export interface ToolUseResult {
  /** Final text output after tool use */
  output: string;
  /** Tool calls that were made */
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string | object;
  }>;
  /** Usage statistics */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Model used */
  model: string;
  /** Stop reason */
  stopReason: string | null;
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
  private enableStreaming: boolean;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private streamEventHandler?: StreamEventHandler;
  private tools: ToolDefinition[] = [];
  private toolExecutors: Map<string, ToolExecutor> = new Map();

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
    this.enableStreaming = config.enableStreaming ?? false;
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

  /**
   * Set stream event handler for receiving streaming events.
   */
  setStreamEventHandler(handler: StreamEventHandler): void {
    this.streamEventHandler = handler;
  }

  /**
   * Enable or disable streaming mode.
   */
  setStreaming(enabled: boolean): void {
    this.enableStreaming = enabled;
  }

  /**
   * Check if streaming is enabled.
   */
  isStreamingEnabled(): boolean {
    return this.enableStreaming;
  }

  /**
   * Execute task with streaming response.
   * Returns a StreamingResult with the full text after completion.
   */
  async executeWithStreaming(
    task: TaskPayload,
    eventHandler?: StreamEventHandler
  ): Promise<StreamingResult> {
    const handler = eventHandler ?? this.streamEventHandler;
    console.log(`[${this.name}] Executing task via Claude streaming: ${task.objective}`);

    const userMessage = this.buildTaskMessage(task);

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: this.systemPrompt,
        messages: [
          ...this.conversationHistory,
          { role: 'user', content: userMessage },
        ],
      });

      let fullText = '';
      let currentBlockIndex = 0;

      // Handle streaming events
      stream.on('text', (delta) => {
        fullText += delta;
        handler?.onTextDelta?.(delta);
      });

      stream.on('contentBlockStart', (_event) => {
        handler?.onContentBlockStart?.(currentBlockIndex, 'text');
      });

      stream.on('contentBlockStop', () => {
        handler?.onContentBlockStop?.(currentBlockIndex);
        currentBlockIndex++;
      });

      stream.on('error', (error) => {
        handler?.onError?.(error);
      });

      // Wait for stream to complete
      const finalMessage = await stream.finalMessage();

      // Extract usage info
      const usage = {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      };

      // Notify completion
      handler?.onMessageComplete?.(fullText, usage);

      // Update conversation history
      this.conversationHistory.push(
        { role: 'user', content: userMessage },
        { role: 'assistant', content: fullText }
      );

      // Keep history manageable
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-10);
      }

      console.log(`[${this.name}] Claude streaming task complete`);

      return {
        fullText,
        usage,
        model: finalMessage.model,
        stopReason: finalMessage.stop_reason,
      };
    } catch (error) {
      console.error(`[${this.name}] Claude streaming error:`, error);
      handler?.onError?.(error as Error);
      throw error;
    }
  }

  /**
   * Register a tool that Claude can use.
   */
  registerTool<T = Record<string, unknown>>(
    definition: ToolDefinition,
    executor: ToolExecutor<T>
  ): void {
    // Check for duplicate
    if (this.toolExecutors.has(definition.name)) {
      console.warn(`[${this.name}] Tool ${definition.name} already registered, replacing`);
      this.tools = this.tools.filter((t) => t.name !== definition.name);
    }

    this.tools.push(definition);
    this.toolExecutors.set(definition.name, executor as ToolExecutor);
    console.log(`[${this.name}] Registered tool: ${definition.name}`);
  }

  /**
   * Unregister a tool by name.
   */
  unregisterTool(name: string): boolean {
    const existed = this.toolExecutors.delete(name);
    if (existed) {
      this.tools = this.tools.filter((t) => t.name !== name);
      console.log(`[${this.name}] Unregistered tool: ${name}`);
    }
    return existed;
  }

  /**
   * Get list of registered tool names.
   */
  getRegisteredTools(): string[] {
    return this.tools.map((t) => t.name);
  }

  /**
   * Check if a tool is registered.
   */
  hasTool(name: string): boolean {
    return this.toolExecutors.has(name);
  }

  /**
   * Clear all registered tools.
   */
  clearTools(): void {
    this.tools = [];
    this.toolExecutors.clear();
    console.log(`[${this.name}] Cleared all tools`);
  }

  /**
   * Execute task with tool use support.
   * Claude can call registered tools during execution.
   * Handles the tool use loop automatically.
   */
  async executeWithTools(
    task: TaskPayload,
    maxToolIterations: number = 10
  ): Promise<ToolUseResult> {
    if (this.tools.length === 0) {
      throw new Error('No tools registered. Use registerTool() first.');
    }

    console.log(`[${this.name}] Executing task with tools: ${task.objective}`);

    const userMessage = this.buildTaskMessage(task);
    const toolCalls: ToolUseResult['toolCalls'] = [];

    // Build messages array (using any for complex content types)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [{ role: 'user', content: userMessage }];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iterations = 0;
    let finalOutput = '';
    let finalModel = '';
    let finalStopReason: string | null = null;

    try {
      while (iterations < maxToolIterations) {
        iterations++;

        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
          system: this.systemPrompt,
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
          messages,
        });

        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
        finalModel = response.model;
        finalStopReason = response.stop_reason;

        // Check if Claude wants to use tools
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
        );

        // If no tool use, we're done
        if (toolUseBlocks.length === 0) {
          // Extract final text response
          finalOutput = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
          break;
        }

        // Process tool calls
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          const executor = this.toolExecutors.get(toolUse.name);
          if (!executor) {
            console.error(`[${this.name}] Unknown tool: ${toolUse.name}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: Unknown tool "${toolUse.name}"`,
              is_error: true,
            });
            continue;
          }

          try {
            console.log(`[${this.name}] Executing tool: ${toolUse.name}`);
            const result = await executor(toolUse.input as Record<string, unknown>);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

            toolCalls.push({
              name: toolUse.name,
              input: toolUse.input as Record<string, unknown>,
              result,
            });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: resultStr,
            });
          } catch (error) {
            console.error(`[${this.name}] Tool ${toolUse.name} error:`, error);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error executing tool: ${(error as Error).message}`,
              is_error: true,
            });
          }
        }

        // Add assistant response with tool use to messages
        messages.push({ role: 'assistant', content: response.content });

        // Add tool results as user message
        messages.push({ role: 'user', content: toolResults });
      }

      console.log(`[${this.name}] Tool execution complete after ${iterations} iteration(s)`);

      return {
        output: finalOutput,
        toolCalls,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        model: finalModel,
        stopReason: finalStopReason,
      };
    } catch (error) {
      console.error(`[${this.name}] Tool execution error:`, error);
      throw error;
    }
  }
}
