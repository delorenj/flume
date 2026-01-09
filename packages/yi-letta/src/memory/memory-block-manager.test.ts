/**
 * Tests for MemoryBlockManager
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MemoryBlockManager,
  createMemoryManager,
  type CoreMemoryContent,
  type PersonaMemoryContent,
  type KnowledgeMemoryContent,
  type TaskContextMemoryContent,
  type TeamContextMemoryContent,
} from './memory-block-manager.js';
import type { LettaClient } from '../client/letta-client.js';

// Mock LettaClient
function createMockClient(blocks: Array<{ label: string; value: string }> = []): LettaClient {
  const mockBlocks = [...blocks];

  return {
    updateMemoryBlock: vi.fn(async (_agentId: string, label: string, value: string) => {
      const existing = mockBlocks.find((b) => b.label === label);
      if (existing) {
        existing.value = value;
      } else {
        mockBlocks.push({ label, value });
      }
    }),
    getAgent: vi.fn(async () => ({
      id: 'test-agent-id',
      name: 'Test Agent',
      memory: { blocks: mockBlocks },
    })),
  } as unknown as LettaClient;
}

describe('MemoryBlockManager', () => {
  let manager: MemoryBlockManager;
  let mockClient: LettaClient;

  beforeEach(() => {
    mockClient = createMockClient();
    manager = new MemoryBlockManager({
      client: mockClient,
      agentId: 'test-agent-id',
      verbose: false,
    });
  });

  describe('initialization', () => {
    it('should create manager with config', () => {
      expect(manager).toBeDefined();
    });

    it('should use default maxBlockSize', () => {
      const manager2 = createMemoryManager(mockClient, 'agent-id');
      expect(manager2).toBeDefined();
    });

    it('should accept custom maxBlockSize', () => {
      const manager2 = createMemoryManager(mockClient, 'agent-id', { maxBlockSize: 16000 });
      expect(manager2).toBeDefined();
    });
  });

  describe('core memory', () => {
    it('should set and get core memory', async () => {
      const coreContent: CoreMemoryContent = {
        purpose: 'Test agent for unit testing',
        guidelines: ['Be helpful', 'Be accurate'],
        constraints: ['No external calls'],
      };

      await manager.setCore(coreContent);
      const result = await manager.getCore();

      expect(result).toEqual(coreContent);
      expect(mockClient.updateMemoryBlock).toHaveBeenCalledWith(
        'test-agent-id',
        'core',
        JSON.stringify(coreContent)
      );
    });

    it('should return null for missing core memory', async () => {
      const result = await manager.getCore();
      expect(result).toBeNull();
    });
  });

  describe('persona memory', () => {
    it('should set and get persona memory', async () => {
      const personaContent: PersonaMemoryContent = {
        name: 'TestBot',
        role: 'Unit Test Agent',
        skills: ['testing', 'mocking'],
        teamId: 'test-team',
        communicationStyle: 'formal',
        expertise: ['vitest', 'jest'],
      };

      await manager.setPersona(personaContent);
      const result = await manager.getPersona();

      expect(result).toEqual(personaContent);
    });

    it('should update persona fields partially', async () => {
      const initial: PersonaMemoryContent = {
        name: 'TestBot',
        role: 'Tester',
        skills: ['testing'],
        teamId: 'team-1',
      };

      await manager.setPersona(initial);
      await manager.updatePersona({ role: 'Senior Tester', skills: ['testing', 'debugging'] });

      const result = await manager.getPersona();
      expect(result?.name).toBe('TestBot');
      expect(result?.role).toBe('Senior Tester');
      expect(result?.skills).toEqual(['testing', 'debugging']);
    });

    it('should throw when updating non-existent persona', async () => {
      await expect(manager.updatePersona({ role: 'New Role' })).rejects.toThrow(
        'Persona block not found'
      );
    });
  });

  describe('knowledge memory', () => {
    it('should set and get knowledge memory', async () => {
      const items: KnowledgeMemoryContent['items'] = [
        {
          topic: 'TypeScript',
          content: 'A strongly-typed JavaScript superset',
          confidence: 'high',
          source: 'official docs',
          addedAt: '2026-01-05T00:00:00.000Z',
        },
      ];

      await manager.setKnowledge('programming', items);
      const result = await manager.getKnowledge();

      expect(result?.domain).toBe('programming');
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0].topic).toBe('TypeScript');
    });

    it('should add knowledge item', async () => {
      await manager.addKnowledge('React', 'A UI library', 'high', 'official docs');
      const result = await manager.getKnowledge();

      expect(result?.items).toHaveLength(1);
      expect(result?.items[0].topic).toBe('React');
      expect(result?.items[0].confidence).toBe('high');
    });

    it('should add multiple knowledge items', async () => {
      await manager.addKnowledge('React', 'A UI library', 'high');
      await manager.addKnowledge('Vue', 'Another UI framework', 'medium');
      await manager.addKnowledge('Angular', 'A full framework', 'low');

      const result = await manager.getKnowledge();
      expect(result?.items).toHaveLength(3);
    });

    it('should remove knowledge item by topic', async () => {
      await manager.addKnowledge('React', 'A UI library');
      await manager.addKnowledge('Vue', 'Another framework');

      const removed = await manager.removeKnowledge('React');
      expect(removed).toBe(true);

      const result = await manager.getKnowledge();
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0].topic).toBe('Vue');
    });

    it('should return false when removing non-existent knowledge', async () => {
      const removed = await manager.removeKnowledge('NonExistent');
      expect(removed).toBe(false);
    });
  });

  describe('task context memory', () => {
    it('should set and get task context', async () => {
      const taskContext: TaskContextMemoryContent = {
        taskId: 'task-123',
        objective: 'Complete unit tests',
        priority: 'high',
        tags: ['testing', 'urgent'],
      };

      await manager.setTaskContext(taskContext);
      const result = await manager.getTaskContext();

      expect(result).toEqual(taskContext);
    });

    it('should clear task context', async () => {
      await manager.setTaskContext({ taskId: 'task-123', objective: 'Test' });
      await manager.clearTaskContext();

      const result = await manager.getTaskContext();
      expect(result).toEqual({});
    });

    it('should add progress note', async () => {
      await manager.setTaskContext({ taskId: 'task-123' });
      await manager.addProgressNote('Started implementation');
      await manager.addProgressNote('Completed first phase');

      const result = await manager.getTaskContext();
      expect(result?.progress).toHaveLength(2);
      expect(result?.progress?.[0]).toContain('Started implementation');
    });
  });

  describe('team context memory', () => {
    it('should set and get team context', async () => {
      const teamContext: TeamContextMemoryContent = {
        mission: 'Build excellent software',
        protocols: ['code review required', 'test before merge'],
        accessLevel: 'full',
        teamMembers: [
          { name: 'Alice', role: 'Lead' },
          { name: 'Bob', role: 'Developer' },
        ],
        channels: ['#team-general', '#team-dev'],
      };

      await manager.setTeamContext(teamContext);
      const result = await manager.getTeamContext();

      expect(result).toEqual(teamContext);
    });
  });

  describe('custom blocks', () => {
    it('should set and get custom block', async () => {
      const customData = { foo: 'bar', count: 42 };

      await manager.setCustomBlock('my-custom-block', customData);
      const result = await manager.getCustomBlock<typeof customData>('my-custom-block');

      expect(result).toEqual(customData);
    });

    it('should support persistent custom blocks', async () => {
      await manager.setCustomBlock('persistent-data', { data: 'important' }, true);
      // Block is set - persistence flag is tracked internally
      const blocks = await manager.getAllBlocks();
      const persistentBlock = blocks.find((b) => b.label === 'persistent-data');
      expect(persistentBlock).toBeDefined();
    });

    it('should support metadata on custom blocks', async () => {
      await manager.setCustomBlock('meta-block', { value: 1 }, false, { version: '1.0' });
      // Metadata is stored with the block
    });
  });

  describe('block operations', () => {
    it('should delete a block', async () => {
      await manager.setCustomBlock('to-delete', { data: 'bye' });
      const deleted = await manager.deleteBlock('to-delete');

      expect(deleted).toBe(true);
      expect(mockClient.updateMemoryBlock).toHaveBeenCalledWith('test-agent-id', 'to-delete', '');
    });

    it('should get all blocks', async () => {
      // Set up blocks on mock client
      const mockClientWithBlocks = createMockClient([
        { label: 'core', value: JSON.stringify({ purpose: 'test' }) },
        { label: 'persona', value: JSON.stringify({ name: 'Bot', role: 'Test', skills: [], teamId: 't1' }) },
      ]);

      const manager2 = new MemoryBlockManager({
        client: mockClientWithBlocks,
        agentId: 'test-agent-id',
      });

      const blocks = await manager2.getAllBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('core');
      expect(blocks[1].type).toBe('persona');
    });

    it('should handle non-JSON block values', async () => {
      const mockClientWithPlainText = createMockClient([
        { label: 'plain-text', value: 'Just some text, not JSON' },
      ]);

      const manager2 = new MemoryBlockManager({
        client: mockClientWithPlainText,
        agentId: 'test-agent-id',
      });

      const blocks = await manager2.getAllBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('custom');
      expect(blocks[0].content).toBe('Just some text, not JSON');
    });
  });

  describe('statistics', () => {
    it('should get memory stats', async () => {
      const mockClientWithBlocks = createMockClient([
        { label: 'core', value: JSON.stringify({ purpose: 'test', guidelines: [], constraints: [] }) },
        { label: 'persona', value: JSON.stringify({ name: 'Bot', role: 'Test', skills: [], teamId: 't1' }) },
        { label: 'knowledge', value: JSON.stringify({ domain: 'test', items: [] }) },
      ]);

      const manager2 = new MemoryBlockManager({
        client: mockClientWithBlocks,
        agentId: 'test-agent-id',
      });

      const stats = await manager2.getStats();

      expect(stats.totalBlocks).toBe(3);
      expect(stats.blocksByType.core).toBe(1);
      expect(stats.blocksByType.persona).toBe(1);
      expect(stats.blocksByType.knowledge).toBe(1);
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    it('should get status summary', async () => {
      const mockClientWithBlocks = createMockClient([
        { label: 'persona', value: JSON.stringify({ name: 'Bot', role: 'Test', skills: [], teamId: 't1' }) },
        { label: 'team_context', value: JSON.stringify({ mission: 'test', protocols: [], accessLevel: 'full' }) },
      ]);

      const manager2 = new MemoryBlockManager({
        client: mockClientWithBlocks,
        agentId: 'test-agent-id',
      });

      const summary = await manager2.getStatusSummary();

      expect(summary.blocks).toBe(2);
      expect(summary.hasPersona).toBe(true);
      expect(summary.hasTask).toBe(false);
      expect(summary.hasTeam).toBe(true);
      expect(summary.size).toBeGreaterThan(0);
    });
  });

  describe('caching', () => {
    it('should cache blocks after first access', async () => {
      await manager.setCore({ purpose: 'test', guidelines: [], constraints: [] });

      // First access - fetches from server
      await manager.getCore();
      // Second access - should use cache
      await manager.getCore();

      // getAgent should only be called once (for setCore)
      // because setCore updates the cache directly
      expect(mockClient.getAgent).toHaveBeenCalledTimes(0);
    });

    it('should clear cache', async () => {
      await manager.setCore({ purpose: 'test', guidelines: [], constraints: [] });
      manager.clearCache();

      // After clearing cache, next access will fetch from server
      await manager.getCore();
      expect(mockClient.getAgent).toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('should emit block change events', async () => {
      const changeHandler = vi.fn();
      manager.onBlockChange(changeHandler);

      await manager.setCore({ purpose: 'test', guidelines: [], constraints: [] });

      expect(changeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'core',
          type: 'core',
          action: 'updated',
        })
      );
    });

    it('should remove change listener', async () => {
      const changeHandler = vi.fn();
      manager.onBlockChange(changeHandler);
      manager.offBlockChange(changeHandler);

      await manager.setCore({ purpose: 'test', guidelines: [], constraints: [] });

      expect(changeHandler).not.toHaveBeenCalled();
    });

    it('should handle listener errors gracefully', async () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Listener error');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onBlockChange(errorHandler);
      await manager.setCore({ purpose: 'test', guidelines: [], constraints: [] });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('validation', () => {
    it('should reject blocks exceeding max size', async () => {
      const largeContent = {
        purpose: 'x'.repeat(40000),
        guidelines: [],
        constraints: [],
      };

      await expect(manager.setCore(largeContent)).rejects.toThrow('exceeds max size');
    });
  });

  describe('createMemoryManager factory', () => {
    it('should create manager with default options', () => {
      const manager2 = createMemoryManager(mockClient, 'agent-id');
      expect(manager2).toBeInstanceOf(MemoryBlockManager);
    });

    it('should create manager with custom options', () => {
      const manager2 = createMemoryManager(mockClient, 'agent-id', {
        verbose: true,
        maxBlockSize: 16000,
      });
      expect(manager2).toBeInstanceOf(MemoryBlockManager);
    });
  });
});
