/**
 * Letta Client - HTTP client for Letta server API
 *
 * Interfaces with a Letta server to manage agents, send messages,
 * and handle tool calls.
 */

export interface LettaConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

export interface LettaAgentConfig {
  name: string;
  description?: string;
  system?: string;
  llmConfig?: {
    model?: string;
    modelEndpointType?: string;
    contextWindow?: number;
  };
  embeddingConfig?: {
    embeddingModel?: string;
    embeddingDim?: number;
  };
  tools?: string[];
  memoryBlocks?: Array<{
    label: string;
    value: string;
    limit?: number;
  }>;
}

export interface LettaAgent {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  agentType: string;
  llmConfig: Record<string, unknown>;
  embeddingConfig: Record<string, unknown>;
  memory: {
    blocks: Array<{
      label: string;
      value: string;
    }>;
  };
}

export interface LettaMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  createdAt: string;
}

export interface LettaResponse {
  messages: LettaMessage[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * HTTP client for Letta server.
 */
export class LettaClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeout: number;

  constructor(config: LettaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 60000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Letta API error ${response.status}: ${error}`);
      }

      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================================
  // Agent Operations
  // ============================================================================

  /**
   * Create a new Letta agent.
   */
  async createAgent(config: LettaAgentConfig): Promise<LettaAgent> {
    return this.request<LettaAgent>('POST', '/v1/agents', {
      name: config.name,
      description: config.description,
      system: config.system,
      llm_config: config.llmConfig,
      embedding_config: config.embeddingConfig,
      tools: config.tools,
      memory_blocks: config.memoryBlocks?.map(block => ({
        label: block.label,
        value: block.value,
        limit: block.limit,
      })),
    });
  }

  /**
   * Get an agent by ID.
   */
  async getAgent(agentId: string): Promise<LettaAgent | null> {
    try {
      return await this.request<LettaAgent>('GET', `/v1/agents/${agentId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all agents.
   */
  async listAgents(): Promise<LettaAgent[]> {
    return this.request<LettaAgent[]>('GET', '/v1/agents');
  }

  /**
   * Delete an agent.
   */
  async deleteAgent(agentId: string): Promise<void> {
    await this.request<void>('DELETE', `/v1/agents/${agentId}`);
  }

  /**
   * Update agent memory block.
   */
  async updateMemoryBlock(
    agentId: string,
    label: string,
    value: string
  ): Promise<void> {
    await this.request('PATCH', `/v1/agents/${agentId}/memory/block/${label}`, {
      value,
    });
  }

  // ============================================================================
  // Message Operations
  // ============================================================================

  /**
   * Send a message to an agent.
   */
  async sendMessage(
    agentId: string,
    message: string,
    role: 'user' | 'system' = 'user'
  ): Promise<LettaResponse> {
    return this.request<LettaResponse>('POST', `/v1/agents/${agentId}/messages`, {
      messages: [{ role, text: message }],
    });
  }

  /**
   * Send a message and stream the response.
   */
  async *streamMessage(
    agentId: string,
    message: string
  ): AsyncGenerator<LettaMessage> {
    const url = `${this.baseUrl}/v1/agents/${agentId}/messages/stream`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ role: 'user', text: message }],
        stream_steps: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Letta streaming error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            yield JSON.parse(data) as LettaMessage;
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  }

  /**
   * Get message history for an agent.
   */
  async getMessages(
    agentId: string,
    limit = 100,
    before?: string
  ): Promise<LettaMessage[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    return this.request<LettaMessage[]>(
      'GET',
      `/v1/agents/${agentId}/messages?${params}`
    );
  }

  // ============================================================================
  // Tool Operations
  // ============================================================================

  /**
   * List available tools.
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    return this.request<Array<{ name: string; description: string }>>(
      'GET',
      '/v1/tools'
    );
  }

  /**
   * Add a tool to an agent.
   */
  async addAgentTool(agentId: string, toolName: string): Promise<void> {
    await this.request('POST', `/v1/agents/${agentId}/tools`, {
      tool_name: toolName,
    });
  }

  /**
   * Submit a tool call result.
   */
  async submitToolResult(
    agentId: string,
    toolCallId: string,
    result: unknown
  ): Promise<LettaResponse> {
    return this.request<LettaResponse>(
      'POST',
      `/v1/agents/${agentId}/messages`,
      {
        messages: [
          {
            role: 'tool',
            tool_call_id: toolCallId,
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      }
    );
  }

  // ============================================================================
  // Health Check
  // ============================================================================

  /**
   * Check if Letta server is healthy.
   */
  async health(): Promise<boolean> {
    try {
      await this.request<{ status: string }>('GET', '/v1/health');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Default Letta configuration for 33GOD.
 */
export const DEFAULT_LETTA_CONFIG: LettaConfig = {
  baseUrl: process.env.LETTA_BASE_URL ?? 'http://192.168.1.12:8283',
  apiKey: process.env.LETTA_API_KEY,
  timeout: 60000,
};
