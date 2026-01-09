/**
 * Plane API Client - Typed client for Plane.so project management
 *
 * Syncs tasks between Flume and Plane for visibility and tracking.
 * Uses the public Plane API v1.
 *
 * @category Plane
 */

/**
 * Plane configuration.
 */
export interface PlaneConfig {
  baseUrl: string;       // https://plane.delo.sh
  apiKey: string;        // plane_api_xxx
  workspaceSlug: string; // 33god
}

/**
 * Default Plane configuration for 33GOD.
 */
export const DEFAULT_PLANE_CONFIG: PlaneConfig = {
  baseUrl: process.env.PLANE_URL ?? 'https://plane.delo.sh',
  apiKey: process.env.PLANE_API_KEY ?? '',
  workspaceSlug: process.env.PLANE_WORKSPACE ?? '33god',
};

/**
 * Plane project representation.
 */
export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Plane work item (issue) representation.
 */
export interface PlaneWorkItem {
  id: string;
  name: string;
  description: string | null;
  description_html: string | null;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none' | null;
  state: string;  // State ID
  assignees: string[];
  labels: string[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  sequence_id: number;
  project: string;
}

/**
 * Plane state representation.
 */
export interface PlaneState {
  id: string;
  name: string;
  color: string;
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  default: boolean;
  sequence: number;
}

/**
 * Create work item request.
 */
export interface CreateWorkItemRequest {
  name: string;
  description?: string;
  description_html?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  state?: string;
  assignees?: string[];
  labels?: string[];
}

/**
 * Update work item request.
 */
export interface UpdateWorkItemRequest {
  name?: string;
  description?: string;
  description_html?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  state?: string;
  assignees?: string[];
  labels?: string[];
  parent?: string | null; // Parent issue ID for sub-issues
}

/**
 * Plane comment representation.
 */
export interface PlaneComment {
  id: string;
  comment_html: string;
  actor: string;
  created_at: string;
  updated_at: string;
}

/**
 * Create comment request.
 */
export interface CreateCommentRequest {
  comment_html: string;
}

/**
 * Issue link type.
 */
export type IssueLinkType = 'relates_to' | 'blocks' | 'blocked_by' | 'duplicate';

/**
 * Plane issue link representation.
 */
export interface PlaneIssueLink {
  id: string;
  issue: string;
  related_issue: string;
  relation_type: IssueLinkType;
  created_at: string;
}

/**
 * Paginated response from Plane API.
 */
export interface PlaneListResponse<T> {
  results: T[];
  total_count: number;
  count: number;
  total_pages: number;
  next_cursor: string | null;
  prev_cursor: string | null;
  next_page_results: boolean;
  prev_page_results: boolean;
}

/**
 * Plane API Client.
 */
export class PlaneClient {
  private baseUrl: string;
  private apiKey: string;
  private workspaceSlug: string;

  constructor(config: PlaneConfig = DEFAULT_PLANE_CONFIG) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.workspaceSlug = config.workspaceSlug;

    if (!this.apiKey) {
      console.warn('[Plane] No API key configured - API calls will fail');
    }
  }

  /**
   * Make an authenticated request to the Plane API.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Plane API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // ============================================================================
  // Projects
  // ============================================================================

  /**
   * List all projects in the workspace.
   */
  async listProjects(): Promise<PlaneProject[]> {
    const response = await this.request<PlaneListResponse<PlaneProject>>(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/`
    );
    return response.results;
  }

  /**
   * Get a project by ID.
   */
  async getProject(projectId: string): Promise<PlaneProject> {
    return this.request<PlaneProject>(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/`
    );
  }

  /**
   * Find a project by identifier (e.g., "FLUME", "YI").
   */
  async findProjectByIdentifier(identifier: string): Promise<PlaneProject | null> {
    const projects = await this.listProjects();
    return projects.find(p => p.identifier === identifier) ?? null;
  }

  // ============================================================================
  // States
  // ============================================================================

  /**
   * List all states for a project.
   */
  async listStates(projectId: string): Promise<PlaneState[]> {
    const response = await this.request<PlaneListResponse<PlaneState>>(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/states/`
    );
    return response.results;
  }

  /**
   * Find a state by name or group.
   */
  async findState(
    projectId: string,
    criteria: { name?: string; group?: PlaneState['group'] }
  ): Promise<PlaneState | null> {
    const states = await this.listStates(projectId);

    if (criteria.name) {
      return states.find(s => s.name.toLowerCase() === criteria.name!.toLowerCase()) ?? null;
    }

    if (criteria.group) {
      return states.find(s => s.group === criteria.group) ?? null;
    }

    return null;
  }

  // ============================================================================
  // Work Items (Issues)
  // ============================================================================

  /**
   * List issues in a project.
   * Note: Plane renamed "work-items" to "issues" in the API.
   */
  async listWorkItems(
    projectId: string,
    filters?: { state?: string; assignee?: string }
  ): Promise<PlaneWorkItem[]> {
    let path = `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/`;

    const params = new URLSearchParams();
    if (filters?.state) params.set('state', filters.state);
    if (filters?.assignee) params.set('assignees', filters.assignee);

    if (params.toString()) {
      path += `?${params.toString()}`;
    }

    const response = await this.request<PlaneListResponse<PlaneWorkItem>>(
      'GET',
      path
    );
    return response.results;
  }

  /**
   * Get an issue by ID.
   */
  async getWorkItem(projectId: string, workItemId: string): Promise<PlaneWorkItem> {
    return this.request<PlaneWorkItem>(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${workItemId}/`
    );
  }

  /**
   * Create a new issue.
   */
  async createWorkItem(
    projectId: string,
    data: CreateWorkItemRequest
  ): Promise<PlaneWorkItem> {
    return this.request<PlaneWorkItem>(
      'POST',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/`,
      data
    );
  }

  /**
   * Update an issue.
   */
  async updateWorkItem(
    projectId: string,
    workItemId: string,
    data: UpdateWorkItemRequest
  ): Promise<PlaneWorkItem> {
    return this.request<PlaneWorkItem>(
      'PATCH',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${workItemId}/`,
      data
    );
  }

  /**
   * Delete an issue.
   */
  async deleteWorkItem(projectId: string, workItemId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${workItemId}/`
    );
  }

  // ============================================================================
  // Comments
  // ============================================================================

  /**
   * List comments on an issue.
   */
  async listComments(projectId: string, issueId: string): Promise<PlaneComment[]> {
    const response = await this.request<PlaneListResponse<PlaneComment>>(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`
    );
    return response.results;
  }

  /**
   * Add a comment to an issue.
   */
  async addComment(
    projectId: string,
    issueId: string,
    comment: string
  ): Promise<PlaneComment> {
    return this.request<PlaneComment>(
      'POST',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}/comments/`,
      { comment_html: comment }
    );
  }

  // ============================================================================
  // Issue Links
  // ============================================================================

  /**
   * Link two issues together.
   */
  async linkIssues(
    projectId: string,
    issueId: string,
    relatedIssueId: string,
    linkType: IssueLinkType = 'relates_to'
  ): Promise<PlaneIssueLink> {
    return this.request<PlaneIssueLink>(
      'POST',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}/issue-links/`,
      {
        related_issue: relatedIssueId,
        relation_type: linkType,
      }
    );
  }

  /**
   * Set parent issue (make issueId a sub-issue of parentId).
   */
  async setParentIssue(
    projectId: string,
    issueId: string,
    parentId: string | null
  ): Promise<PlaneWorkItem> {
    return this.updateWorkItem(projectId, issueId, { parent: parentId });
  }

  // ============================================================================
  // Convenience Methods for Flume Integration
  // ============================================================================

  /**
   * Create a task in Plane and return the Plane issue ID.
   */
  async createTask(
    projectIdentifier: string,
    task: {
      objective: string;
      context?: Record<string, unknown>;
      priority?: number;
      tags?: string[];
    }
  ): Promise<string> {
    const project = await this.findProjectByIdentifier(projectIdentifier);
    if (!project) {
      throw new Error(`Project not found: ${projectIdentifier}`);
    }

    // Map Flume priority (0-4) to Plane priority
    const priorityMap: Record<number, CreateWorkItemRequest['priority']> = {
      0: 'none',
      1: 'low',
      2: 'medium',
      3: 'high',
      4: 'urgent',
    };

    const workItem = await this.createWorkItem(project.id, {
      name: task.objective,
      description: task.context
        ? `Context:\n\`\`\`json\n${JSON.stringify(task.context, null, 2)}\n\`\`\``
        : undefined,
      priority: priorityMap[task.priority ?? 0],
    });

    console.log(`[Plane] Created work item: ${projectIdentifier}-${workItem.sequence_id}`);
    return workItem.id;
  }

  /**
   * Update task state in Plane.
   */
  async updateTaskState(
    projectId: string,
    workItemId: string,
    stateName: string
  ): Promise<void> {
    const state = await this.findState(projectId, { name: stateName });
    if (!state) {
      console.warn(`[Plane] State not found: ${stateName}`);
      return;
    }

    await this.updateWorkItem(projectId, workItemId, { state: state.id });
    console.log(`[Plane] Updated work item ${workItemId} to state: ${stateName}`);
  }

  /**
   * Mark a task as complete in Plane.
   */
  async completeTask(projectId: string, workItemId: string): Promise<void> {
    const state = await this.findState(projectId, { group: 'completed' });
    if (!state) {
      console.warn('[Plane] No completed state found');
      return;
    }

    await this.updateWorkItem(projectId, workItemId, { state: state.id });
    console.log(`[Plane] Completed work item: ${workItemId}`);
  }
}
