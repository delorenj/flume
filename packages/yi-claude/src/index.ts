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
