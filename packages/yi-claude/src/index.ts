/**
 * @yi/claude - Claude API Integration for Yi
 *
 * Provides Claude API-backed implementations of Yi's agent hierarchy:
 * - ClaudeContributor: Workers powered by Claude API
 * - ClaudeManager: Team leads with delegation + IC capability
 * - ClaudeDirector: Strategic orchestrators using Claude
 *
 * Also includes:
 * - ClaudeFactory: Creates and manages Claude-backed agents
 */

// Agents
export {
  ClaudeContributor,
  type ClaudeContributorConfig,
  type StreamEventHandler,
  type StreamingResult,
  type ToolDefinition,
  type ToolExecutor,
  type ToolInputProperty,
  type ToolUseResult,
} from './agents/claude-contributor.js';

export {
  ClaudeManager,
  type ClaudeManagerConfig,
} from './agents/claude-manager.js';

export {
  ClaudeDirector,
  type ClaudeDirectorConfig,
} from './agents/claude-director.js';

// Factory
export {
  ClaudeFactory,
  type ClaudeFactoryConfig,
} from './factory/claude-factory.js';

// Context management
export {
  ConversationContext,
  createContextForModel,
  CLAUDE_CONTEXT_WINDOWS,
  type ConversationContextConfig,
  type ConversationContextEvents,
  type ConversationMessage,
  type ContextStats,
  type TruncationEvent,
  type TruncationStrategy,
} from './context/index.js';
