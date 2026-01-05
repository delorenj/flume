/**
 * Letta Memory Strategy - Yi memory backed by Letta's memory system
 *
 * Uses Letta agents' built-in memory blocks for team context storage.
 */

import type {
  YiMemoryStrategy,
  MemoryContext,
  MemoryShard,
  MemorySearchResult,
} from '@yi/adapter';
import type { LettaClient } from '../client/letta-client.js';

/**
 * Memory strategy using Letta's native memory system.
 */
export class LettaMemoryStrategy implements YiMemoryStrategy {
  readonly name = 'letta-memory';

  private lettaClient: LettaClient;
  private memoryAgentId: string | null = null;

  constructor(lettaClient: LettaClient) {
    this.lettaClient = lettaClient;
  }

  /**
   * Initialize a dedicated memory agent for shared knowledge.
   */
  async initialize(): Promise<void> {
    if (this.memoryAgentId) return;

    console.log(`[LettaMemory] Creating shared memory agent...`);

    const agent = await this.lettaClient.createAgent({
      name: 'yi-memory-store',
      description: 'Yi shared memory and knowledge base',
      system: `You are a knowledge store agent. Your role is to:
1. Store and retrieve team knowledge
2. Maintain context across conversations
3. Search and synthesize information
4. Never execute tasks - only manage knowledge`,
      memoryBlocks: [
        {
          label: 'knowledge_bases',
          value: JSON.stringify({}),
        },
        {
          label: 'active_shards',
          value: JSON.stringify({}),
        },
      ],
    });

    this.memoryAgentId = agent.id;
    console.log(`[LettaMemory] Memory agent created: ${this.memoryAgentId}`);
  }

  /**
   * Fetch context from a knowledge base.
   */
  async fetchContext(knowledgeBaseId: string): Promise<MemoryContext> {
    if (!this.memoryAgentId) {
      await this.initialize();
    }

    // Query the memory agent for context
    const response = await this.lettaClient.sendMessage(
      this.memoryAgentId!,
      `Retrieve the full context for knowledge base: ${knowledgeBaseId}.
       Return as JSON with fields: memories (array), lessonsLearned (array), skills (array).`
    );

    // Parse the response
    const text = response.messages
      .filter(m => m.role === 'assistant' && m.text)
      .map(m => m.text)
      .join('\n');

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as MemoryContext;
      }
    } catch {
      // Parse failed
    }

    // Return default context
    return {
      core: '',
      conversations: [],
      knowledge: {},
      skills: [],
      protocols: [],
    };
  }

  /**
   * Sync new context to a knowledge base.
   */
  async syncContext(
    knowledgeBaseId: string,
    context: MemoryContext
  ): Promise<void> {
    if (!this.memoryAgentId) {
      await this.initialize();
    }

    await this.lettaClient.sendMessage(
      this.memoryAgentId!,
      `Update knowledge base "${knowledgeBaseId}" with the following context:
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`
Store this in your memory and confirm the update.`
    );

    console.log(`[LettaMemory] Synced context for: ${knowledgeBaseId}`);
  }

  /**
   * Search memory for relevant information.
   */
  async search(
    knowledgeBaseId: string,
    query: string,
    topK = 5
  ): Promise<MemorySearchResult[]> {
    if (!this.memoryAgentId) {
      await this.initialize();
    }

    const response = await this.lettaClient.sendMessage(
      this.memoryAgentId!,
      `Search knowledge base "${knowledgeBaseId}" for: ${query}
       Return up to ${topK} relevant results as JSON array with fields:
       - content: string (the relevant information)
       - score: number (relevance 0-1)
       - source: string (where this came from)`
    );

    const text = response.messages
      .filter(m => m.role === 'assistant' && m.text)
      .map(m => m.text)
      .join('\n');

    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as MemorySearchResult[];
      }
    } catch {
      // Parse failed
    }

    return [];
  }

  /**
   * Get the active memory shard for an agent.
   */
  async getActiveShard(agentId: string): Promise<MemoryShard | null> {
    if (!this.memoryAgentId) {
      await this.initialize();
    }

    const response = await this.lettaClient.sendMessage(
      this.memoryAgentId!,
      `Get active memory shard for agent: ${agentId}
       Return as JSON with fields: id, name, scope, lastAccessed.
       Return null if no active shard.`
    );

    const text = response.messages
      .filter(m => m.role === 'assistant' && m.text)
      .map(m => m.text)
      .join('\n');

    if (text.includes('null') || text.includes('no active')) {
      return null;
    }

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as MemoryShard;
      }
    } catch {
      // Parse failed
    }

    return null;
  }

  /**
   * Switch an agent's active memory shard.
   */
  async switchShard(agentId: string, shardId: string): Promise<void> {
    if (!this.memoryAgentId) {
      await this.initialize();
    }

    await this.lettaClient.sendMessage(
      this.memoryAgentId!,
      `Switch agent "${agentId}" to memory shard "${shardId}".
       Update your records and confirm the switch.`
    );

    console.log(`[LettaMemory] Switched shard for ${agentId} to ${shardId}`);
  }

  /**
   * Cleanup the memory agent.
   */
  async cleanup(): Promise<void> {
    if (this.memoryAgentId) {
      console.log(`[LettaMemory] Cleaning up memory agent...`);
      try {
        await this.lettaClient.deleteAgent(this.memoryAgentId);
      } catch (error) {
        console.warn(`[LettaMemory] Failed to delete memory agent:`, error);
      }
      this.memoryAgentId = null;
    }
  }
}
