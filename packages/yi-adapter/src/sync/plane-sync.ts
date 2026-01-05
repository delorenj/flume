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
