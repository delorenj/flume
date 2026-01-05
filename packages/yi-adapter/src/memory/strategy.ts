/**
 * Memory Strategy - How agents remember things
 *
 * Yi enforces memory strategies at the team level.
 * All YiManagers on a team share the same memory strategy.
 */

/**
 * Memory shard pointer - reference to actual memory storage.
 */
export interface MemoryShard {
  /** Unique shard ID */
  id: string;

  /** Type of memory store */
  type: 'qdrant' | 'agentfile' | 'neo4j' | 'letta-core' | 'redis' | 'custom';

  /** URI to actual memory location */
  pointer: string;

  /** When this shard was created */
  createdAt: string;

  /** Whether this is the active shard */
  isActive: boolean;

  /** Metadata about the shard */
  metadata?: Record<string, unknown>;
}

/**
 * Memory strategy interface - how context is stored and retrieved.
 */
export interface YiMemoryStrategy {
  /** Strategy name for logging */
  name: string;

  /**
   * Fetch context from the memory store.
   * @param knowledgeBaseId - ID of the knowledge base to fetch from
   */
  fetchContext(knowledgeBaseId: string): Promise<MemoryContext>;

  /**
   * Sync new context to the memory store.
   * @param knowledgeBaseId - ID of the knowledge base
   * @param context - Context to store
   */
  syncContext(knowledgeBaseId: string, context: MemoryContext): Promise<void>;

  /**
   * Search memory for relevant context.
   * @param knowledgeBaseId - ID of the knowledge base
   * @param query - Search query
   * @param topK - Number of results to return
   */
  search(
    knowledgeBaseId: string,
    query: string,
    topK?: number
  ): Promise<MemorySearchResult[]>;

  /**
   * Get active memory shard for an agent.
   */
  getActiveShard(agentId: string): Promise<MemoryShard | null>;

  /**
   * Switch active memory shard (checkpoint).
   */
  switchShard(agentId: string, shardId: string): Promise<void>;
}

/**
 * Context retrieved from memory.
 */
export interface MemoryContext {
  /** Core memory content */
  core: string;

  /** Recent conversation history */
  conversations?: ConversationEntry[];

  /** Domain-specific knowledge */
  knowledge?: Record<string, unknown>;

  /** Skills and capabilities */
  skills?: string[];

  /** Team protocols and standards */
  protocols?: string[];
}

/**
 * Conversation entry in memory.
 */
export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

/**
 * Search result from memory.
 */
export interface MemorySearchResult {
  /** Content of the memory */
  content: string;

  /** Relevance score (0-1) */
  score: number;

  /** Source document/conversation */
  source: string;

  /** When this memory was created */
  timestamp: string;
}
