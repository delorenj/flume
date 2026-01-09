/**
 * Memory Block Manager - High-level API for Letta memory management
 *
 * Provides typed memory blocks (core, persona, knowledge, task_context)
 * with validation, serialization, and team context integration.
 */

import type { LettaClient } from '../client/letta-client.js';

/**
 * Memory block types supported by Letta agents.
 */
export type MemoryBlockType =
  | 'core'        // Core identity and behavior
  | 'persona'     // Agent persona and characteristics
  | 'knowledge'   // Domain knowledge and learned information
  | 'task_context' // Current task context and state
  | 'team_context' // Team-specific context and protocols
  | 'custom';     // User-defined custom blocks

/**
 * Memory block with typed content.
 */
export interface TypedMemoryBlock<T = unknown> {
  /** Block label/identifier */
  label: string;
  /** Block type */
  type: MemoryBlockType;
  /** Block content (typed for specific block types) */
  content: T;
  /** Last updated timestamp */
  updatedAt: Date;
  /** Whether this block is persistent (survives truncation) */
  persistent: boolean;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Core memory block content.
 */
export interface CoreMemoryContent {
  /** Agent's primary purpose */
  purpose: string;
  /** Behavioral guidelines */
  guidelines: string[];
  /** Constraints and limitations */
  constraints: string[];
}

/**
 * Persona memory block content.
 */
export interface PersonaMemoryContent {
  /** Agent name */
  name: string;
  /** Agent role */
  role: string;
  /** Skills list */
  skills: string[];
  /** Team ID */
  teamId: string;
  /** Communication style */
  communicationStyle?: string;
  /** Expertise areas */
  expertise?: string[];
}

/**
 * Knowledge memory block content.
 */
export interface KnowledgeMemoryContent {
  /** Domain of knowledge */
  domain: string;
  /** Knowledge items */
  items: Array<{
    topic: string;
    content: string;
    confidence: 'high' | 'medium' | 'low';
    source?: string;
    addedAt: string;
  }>;
}

/**
 * Task context memory block content.
 */
export interface TaskContextMemoryContent {
  /** Current task ID */
  taskId?: string;
  /** Task objective */
  objective?: string;
  /** Task context/additional info */
  context?: Record<string, unknown>;
  /** Task priority */
  priority?: string;
  /** Task tags */
  tags?: string[];
  /** Progress notes */
  progress?: string[];
  /** Active since */
  activeSince?: string;
}

/**
 * Team context memory block content.
 */
export interface TeamContextMemoryContent {
  /** Team mission */
  mission: string;
  /** Team protocols */
  protocols: string[];
  /** Access level */
  accessLevel: string;
  /** Team members (names/roles) */
  teamMembers?: Array<{ name: string; role: string }>;
  /** Communication channels */
  channels?: string[];
}

/**
 * Memory statistics.
 */
export interface MemoryStats {
  /** Total number of blocks */
  totalBlocks: number;
  /** Blocks by type */
  blocksByType: Record<MemoryBlockType, number>;
  /** Total content size (characters) */
  totalSize: number;
  /** Largest block size */
  largestBlockSize: number;
  /** Oldest block update */
  oldestUpdate: Date | null;
  /** Newest block update */
  newestUpdate: Date | null;
}

/**
 * Configuration for MemoryBlockManager.
 */
export interface MemoryBlockManagerConfig {
  /** Letta client */
  client: LettaClient;
  /** Letta agent ID */
  agentId: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Maximum size per block (characters) */
  maxBlockSize?: number;
}

/**
 * Event data for block changes.
 */
export interface MemoryBlockChange {
  label: string;
  type: MemoryBlockType;
  action: 'created' | 'updated' | 'deleted';
  timestamp: Date;
}

/**
 * Manages memory blocks for a Letta agent with typed APIs.
 */
export class MemoryBlockManager {
  private client: LettaClient;
  private agentId: string;
  private verbose: boolean;
  private maxBlockSize: number;
  private cache: Map<string, TypedMemoryBlock> = new Map();
  private changeListeners: Array<(change: MemoryBlockChange) => void> = [];

  constructor(config: MemoryBlockManagerConfig) {
    this.client = config.client;
    this.agentId = config.agentId;
    this.verbose = config.verbose ?? false;
    this.maxBlockSize = config.maxBlockSize ?? 32000;
  }

  // ============================================================================
  // Core Memory API
  // ============================================================================

  /**
   * Set core memory block (identity and behavior).
   */
  async setCore(content: CoreMemoryContent): Promise<void> {
    await this.setBlock('core', 'core', content, true);
  }

  /**
   * Get core memory block.
   */
  async getCore(): Promise<CoreMemoryContent | null> {
    const block = await this.getBlock<CoreMemoryContent>('core');
    return block?.content ?? null;
  }

  // ============================================================================
  // Persona Memory API
  // ============================================================================

  /**
   * Set persona memory block (agent characteristics).
   */
  async setPersona(content: PersonaMemoryContent): Promise<void> {
    await this.setBlock('persona', 'persona', content, true);
  }

  /**
   * Get persona memory block.
   */
  async getPersona(): Promise<PersonaMemoryContent | null> {
    const block = await this.getBlock<PersonaMemoryContent>('persona');
    return block?.content ?? null;
  }

  /**
   * Update persona fields (partial update).
   */
  async updatePersona(updates: Partial<PersonaMemoryContent>): Promise<void> {
    const current = await this.getPersona();
    if (!current) {
      throw new Error('Persona block not found. Use setPersona first.');
    }
    await this.setPersona({ ...current, ...updates });
  }

  // ============================================================================
  // Knowledge Memory API
  // ============================================================================

  /**
   * Set knowledge memory block.
   */
  async setKnowledge(domain: string, items: KnowledgeMemoryContent['items']): Promise<void> {
    await this.setBlock('knowledge', 'knowledge', { domain, items }, true);
  }

  /**
   * Get knowledge memory block.
   */
  async getKnowledge(): Promise<KnowledgeMemoryContent | null> {
    const block = await this.getBlock<KnowledgeMemoryContent>('knowledge');
    return block?.content ?? null;
  }

  /**
   * Add a knowledge item.
   */
  async addKnowledge(
    topic: string,
    content: string,
    confidence: 'high' | 'medium' | 'low' = 'medium',
    source?: string
  ): Promise<void> {
    let current = await this.getKnowledge();
    if (!current) {
      current = { domain: 'general', items: [] };
    }

    current.items.push({
      topic,
      content,
      confidence,
      source,
      addedAt: new Date().toISOString(),
    });

    await this.setKnowledge(current.domain, current.items);
  }

  /**
   * Remove a knowledge item by topic.
   */
  async removeKnowledge(topic: string): Promise<boolean> {
    const current = await this.getKnowledge();
    if (!current) return false;

    const originalLength = current.items.length;
    current.items = current.items.filter((item) => item.topic !== topic);

    if (current.items.length < originalLength) {
      await this.setKnowledge(current.domain, current.items);
      return true;
    }
    return false;
  }

  // ============================================================================
  // Task Context Memory API
  // ============================================================================

  /**
   * Set task context memory block.
   */
  async setTaskContext(content: TaskContextMemoryContent): Promise<void> {
    await this.setBlock('task_context', 'task_context', content, false);
  }

  /**
   * Get task context memory block.
   */
  async getTaskContext(): Promise<TaskContextMemoryContent | null> {
    const block = await this.getBlock<TaskContextMemoryContent>('task_context');
    return block?.content ?? null;
  }

  /**
   * Clear task context (after task completion).
   */
  async clearTaskContext(): Promise<void> {
    await this.setTaskContext({});
    this.log('Task context cleared');
  }

  /**
   * Add progress note to task context.
   */
  async addProgressNote(note: string): Promise<void> {
    const current = await this.getTaskContext();
    const updated: TaskContextMemoryContent = current ?? {};
    updated.progress = updated.progress ?? [];
    updated.progress.push(`[${new Date().toISOString()}] ${note}`);
    await this.setTaskContext(updated);
  }

  // ============================================================================
  // Team Context Memory API
  // ============================================================================

  /**
   * Set team context memory block.
   */
  async setTeamContext(content: TeamContextMemoryContent): Promise<void> {
    await this.setBlock('team_context', 'team_context', content, true);
  }

  /**
   * Get team context memory block.
   */
  async getTeamContext(): Promise<TeamContextMemoryContent | null> {
    const block = await this.getBlock<TeamContextMemoryContent>('team_context');
    return block?.content ?? null;
  }

  // ============================================================================
  // Custom Memory Block API
  // ============================================================================

  /**
   * Set a custom memory block.
   */
  async setCustomBlock<T>(
    label: string,
    content: T,
    persistent: boolean = false,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.setBlock(label, 'custom', content, persistent, metadata);
  }

  /**
   * Get a custom memory block.
   */
  async getCustomBlock<T>(label: string): Promise<T | null> {
    const block = await this.getBlock<T>(label);
    return block?.content ?? null;
  }

  // ============================================================================
  // Generic Memory Operations
  // ============================================================================

  /**
   * Set a memory block (internal).
   */
  private async setBlock<T>(
    label: string,
    type: MemoryBlockType,
    content: T,
    persistent: boolean,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const serialized = JSON.stringify(content);

    if (serialized.length > this.maxBlockSize) {
      throw new Error(
        `Block ${label} exceeds max size (${serialized.length} > ${this.maxBlockSize})`
      );
    }

    await this.client.updateMemoryBlock(this.agentId, label, serialized);

    const block: TypedMemoryBlock<T> = {
      label,
      type,
      content,
      updatedAt: new Date(),
      persistent,
      metadata,
    };

    this.cache.set(label, block as TypedMemoryBlock);
    this.notifyChange({ label, type, action: 'updated', timestamp: new Date() });
    this.log(`Set ${type} block: ${label}`);
  }

  /**
   * Get a memory block (internal).
   */
  private async getBlock<T>(label: string): Promise<TypedMemoryBlock<T> | null> {
    // Check cache first
    if (this.cache.has(label)) {
      return this.cache.get(label) as TypedMemoryBlock<T>;
    }

    // Fetch from server
    const blocks = await this.getAllBlocksFromServer();
    const block = blocks.find((b) => b.label === label);

    if (!block) return null;

    try {
      const content = JSON.parse(block.value) as T;
      const typed: TypedMemoryBlock<T> = {
        label: block.label,
        type: this.inferBlockType(block.label),
        content,
        updatedAt: new Date(),
        persistent: this.isPersistentBlock(block.label),
      };

      this.cache.set(label, typed as TypedMemoryBlock);
      return typed;
    } catch {
      // Not JSON, return as string
      const typed: TypedMemoryBlock<T> = {
        label: block.label,
        type: 'custom',
        content: block.value as unknown as T,
        updatedAt: new Date(),
        persistent: false,
      };
      return typed;
    }
  }

  /**
   * Delete a memory block.
   */
  async deleteBlock(label: string): Promise<boolean> {
    try {
      // Set to empty to effectively "delete" (Letta may not support true delete)
      await this.client.updateMemoryBlock(this.agentId, label, '');
      this.cache.delete(label);
      this.notifyChange({
        label,
        type: this.inferBlockType(label),
        action: 'deleted',
        timestamp: new Date(),
      });
      this.log(`Deleted block: ${label}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all memory blocks.
   */
  async getAllBlocks(): Promise<TypedMemoryBlock[]> {
    const serverBlocks = await this.getAllBlocksFromServer();
    const result: TypedMemoryBlock[] = [];

    for (const block of serverBlocks) {
      try {
        const content = JSON.parse(block.value);
        result.push({
          label: block.label,
          type: this.inferBlockType(block.label),
          content,
          updatedAt: new Date(),
          persistent: this.isPersistentBlock(block.label),
        });
      } catch {
        result.push({
          label: block.label,
          type: 'custom',
          content: block.value,
          updatedAt: new Date(),
          persistent: false,
        });
      }
    }

    return result;
  }

  /**
   * Get memory statistics.
   */
  async getStats(): Promise<MemoryStats> {
    const blocks = await this.getAllBlocks();

    const blocksByType: Record<MemoryBlockType, number> = {
      core: 0,
      persona: 0,
      knowledge: 0,
      task_context: 0,
      team_context: 0,
      custom: 0,
    };

    let totalSize = 0;
    let largestBlockSize = 0;
    let oldestUpdate: Date | null = null;
    let newestUpdate: Date | null = null;

    for (const block of blocks) {
      blocksByType[block.type]++;
      const size = JSON.stringify(block.content).length;
      totalSize += size;
      if (size > largestBlockSize) largestBlockSize = size;

      if (!oldestUpdate || block.updatedAt < oldestUpdate) {
        oldestUpdate = block.updatedAt;
      }
      if (!newestUpdate || block.updatedAt > newestUpdate) {
        newestUpdate = block.updatedAt;
      }
    }

    return {
      totalBlocks: blocks.length,
      blocksByType,
      totalSize,
      largestBlockSize,
      oldestUpdate,
      newestUpdate,
    };
  }

  /**
   * Get memory summary for agent status reporting.
   */
  async getStatusSummary(): Promise<{
    blocks: number;
    hasPersona: boolean;
    hasTask: boolean;
    hasTeam: boolean;
    size: number;
  }> {
    const blocks = await this.getAllBlocks();

    return {
      blocks: blocks.length,
      hasPersona: blocks.some((b) => b.type === 'persona'),
      hasTask: blocks.some((b) => b.type === 'task_context' && b.content),
      hasTeam: blocks.some((b) => b.type === 'team_context'),
      size: blocks.reduce((sum, b) => sum + JSON.stringify(b.content).length, 0),
    };
  }

  /**
   * Clear cache (force re-fetch from server).
   */
  clearCache(): void {
    this.cache.clear();
    this.log('Cache cleared');
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /**
   * Register a change listener.
   */
  onBlockChange(listener: (change: MemoryBlockChange) => void): void {
    this.changeListeners.push(listener);
  }

  /**
   * Remove a change listener.
   */
  offBlockChange(listener: (change: MemoryBlockChange) => void): void {
    this.changeListeners = this.changeListeners.filter((l) => l !== listener);
  }

  private notifyChange(change: MemoryBlockChange): void {
    for (const listener of this.changeListeners) {
      try {
        listener(change);
      } catch (error) {
        console.error('Block change listener error:', error);
      }
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private async getAllBlocksFromServer(): Promise<Array<{ label: string; value: string }>> {
    const agent = await this.client.getAgent(this.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${this.agentId}`);
    }
    return agent.memory.blocks.map((b) => ({ label: b.label, value: b.value }));
  }

  private inferBlockType(label: string): MemoryBlockType {
    const typeMap: Record<string, MemoryBlockType> = {
      core: 'core',
      persona: 'persona',
      knowledge: 'knowledge',
      task_context: 'task_context',
      team_context: 'team_context',
    };
    return typeMap[label] ?? 'custom';
  }

  private isPersistentBlock(label: string): boolean {
    const persistentBlocks = ['core', 'persona', 'knowledge', 'team_context'];
    return persistentBlocks.includes(label);
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(`[MemoryBlockManager] ${message}`);
    }
  }
}

/**
 * Create a memory block manager for an agent.
 */
export function createMemoryManager(
  client: LettaClient,
  agentId: string,
  options?: { verbose?: boolean; maxBlockSize?: number }
): MemoryBlockManager {
  return new MemoryBlockManager({
    client,
    agentId,
    verbose: options?.verbose,
    maxBlockSize: options?.maxBlockSize,
  });
}
