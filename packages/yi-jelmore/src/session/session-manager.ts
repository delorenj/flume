/**
 * Session Manager - Yi integration for Jelmore sessions
 *
 * Provides high-level session management for Yi agents,
 * integrating with Jelmore for agentic coding workflows.
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import {
  JelmoreClient,
  DEFAULT_JELMORE_CONFIG,
  type JelmoreConfig,
  type SessionInfo,
  type SessionConfig,
} from '../client/jelmore-client.js';

export interface SessionManagerConfig {
  jelmore?: JelmoreConfig;
  defaultProject?: string;
  defaultAgentType?: 'claude-code' | 'opencode' | 'gptme' | 'codex' | 'custom';
  autoReconnect?: boolean;
}

export interface SpawnOptions {
  agentType?: 'claude-code' | 'opencode' | 'gptme' | 'codex' | 'custom';
  role?: string;
  metadata?: Record<string, string>;
}

/**
 * Yi Session Manager - manages Jelmore sessions for agents.
 */
export class SessionManager {
  private client: JelmoreClient;
  private defaultProject: string;
  private defaultAgentType: 'claude-code' | 'opencode' | 'gptme' | 'codex' | 'custom';
  private autoReconnect: boolean;
  private activeSessions: Map<string, SessionInfo> = new Map();

  constructor(config: SessionManagerConfig = {}) {
    this.client = new JelmoreClient(config.jelmore ?? DEFAULT_JELMORE_CONFIG);
    this.defaultProject = config.defaultProject ?? 'default';
    this.defaultAgentType = config.defaultAgentType ?? 'claude-code';
    this.autoReconnect = config.autoReconnect ?? true;
  }

  /**
   * Get the Jelmore client instance.
   */
  getClient(): JelmoreClient {
    return this.client;
  }

  /**
   * Spawn a coding session for a task.
   */
  async spawnForTask(
    task: TaskPayload,
    options: SpawnOptions = {}
  ): Promise<SessionInfo> {
    const project = (task.context as Record<string, unknown>)?.project as string ?? this.defaultProject;

    console.log(`[SessionManager] Spawning session for task: ${task.id}`);

    // Check if session already exists
    const existing = await this.client.getSessionByTask(task.id);
    if (existing) {
      console.log(`[SessionManager] Found existing session: ${existing.id}`);

      if (existing.status === 'active') {
        this.activeSessions.set(task.id, existing);
        return existing;
      }

      if (this.autoReconnect && existing.status !== 'failed') {
        console.log(`[SessionManager] Reconnecting to session: ${existing.id}`);
        const reconnected = await this.client.reconnectSession(existing.id);
        this.activeSessions.set(task.id, reconnected);
        return reconnected;
      }
    }

    // Create new session
    const sessionConfig: SessionConfig = {
      taskId: task.id,
      project,
      agentType: options.agentType ?? this.defaultAgentType,
      role: options.role,
      metadata: {
        ...options.metadata,
        correlationId: task.correlationId,
        objective: task.objective.substring(0, 100),
        priority: String(task.priority ?? 0),
      },
    };

    const session = await this.client.spawnSession(sessionConfig);
    this.activeSessions.set(task.id, session);

    console.log(`[SessionManager] Session spawned: ${session.id}`);
    console.log(`[SessionManager] Zellij: ${session.zellijSession}/${session.zellijTab}/${session.zellijPane}`);

    return session;
  }

  /**
   * Get session for a task.
   */
  async getForTask(taskId: string): Promise<SessionInfo | null> {
    // Check cache first
    const cached = this.activeSessions.get(taskId);
    if (cached) {
      return cached;
    }

    // Query Jelmore
    const session = await this.client.getSessionByTask(taskId);
    if (session) {
      this.activeSessions.set(taskId, session);
    }

    return session;
  }

  /**
   * Focus on a task's session (navigate to its pane).
   */
  async focusTask(taskId: string): Promise<boolean> {
    const session = await this.getForTask(taskId);
    if (!session) {
      console.warn(`[SessionManager] No session found for task: ${taskId}`);
      return false;
    }

    await this.client.focusSession(session.id);
    console.log(`[SessionManager] Focused on session: ${session.id}`);
    return true;
  }

  /**
   * Send input to a task's session.
   */
  async sendToTask(taskId: string, input: string): Promise<boolean> {
    const session = await this.getForTask(taskId);
    if (!session) {
      console.warn(`[SessionManager] No session found for task: ${taskId}`);
      return false;
    }

    await this.client.sendInput(session.id, input);
    return true;
  }

  /**
   * Get recent output from a task's session.
   */
  async getTaskOutput(taskId: string, lines = 100): Promise<string[] | null> {
    const session = await this.getForTask(taskId);
    if (!session) {
      return null;
    }

    const output = await this.client.getSessionOutput(session.id, lines);
    return output.lines;
  }

  /**
   * Terminate a task's session.
   */
  async terminateTask(taskId: string): Promise<void> {
    const session = await this.getForTask(taskId);
    if (session) {
      await this.client.terminateSession(session.id);
      this.activeSessions.delete(taskId);
      console.log(`[SessionManager] Terminated session for task: ${taskId}`);
    }
  }

  /**
   * Spawn a multi-agent workspace for an epic.
   */
  async spawnWorkspace(
    epicId: string,
    project: string,
    roles: Array<{ role: string; agentType?: string }>
  ): Promise<SessionInfo[]> {
    console.log(`[SessionManager] Creating workspace for epic: ${epicId}`);

    const workspace = await this.client.createWorkspace({
      epicId,
      project,
      roles: roles.map(r => ({
        role: r.role,
        agentType: r.agentType ?? this.defaultAgentType,
      })),
    });

    console.log(`[SessionManager] Workspace created with ${workspace.sessions.length} sessions`);

    return workspace.sessions;
  }

  /**
   * Get all active sessions.
   */
  async listActive(project?: string): Promise<SessionInfo[]> {
    const sessions = await this.client.listSessions(project);
    return sessions.filter(s => s.status === 'active');
  }

  /**
   * Cleanup stale sessions.
   */
  async cleanup(): Promise<{ found: number; cleaned: number }> {
    console.log(`[SessionManager] Running cleanup...`);
    const result = await this.client.reconcile();
    console.log(`[SessionManager] Cleanup: ${result.cleaned} stale sessions removed`);
    return { found: result.found, cleaned: result.cleaned };
  }

  /**
   * Check if Jelmore is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.client.health();
      return health.status === 'healthy';
    } catch {
      return false;
    }
  }
}
