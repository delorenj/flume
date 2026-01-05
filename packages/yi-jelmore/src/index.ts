/**
 * @yi/jelmore - Jelmore Session Integration for Yi
 *
 * Provides integration with Jelmore for managing agentic coding sessions
 * in Zellij terminal multiplexer environments.
 *
 * Key components:
 * - JelmoreClient: HTTP client for Jelmore API
 * - SessionManager: High-level session management for Yi agents
 * - SessionContributor: Agent that executes tasks via Jelmore sessions
 */

// Client
export {
  JelmoreClient,
  DEFAULT_JELMORE_CONFIG,
  type JelmoreConfig,
  type SessionConfig,
  type SessionInfo,
  type SessionOutput,
  type WorkspaceConfig,
  type WorkspaceInfo,
} from './client/jelmore-client.js';

// Session Management
export {
  SessionManager,
  type SessionManagerConfig,
  type SpawnOptions,
} from './session/session-manager.js';

// Agent
export {
  SessionContributor,
  type SessionContributorConfig,
} from './session/session-contributor.js';
