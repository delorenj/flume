/**
 * Plane Sync Service - Bidirectional sync between Flume tasks and Plane issues
 *
 * Responsibilities:
 * - Create Plane issues when tasks are created
 * - Update Plane issue state when task state changes
 * - Listen for Bloodbank events and sync accordingly
 */

import type { TaskPayload, WorkResult, PlaneClient, PlaneWorkItem } from '@flume/core';
import type { BloodbankEvent, EventPublisher } from '@flume/core';

/**
 * Map Flume task states to Plane state names.
 */
const FLUME_TO_PLANE_STATE: Record<string, string> = {
  draft: 'Backlog',
  open: 'Backlog',
  ready: 'Todo',
  assigned: 'Todo',
  in_progress: 'In Progress',
  blocked: 'In Progress',
  in_review: 'In Progress',
  done: 'Done',
  failed: 'Cancelled',
  cancelled: 'Cancelled',
};

/**
 * Map Plane state groups to Flume task states.
 */
const PLANE_TO_FLUME_STATE: Record<string, string> = {
  backlog: 'open',
  unstarted: 'ready',
  started: 'in_progress',
  completed: 'done',
  cancelled: 'cancelled',
};

/**
 * Task-to-Plane issue mapping.
 */
interface TaskPlaneMapping {
  taskId: string;
  planeProjectId: string;
  planeIssueId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Plane Sync Service configuration.
 */
export interface PlaneSyncConfig {
  defaultProjectIdentifier: string;
  enabled: boolean;
}

/**
 * Default Plane sync configuration.
 */
export const DEFAULT_PLANE_SYNC_CONFIG: PlaneSyncConfig = {
  defaultProjectIdentifier: 'FLUME',
  enabled: true,
};

/**
 * Plane Sync Service.
 */
export class PlaneSyncService {
  private mappings: Map<string, TaskPlaneMapping> = new Map();
  private projectCache: Map<string, string> = new Map(); // identifier -> projectId

  constructor(
    private plane: PlaneClient,
    private eventPublisher?: EventPublisher,
    private config: PlaneSyncConfig = DEFAULT_PLANE_SYNC_CONFIG
  ) {}

  /**
   * Sync a task to Plane (create or update).
   */
  async syncTask(
    task: TaskPayload,
    projectIdentifier?: string
  ): Promise<TaskPlaneMapping> {
    if (!this.config.enabled) {
      throw new Error('Plane sync is disabled');
    }

    const identifier = projectIdentifier ?? this.config.defaultProjectIdentifier;
    const existingMapping = this.mappings.get(task.id);

    if (existingMapping) {
      // Update existing issue
      return this.updatePlaneIssue(task, existingMapping);
    } else {
      // Create new issue
      return this.createPlaneIssue(task, identifier);
    }
  }

  /**
   * Create a new Plane issue for a task.
   */
  private async createPlaneIssue(
    task: TaskPayload,
    projectIdentifier: string
  ): Promise<TaskPlaneMapping> {
    // Get project ID
    let projectId = this.projectCache.get(projectIdentifier);
    if (!projectId) {
      const project = await this.plane.findProjectByIdentifier(projectIdentifier);
      if (!project) {
        throw new Error(`Plane project not found: ${projectIdentifier}`);
      }
      projectId = project.id;
      this.projectCache.set(projectIdentifier, projectId);
    }

    // Create the issue
    const issueId = await this.plane.createTask(projectIdentifier, {
      objective: task.objective,
      context: task.context as Record<string, unknown>,
      priority: task.priority,
      tags: task.tags,
    });

    const mapping: TaskPlaneMapping = {
      taskId: task.id,
      planeProjectId: projectId,
      planeIssueId: issueId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.mappings.set(task.id, mapping);
    console.log(`[PlaneSync] Created issue for task ${task.id}`);

    // Emit sync event
    if (this.eventPublisher) {
      await this.eventPublisher.publish({
        event: 'flume.plane.synced',
        version: '1.0.0',
        data: {
          taskId: task.id,
          planeIssueId: issueId,
          action: 'created',
        },
        exchange: 'amq.topic',
        routingKey: 'flume.plane.synced',
        correlationId: task.correlationId,
        timestamp: new Date().toISOString(),
        source: 'yi.plane-sync',
      });
    }

    return mapping;
  }

  /**
   * Update an existing Plane issue.
   */
  private async updatePlaneIssue(
    task: TaskPayload,
    mapping: TaskPlaneMapping
  ): Promise<TaskPlaneMapping> {
    // Update issue name if objective changed
    await this.plane.updateWorkItem(mapping.planeProjectId, mapping.planeIssueId, {
      name: task.objective,
    });

    mapping.updatedAt = new Date().toISOString();
    console.log(`[PlaneSync] Updated issue for task ${task.id}`);

    return mapping;
  }

  /**
   * Sync task state to Plane.
   */
  async syncTaskState(taskId: string, flumeState: string): Promise<void> {
    const mapping = this.mappings.get(taskId);
    if (!mapping) {
      console.warn(`[PlaneSync] No mapping found for task ${taskId}`);
      return;
    }

    const planeStateName = FLUME_TO_PLANE_STATE[flumeState];
    if (!planeStateName) {
      console.warn(`[PlaneSync] Unknown Flume state: ${flumeState}`);
      return;
    }

    await this.plane.updateTaskState(
      mapping.planeProjectId,
      mapping.planeIssueId,
      planeStateName
    );

    console.log(
      `[PlaneSync] Synced state ${flumeState} -> ${planeStateName} for task ${taskId}`
    );
  }

  /**
   * Mark a task as complete in Plane.
   */
  async syncTaskComplete(taskId: string, result: WorkResult): Promise<void> {
    const mapping = this.mappings.get(taskId);
    if (!mapping) {
      console.warn(`[PlaneSync] No mapping found for task ${taskId}`);
      return;
    }

    try {
      if (result.status === 'success' || result.status === 'delegated') {
        await this.plane.completeTask(mapping.planeProjectId, mapping.planeIssueId);
        console.log(`[PlaneSync] Completed task ${taskId} in Plane`);
      } else if (result.status === 'failure') {
        await this.plane.updateTaskState(
          mapping.planeProjectId,
          mapping.planeIssueId,
          'Cancelled'
        );
        console.log(`[PlaneSync] Marked task ${taskId} as cancelled in Plane`);
      }

      // Add completion comment with result summary
      await this.addResultComment(taskId, result);
    } catch (error) {
      console.error(`[PlaneSync] Error syncing task completion: ${error}`);
    }
  }

  /**
   * Add a comment with WorkResult summary to the issue.
   */
  async addResultComment(taskId: string, result: WorkResult): Promise<void> {
    const mapping = this.mappings.get(taskId);
    if (!mapping) return;

    try {
      const statusEmoji = result.status === 'success' ? '✅' :
                          result.status === 'delegated' ? '📤' : '❌';

      let comment = `<h3>${statusEmoji} Task ${result.status}</h3>`;
      comment += `<p><strong>Completed:</strong> ${result.completedAt}</p>`;

      if (result.metrics?.durationMs) {
        const duration = (result.metrics.durationMs / 1000).toFixed(1);
        comment += `<p><strong>Duration:</strong> ${duration}s</p>`;
      }

      if (result.output) {
        const outputStr = typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output, null, 2);

        if (outputStr.length > 0 && outputStr.length < 1000) {
          comment += `<h4>Output</h4><pre><code>${this.escapeHtml(outputStr)}</code></pre>`;
        } else if (outputStr.length >= 1000) {
          comment += `<p><em>Output truncated (${outputStr.length} chars)</em></p>`;
        }
      }

      if (result.error) {
        const errorText = `${result.error.code}: ${result.error.message}`;
        comment += `<h4>Error</h4><pre><code>${this.escapeHtml(errorText)}</code></pre>`;
      }

      await this.plane.addComment(
        mapping.planeProjectId,
        mapping.planeIssueId,
        comment
      );

      console.log(`[PlaneSync] Added result comment to task ${taskId}`);
    } catch (error) {
      console.error(`[PlaneSync] Error adding comment: ${error}`);
    }
  }

  /**
   * Link a task issue to a parent task issue.
   */
  async linkToParent(
    taskId: string,
    parentTaskId: string
  ): Promise<void> {
    const childMapping = this.mappings.get(taskId);
    const parentMapping = this.mappings.get(parentTaskId);

    if (!childMapping || !parentMapping) {
      console.warn(`[PlaneSync] Cannot link - missing mapping for child or parent`);
      return;
    }

    if (childMapping.planeProjectId !== parentMapping.planeProjectId) {
      console.warn(`[PlaneSync] Cannot link issues across different projects`);
      return;
    }

    try {
      await this.plane.setParentIssue(
        childMapping.planeProjectId,
        childMapping.planeIssueId,
        parentMapping.planeIssueId
      );
      console.log(`[PlaneSync] Linked task ${taskId} to parent ${parentTaskId}`);
    } catch (error) {
      console.error(`[PlaneSync] Error linking issues: ${error}`);
    }
  }

  /**
   * Escape HTML characters for safe embedding.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Handle Bloodbank events and sync to Plane.
   */
  async handleEvent(event: BloodbankEvent): Promise<void> {
    switch (event.event) {
      case 'flume.task.created': {
        const data = event.data as {
          taskId: string;
          objective: string;
          tags?: string[];
        };
        // Create a minimal task payload for sync
        const task: TaskPayload = {
          id: data.taskId,
          correlationId: event.correlationId,
          objective: data.objective,
          context: {},
          tags: data.tags,
          createdAt: event.timestamp,
        };
        await this.syncTask(task);
        break;
      }

      case 'flume.task.state.changed': {
        const data = event.data as {
          taskId: string;
          toState: string;
        };
        await this.syncTaskState(data.taskId, data.toState);
        break;
      }

      case 'flume.task.completed': {
        const data = event.data as {
          taskId: string;
          status: string;
        };
        const result: WorkResult = {
          status: data.status as 'success' | 'failure' | 'delegated',
          output: null,
          metrics: { durationMs: 0 },
          completedAt: event.timestamp,
        };
        await this.syncTaskComplete(data.taskId, result);
        break;
      }

      default:
        // Ignore other events
        break;
    }
  }

  /**
   * Get the Plane mapping for a task.
   */
  getMapping(taskId: string): TaskPlaneMapping | undefined {
    return this.mappings.get(taskId);
  }

  /**
   * Check if a task has been synced to Plane.
   */
  isSynced(taskId: string): boolean {
    return this.mappings.has(taskId);
  }
}
