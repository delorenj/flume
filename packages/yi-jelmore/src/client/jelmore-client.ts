/**
 * Jelmore Client - HTTP client for Jelmore session API
 *
 * Interfaces with the Jelmore FastAPI service to manage
 * agentic coding sessions in Zellij terminal multiplexer.
 */

export interface JelmoreConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

export interface SessionConfig {
  taskId: string;
  project: string;
  agentType: 'claude-code' | 'opencode' | 'gptme' | 'codex' | 'custom';
  role?: string;
  metadata?: Record<string, string>;
}

export interface SessionInfo {
  id: string;
  taskId: string;
  project: string;
  agentType: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'stale';
  zellijSession: string;
  zellijTab: string;
  zellijPane: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, string>;
}

export interface SessionOutput {
  sessionId: string;
  lines: string[];
  hasMore: boolean;
  timestamp: string;
}

export interface WorkspaceConfig {
  epicId: string;
  project: string;
  roles: Array<{
    role: string;
    agentType: string;
  }>;
}

export interface WorkspaceInfo {
  epicId: string;
  project: string;
  sessions: SessionInfo[];
  status: 'ready' | 'partial' | 'failed';
}

/**
 * HTTP client for Jelmore session management API.
 */
export class JelmoreClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeout: number;

  constructor(config: JelmoreConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;
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
        throw new Error(`Jelmore API error ${response.status}: ${error}`);
      }

      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================================
  // Session Operations
  // ============================================================================

  /**
   * Spawn a new coding session.
   */
  async spawnSession(config: SessionConfig): Promise<SessionInfo> {
    return this.request<SessionInfo>('POST', '/api/v1/sessions', {
      task_id: config.taskId,
      project: config.project,
      agent_type: config.agentType,
      role: config.role,
      metadata: config.metadata,
    });
  }

  /**
   * Get session information.
   */
  async getSession(sessionId: string): Promise<SessionInfo | null> {
    try {
      return await this.request<SessionInfo>('GET', `/api/v1/sessions/${sessionId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get session by task ID.
   */
  async getSessionByTask(taskId: string): Promise<SessionInfo | null> {
    try {
      return await this.request<SessionInfo>('GET', `/api/v1/sessions/task/${taskId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all active sessions.
   */
  async listSessions(projectFilter?: string): Promise<SessionInfo[]> {
    const path = projectFilter
      ? `/api/v1/sessions?project=${encodeURIComponent(projectFilter)}`
      : '/api/v1/sessions';
    return this.request<SessionInfo[]>('GET', path);
  }

  /**
   * Reconnect to an existing session.
   */
  async reconnectSession(sessionId: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('POST', `/api/v1/sessions/${sessionId}/reconnect`);
  }

  /**
   * Pause a session (detach from Zellij).
   */
  async pauseSession(sessionId: string): Promise<void> {
    await this.request<void>('POST', `/api/v1/sessions/${sessionId}/pause`);
  }

  /**
   * Resume a paused session.
   */
  async resumeSession(sessionId: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('POST', `/api/v1/sessions/${sessionId}/resume`);
  }

  /**
   * Terminate a session.
   */
  async terminateSession(sessionId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v1/sessions/${sessionId}`);
  }

  /**
   * Get recent output from a session.
   */
  async getSessionOutput(
    sessionId: string,
    lines = 100
  ): Promise<SessionOutput> {
    return this.request<SessionOutput>(
      'GET',
      `/api/v1/sessions/${sessionId}/output?lines=${lines}`
    );
  }

  /**
   * Send input to a session.
   */
  async sendInput(sessionId: string, input: string): Promise<void> {
    await this.request<void>('POST', `/api/v1/sessions/${sessionId}/input`, {
      input,
    });
  }

  // ============================================================================
  // Workspace Operations
  // ============================================================================

  /**
   * Create a multi-agent workspace for an epic.
   */
  async createWorkspace(config: WorkspaceConfig): Promise<WorkspaceInfo> {
    return this.request<WorkspaceInfo>('POST', '/api/v1/workspaces', {
      epic_id: config.epicId,
      project: config.project,
      roles: config.roles.map(r => ({
        role: r.role,
        agent_type: r.agentType,
      })),
    });
  }

  /**
   * Get workspace status.
   */
  async getWorkspace(epicId: string): Promise<WorkspaceInfo | null> {
    try {
      return await this.request<WorkspaceInfo>('GET', `/api/v1/workspaces/${epicId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Cleanup workspace sessions.
   */
  async cleanupWorkspace(epicId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v1/workspaces/${epicId}`);
  }

  // ============================================================================
  // Navigation
  // ============================================================================

  /**
   * Focus on a specific session (navigate to its pane).
   */
  async focusSession(sessionId: string): Promise<void> {
    await this.request<void>('POST', `/api/v1/sessions/${sessionId}/focus`);
  }

  /**
   * Get navigation info to reach a session.
   */
  async getNavigationInfo(sessionId: string): Promise<{
    session: string;
    tab: string;
    pane: string;
    command: string;
  }> {
    return this.request<{
      session: string;
      tab: string;
      pane: string;
      command: string;
    }>('GET', `/api/v1/sessions/${sessionId}/nav`);
  }

  // ============================================================================
  // Health Check
  // ============================================================================

  /**
   * Check if Jelmore service is healthy.
   */
  async health(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    redis: boolean;
    zellij: boolean;
    version: string;
  }> {
    return this.request<{
      status: 'healthy' | 'degraded' | 'unhealthy';
      redis: boolean;
      zellij: boolean;
      version: string;
    }>('GET', '/api/v1/health');
  }

  /**
   * Run reconciliation to sync Redis state with actual Zellij sessions.
   */
  async reconcile(): Promise<{
    found: number;
    stale: number;
    cleaned: number;
  }> {
    return this.request<{
      found: number;
      stale: number;
      cleaned: number;
    }>('POST', '/api/v1/reconcile');
  }
}

/**
 * Default Jelmore configuration for 33GOD.
 */
export const DEFAULT_JELMORE_CONFIG: JelmoreConfig = {
  baseUrl: process.env.JELMORE_URL ?? 'http://localhost:8080',
  apiKey: process.env.JELMORE_API_KEY,
  timeout: 30000,
};
