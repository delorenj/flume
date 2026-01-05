/**
 * Echo Memory - In-memory mock for YiMemoryStrategy
 */

import { v4 as uuid } from 'uuid';
import type {
  YiMemoryStrategy,
  MemoryShard,
  MemoryContext,
  MemorySearchResult,
} from '@yi/adapter';

/**
 * In-memory mock memory strategy.
 * Stores everything in Maps - no persistence.
 */
export class EchoMemory implements YiMemoryStrategy {
  readonly name = 'echo-memory';

  private contexts: Map<string, MemoryContext> = new Map();
  private shards: Map<string, MemoryShard[]> = new Map();
  private activeShards: Map<string, string> = new Map();

  constructor() {
    // Initialize with default context
    this.contexts.set('default', {
      core: 'You are an Echo agent in the 33GOD ecosystem.',
      skills: ['echo', 'testing'],
      protocols: ['Always respond politely', 'Log all actions'],
    });
  }

  async fetchContext(knowledgeBaseId: string): Promise<MemoryContext> {
    const context = this.contexts.get(knowledgeBaseId);
    if (context) {
      console.log(`[EchoMemory] Fetched context for ${knowledgeBaseId}`);
      return context;
    }

    // Return default context if not found
    console.log(
      `[EchoMemory] No context for ${knowledgeBaseId}, returning default`
    );
    return this.contexts.get('default')!;
  }

  async syncContext(
    knowledgeBaseId: string,
    context: MemoryContext
  ): Promise<void> {
    this.contexts.set(knowledgeBaseId, context);
    console.log(`[EchoMemory] Synced context for ${knowledgeBaseId}`);
  }

  async search(
    knowledgeBaseId: string,
    query: string,
    topK = 5
  ): Promise<MemorySearchResult[]> {
    console.log(
      `[EchoMemory] Searching "${query}" in ${knowledgeBaseId} (top ${topK})`
    );

    // Mock search results
    return [
      {
        content: `Mock result for: ${query}`,
        score: 0.95,
        source: 'echo-memory',
        timestamp: new Date().toISOString(),
      },
    ];
  }

  async getActiveShard(agentId: string): Promise<MemoryShard | null> {
    const activeId = this.activeShards.get(agentId);
    if (!activeId) {
      return null;
    }

    const agentShards = this.shards.get(agentId) ?? [];
    return agentShards.find((s) => s.id === activeId) ?? null;
  }

  async switchShard(agentId: string, shardId: string): Promise<void> {
    const agentShards = this.shards.get(agentId) ?? [];
    const shard = agentShards.find((s) => s.id === shardId);

    if (!shard) {
      throw new Error(`Shard ${shardId} not found for agent ${agentId}`);
    }

    // Deactivate current shard
    for (const s of agentShards) {
      s.isActive = false;
    }

    // Activate new shard
    shard.isActive = true;
    this.activeShards.set(agentId, shardId);

    console.log(`[EchoMemory] Switched agent ${agentId} to shard ${shardId}`);
  }

  /**
   * Create a new memory shard for an agent.
   */
  createShard(agentId: string, type: MemoryShard['type'] = 'custom'): MemoryShard {
    const shard: MemoryShard = {
      id: uuid(),
      type,
      pointer: `echo://memory/${agentId}/${uuid()}`,
      createdAt: new Date().toISOString(),
      isActive: false,
    };

    const agentShards = this.shards.get(agentId) ?? [];
    agentShards.push(shard);
    this.shards.set(agentId, agentShards);

    console.log(`[EchoMemory] Created shard ${shard.id} for agent ${agentId}`);
    return shard;
  }
}
