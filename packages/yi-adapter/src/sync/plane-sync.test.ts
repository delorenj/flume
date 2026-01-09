/**
 * Unit tests for PlaneSyncService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaneSyncService, DEFAULT_PLANE_SYNC_CONFIG } from './plane-sync.js';
import type { TaskPayload, WorkResult, PlaneClient, PlaneWorkItem } from '@flume/core';
import type { BloodbankEvent, EventPublisher } from '@flume/core';

/**
 * Mock PlaneClient for testing.
 */
function createMockPlaneClient(): PlaneClient {
  return {
    findProjectByIdentifier: vi.fn().mockResolvedValue({
      id: 'project-123',
      name: 'FLUME',
      identifier: 'FLUME',
      description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }),
    createTask: vi.fn().mockResolvedValue('issue-456'),
    updateWorkItem: vi.fn().mockResolvedValue({
      id: 'issue-456',
      name: 'Test Task',
      description: null,
      description_html: null,
      priority: 'medium',
      state: 'state-789',
      assignees: [],
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      sequence_id: 1,
      project: 'project-123',
    } as PlaneWorkItem),
    updateTaskState: vi.fn().mockResolvedValue(undefined),
    completeTask: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({
      id: 'comment-101',
      comment_html: '<p>Test comment</p>',
      actor: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }),
    setParentIssue: vi.fn().mockResolvedValue({
      id: 'issue-456',
      name: 'Test Task',
      description: null,
      description_html: null,
      priority: 'medium',
      state: 'state-789',
      assignees: [],
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      sequence_id: 1,
      project: 'project-123',
    } as PlaneWorkItem),
  } as unknown as PlaneClient;
}

/**
 * Create a mock task payload for testing.
 */
function createMockTask(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: 'task-001',
    correlationId: 'corr-123',
    objective: 'Test objective',
    context: { key: 'value' },
    tags: ['test', 'unit'],
    priority: 2,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as TaskPayload;
}

/**
 * Create a mock event publisher for testing.
 */
function createMockEventPublisher(): EventPublisher {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
  } as unknown as EventPublisher;
}

describe('DEFAULT_PLANE_SYNC_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_PLANE_SYNC_CONFIG.defaultProjectIdentifier).toBe('FLUME');
    expect(DEFAULT_PLANE_SYNC_CONFIG.enabled).toBe(true);
  });
});

describe('PlaneSyncService', () => {
  let service: PlaneSyncService;
  let mockPlane: PlaneClient;
  let mockPublisher: EventPublisher;

  beforeEach(() => {
    mockPlane = createMockPlaneClient();
    mockPublisher = createMockEventPublisher();
    service = new PlaneSyncService(mockPlane, mockPublisher);
  });

  describe('syncTask', () => {
    it('should create a new Plane issue for a task', async () => {
      const task = createMockTask();
      const mapping = await service.syncTask(task);

      expect(mapping.taskId).toBe('task-001');
      expect(mapping.planeIssueId).toBe('issue-456');
      expect(mapping.planeProjectId).toBe('project-123');
      expect(mockPlane.createTask).toHaveBeenCalledWith('FLUME', expect.objectContaining({
        objective: 'Test objective',
        priority: 2,
        tags: ['test', 'unit'],
      }));
    });

    it('should update existing Plane issue if already synced', async () => {
      const task = createMockTask();

      // First sync creates the issue
      await service.syncTask(task);

      // Second sync updates the issue
      const updatedTask = createMockTask({ objective: 'Updated objective' });
      const mapping = await service.syncTask(updatedTask);

      expect(mapping.taskId).toBe('task-001');
      expect(mockPlane.updateWorkItem).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        { name: 'Updated objective' }
      );
    });

    it('should use custom project identifier', async () => {
      const task = createMockTask();
      await service.syncTask(task, 'CUSTOM');

      expect(mockPlane.findProjectByIdentifier).toHaveBeenCalledWith('CUSTOM');
    });

    it('should throw error when sync is disabled', async () => {
      const disabledService = new PlaneSyncService(mockPlane, mockPublisher, {
        ...DEFAULT_PLANE_SYNC_CONFIG,
        enabled: false,
      });

      await expect(disabledService.syncTask(createMockTask())).rejects.toThrow(
        'Plane sync is disabled'
      );
    });

    it('should throw error when project not found', async () => {
      (mockPlane.findProjectByIdentifier as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      await expect(service.syncTask(createMockTask())).rejects.toThrow(
        'Plane project not found: FLUME'
      );
    });

    it('should publish sync event when issue created', async () => {
      const task = createMockTask();
      await service.syncTask(task);

      expect(mockPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
        event: 'flume.plane.synced',
        data: expect.objectContaining({
          taskId: 'task-001',
          planeIssueId: 'issue-456',
          action: 'created',
        }),
      }));
    });
  });

  describe('syncTaskState', () => {
    it('should sync state change to Plane', async () => {
      // First sync task to create mapping
      await service.syncTask(createMockTask());

      // Then sync state
      await service.syncTaskState('task-001', 'in_progress');

      expect(mockPlane.updateTaskState).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        'In Progress'
      );
    });

    it('should handle unknown Flume state gracefully', async () => {
      await service.syncTask(createMockTask());

      // Should not throw, just log warning
      await service.syncTaskState('task-001', 'unknown_state');

      expect(mockPlane.updateTaskState).not.toHaveBeenCalled();
    });

    it('should handle missing mapping gracefully', async () => {
      // Don't sync task first - no mapping exists
      await service.syncTaskState('nonexistent', 'in_progress');

      expect(mockPlane.updateTaskState).not.toHaveBeenCalled();
    });
  });

  describe('syncTaskComplete', () => {
    beforeEach(async () => {
      // Create mapping first
      await service.syncTask(createMockTask());
    });

    it('should complete task on success', async () => {
      const result: WorkResult = {
        status: 'success',
        output: 'Task completed successfully',
        metrics: { durationMs: 1000 },
        completedAt: '2026-01-01T12:00:00Z',
      };

      await service.syncTaskComplete('task-001', result);

      expect(mockPlane.completeTask).toHaveBeenCalledWith('project-123', 'issue-456');
      expect(mockPlane.addComment).toHaveBeenCalled();
    });

    it('should complete task on delegated status', async () => {
      const result: WorkResult = {
        status: 'delegated',
        output: null,
        metrics: { durationMs: 500 },
        completedAt: '2026-01-01T12:00:00Z',
        delegatedTo: 'other-agent',
      };

      await service.syncTaskComplete('task-001', result);

      expect(mockPlane.completeTask).toHaveBeenCalledWith('project-123', 'issue-456');
    });

    it('should cancel task on failure', async () => {
      const result: WorkResult = {
        status: 'failure',
        output: null,
        metrics: { durationMs: 100 },
        completedAt: '2026-01-01T12:00:00Z',
        error: {
          code: 'EXEC_ERROR',
          message: 'Something went wrong',
          retryable: false,
        },
      };

      await service.syncTaskComplete('task-001', result);

      expect(mockPlane.updateTaskState).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        'Cancelled'
      );
    });

    it('should handle missing mapping gracefully', async () => {
      const result: WorkResult = {
        status: 'success',
        output: null,
        metrics: { durationMs: 1000 },
        completedAt: '2026-01-01T12:00:00Z',
      };

      // Don't throw, just log warning
      await service.syncTaskComplete('nonexistent', result);

      expect(mockPlane.completeTask).not.toHaveBeenCalled();
    });
  });

  describe('addResultComment', () => {
    beforeEach(async () => {
      await service.syncTask(createMockTask());
    });

    it('should add comment with success status', async () => {
      const result: WorkResult = {
        status: 'success',
        output: 'Task output',
        metrics: { durationMs: 1500 },
        completedAt: '2026-01-01T12:00:00Z',
      };

      await service.addResultComment('task-001', result);

      expect(mockPlane.addComment).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        expect.stringContaining('✅')
      );
      expect(mockPlane.addComment).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        expect.stringContaining('1.5s')
      );
    });

    it('should add comment with error details', async () => {
      const result: WorkResult = {
        status: 'failure',
        output: null,
        metrics: { durationMs: 100 },
        completedAt: '2026-01-01T12:00:00Z',
        error: {
          code: 'TIMEOUT',
          message: 'Request timed out',
          retryable: true,
        },
      };

      await service.addResultComment('task-001', result);

      expect(mockPlane.addComment).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        expect.stringContaining('❌')
      );
      expect(mockPlane.addComment).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        expect.stringContaining('TIMEOUT: Request timed out')
      );
    });

    it('should truncate long output', async () => {
      const longOutput = 'x'.repeat(1500);
      const result: WorkResult = {
        status: 'success',
        output: longOutput,
        metrics: { durationMs: 1000 },
        completedAt: '2026-01-01T12:00:00Z',
      };

      await service.addResultComment('task-001', result);

      expect(mockPlane.addComment).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        expect.stringContaining('Output truncated')
      );
    });

    it('should handle missing mapping gracefully', async () => {
      const result: WorkResult = {
        status: 'success',
        output: null,
        metrics: { durationMs: 1000 },
        completedAt: '2026-01-01T12:00:00Z',
      };

      // Should not throw
      await service.addResultComment('nonexistent', result);

      expect(mockPlane.addComment).not.toHaveBeenCalled();
    });

    it('should escape HTML in output', async () => {
      const result: WorkResult = {
        status: 'success',
        output: '<script>alert("xss")</script>',
        metrics: { durationMs: 1000 },
        completedAt: '2026-01-01T12:00:00Z',
      };

      await service.addResultComment('task-001', result);

      expect(mockPlane.addComment).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        expect.stringContaining('&lt;script&gt;')
      );
    });
  });

  describe('linkToParent', () => {
    it('should link child issue to parent issue', async () => {
      // Create both parent and child tasks
      const parentTask = createMockTask({ id: 'parent-task' });
      const childTask = createMockTask({ id: 'child-task' });

      await service.syncTask(parentTask);

      // Need to mock createTask to return different ID for child
      (mockPlane.createTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce('child-issue-789');
      await service.syncTask(childTask);

      await service.linkToParent('child-task', 'parent-task');

      expect(mockPlane.setParentIssue).toHaveBeenCalledWith(
        'project-123',
        'child-issue-789',
        'issue-456'
      );
    });

    it('should handle missing child mapping', async () => {
      const parentTask = createMockTask({ id: 'parent-task' });
      await service.syncTask(parentTask);

      // Should not throw
      await service.linkToParent('nonexistent', 'parent-task');

      expect(mockPlane.setParentIssue).not.toHaveBeenCalled();
    });

    it('should handle missing parent mapping', async () => {
      const childTask = createMockTask({ id: 'child-task' });
      await service.syncTask(childTask);

      // Should not throw
      await service.linkToParent('child-task', 'nonexistent');

      expect(mockPlane.setParentIssue).not.toHaveBeenCalled();
    });

    it('should prevent cross-project linking', async () => {
      // Create first task in FLUME project
      const task1 = createMockTask({ id: 'task-1' });
      await service.syncTask(task1);

      // Mock to return different project for second task
      (mockPlane.findProjectByIdentifier as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'project-other',
        name: 'OTHER',
        identifier: 'OTHER',
        description: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
      (mockPlane.createTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce('issue-other');

      const task2 = createMockTask({ id: 'task-2' });
      await service.syncTask(task2, 'OTHER');

      // Should not link across projects
      await service.linkToParent('task-2', 'task-1');

      expect(mockPlane.setParentIssue).not.toHaveBeenCalled();
    });
  });

  describe('handleEvent', () => {
    it('should handle task created event', async () => {
      const event: BloodbankEvent = {
        event: 'flume.task.created',
        version: '1.0.0',
        data: {
          taskId: 'task-from-event',
          objective: 'Event task objective',
          tags: ['event'],
        },
        exchange: 'amq.topic',
        routingKey: 'flume.task.created',
        correlationId: 'corr-event',
        timestamp: '2026-01-01T12:00:00Z',
        source: 'flume.core',
      };

      await service.handleEvent(event);

      expect(mockPlane.createTask).toHaveBeenCalledWith('FLUME', expect.objectContaining({
        objective: 'Event task objective',
        tags: ['event'],
      }));
    });

    it('should handle task state changed event', async () => {
      // First create the task
      await service.syncTask(createMockTask());

      const event: BloodbankEvent = {
        event: 'flume.task.state.changed',
        version: '1.0.0',
        data: {
          taskId: 'task-001',
          toState: 'in_progress',
        },
        exchange: 'amq.topic',
        routingKey: 'flume.task.state.changed',
        correlationId: 'corr-state',
        timestamp: '2026-01-01T12:00:00Z',
        source: 'flume.core',
      };

      await service.handleEvent(event);

      expect(mockPlane.updateTaskState).toHaveBeenCalledWith(
        'project-123',
        'issue-456',
        'In Progress'
      );
    });

    it('should handle task completed event', async () => {
      // First create the task
      await service.syncTask(createMockTask());

      const event: BloodbankEvent = {
        event: 'flume.task.completed',
        version: '1.0.0',
        data: {
          taskId: 'task-001',
          status: 'success',
        },
        exchange: 'amq.topic',
        routingKey: 'flume.task.completed',
        correlationId: 'corr-complete',
        timestamp: '2026-01-01T12:00:00Z',
        source: 'flume.core',
      };

      await service.handleEvent(event);

      expect(mockPlane.completeTask).toHaveBeenCalledWith('project-123', 'issue-456');
    });

    it('should ignore unknown events', async () => {
      const event: BloodbankEvent = {
        event: 'unknown.event',
        version: '1.0.0',
        data: {},
        exchange: 'amq.topic',
        routingKey: 'unknown.event',
        correlationId: 'corr-unknown',
        timestamp: '2026-01-01T12:00:00Z',
        source: 'unknown',
      };

      // Should not throw
      await service.handleEvent(event);

      expect(mockPlane.createTask).not.toHaveBeenCalled();
    });
  });

  describe('getMapping', () => {
    it('should return mapping for synced task', async () => {
      await service.syncTask(createMockTask());

      const mapping = service.getMapping('task-001');

      expect(mapping).toBeDefined();
      expect(mapping?.taskId).toBe('task-001');
      expect(mapping?.planeIssueId).toBe('issue-456');
    });

    it('should return undefined for unsynced task', () => {
      const mapping = service.getMapping('nonexistent');

      expect(mapping).toBeUndefined();
    });
  });

  describe('isSynced', () => {
    it('should return true for synced task', async () => {
      await service.syncTask(createMockTask());

      expect(service.isSynced('task-001')).toBe(true);
    });

    it('should return false for unsynced task', () => {
      expect(service.isSynced('nonexistent')).toBe(false);
    });
  });
});
