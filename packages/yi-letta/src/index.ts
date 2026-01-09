/**
 * @yi/letta - Letta Agent Integration for Yi
 *
 * Provides Letta-backed implementations of Yi's agent hierarchy:
 * - LettaContributor: Leaf workers powered by Letta
 * - LettaManager: Team leads with delegation + IC capability
 * - LettaDirector: Strategic orchestrators using Letta for decisions
 *
 * Also includes:
 * - LettaFactory: Creates and manages Letta agents
 * - LettaMemoryStrategy: Yi memory backed by Letta's memory system
 * - LettaClient: HTTP client for Letta server API
 */

// Client
export {
  LettaClient,
  DEFAULT_LETTA_CONFIG,
  type LettaConfig,
  type LettaAgentConfig,
  type LettaAgent,
  type LettaMessage,
  type LettaResponse,
} from './client/letta-client.js';

// Agents
export {
  LettaContributor,
  type LettaContributorConfig,
  type LettaAgentState,
} from './agents/letta-contributor.js';

export {
  LettaManager,
  type LettaManagerConfig,
} from './agents/letta-manager.js';

export {
  LettaDirector,
  type LettaDirectorConfig,
} from './agents/letta-director.js';

// Factory
export {
  LettaFactory,
  type LettaFactoryConfig,
} from './factory/letta-factory.js';

// Memory
export { LettaMemoryStrategy } from './memory/letta-memory.js';

// Memory Block Management
export {
  MemoryBlockManager,
  createMemoryManager,
  type MemoryBlockManagerConfig,
  type MemoryBlockType,
  type TypedMemoryBlock,
  type CoreMemoryContent,
  type PersonaMemoryContent,
  type KnowledgeMemoryContent,
  type TaskContextMemoryContent,
  type TeamContextMemoryContent,
  type MemoryStats,
  type MemoryBlockChange,
} from './memory/index.js';
