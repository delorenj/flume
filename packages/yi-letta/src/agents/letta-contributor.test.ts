/**
 * Tests for LettaContributor persistence methods.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LettaContributor, type LettaAgentState } from './letta-contributor.js';
import type { LettaClient, LettaAgent, LettaResponse } from '../client/letta-client.js';

describe('LettaContributor', () => {
  let contributor: LettaContributor;
  let mockClient: {
    createAgent: ReturnType<typeof vi.fn>;
    getAgent: ReturnType<typeof vi.fn>;
    deleteAgent: ReturnType<typeof vi.fn>;
    updateMemoryBlock: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };

  const mockAgent: LettaAgent = {
    id: 'letta-agent-123',
    name: 'yi-test-id',
    description: 'Yi Contributor: Test Worker (Test Role)',
    createdAt: '2026-01-05T12:00:00Z',
    agentType: 'conversational',
    llmConfig: {},
    embeddingConfig: {},
    memory: {
      blocks: [
        { label: 'persona', value: '{"name":"Test Worker"}' },
        { label: 'task_context', value: 'No active task.' },
      ],
    },
  };

  beforeEach(() => {
    mockClient = {
      createAgent: vi.fn().mockResolvedValue(mockAgent),
      getAgent: vi.fn().mockResolvedValue(mockAgent),
      deleteAgent: vi.fn().mockResolvedValue(undefined),
      updateMemoryBlock: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({
        messages: [{ id: '1', role: 'assistant', text: 'Done.', createdAt: '2026-01-05T12:00:00Z' }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      } as LettaResponse),
    };

    contributor = new LettaContributor(mockClient as unknown as LettaClient, {
      id: 'test-id',
      name: 'Test Worker',
      role: 'Test Role',
      teamId: 'test-team',
      skills: ['testing'],
      salary: 50000,
      systemPrompt: 'You are a test agent.',
      tools: ['tool1', 'tool2'],
    });
  });

  describe('initialize', () => {
    it('should create a Letta agent on the server', async () => {
      await contributor.initialize();

      expect(mockClient.createAgent).toHaveBeenCalledWith({
        name: 'yi-test-id',
        description: 'Yi Contributor: Test Worker (Test Role)',
        system: 'You are a test agent.',
        tools: ['tool1', 'tool2'],
        memoryBlocks: [
          { label: 'persona', value: expect.any(String) },
          { label: 'task_context', value: 'No active task.' },
        ],
      });
      expect(contributor.getLettaAgentId()).toBe('letta-agent-123');
    });

    it('should not recreate agent if already initialized', async () => {
      await contributor.initialize();
      await contributor.initialize();

      expect(mockClient.createAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe('exportState', () => {
    it('should export agent state with memory blocks', async () => {
      await contributor.initialize();
      const state = await contributor.exportState();

      expect(state.yiId).toBe('test-id');
      expect(state.lettaAgentId).toBe('letta-agent-123');
      expect(state.config.name).toBe('Test Worker');
      expect(state.config.role).toBe('Test Role');
      expect(state.config.teamId).toBe('test-team');
      expect(state.config.skills).toEqual(['testing']);
      expect(state.config.salary).toBe(50000);
      expect(state.config.systemPrompt).toBe('You are a test agent.');
      expect(state.config.tools).toEqual(['tool1', 'tool2']);
      expect(state.memoryBlocks).toHaveLength(2);
      expect(state.memoryBlocks[0].label).toBe('persona');
      expect(state.metadata.version).toBe('1.0.0');
    });

    it('should throw if agent not initialized', async () => {
      await expect(contributor.exportState()).rejects.toThrow(
        'Cannot export state: Letta agent not initialized'
      );
    });

    it('should throw if agent not found on server', async () => {
      await contributor.initialize();
      mockClient.getAgent.mockResolvedValueOnce(null);

      await expect(contributor.exportState()).rejects.toThrow(
        'Letta agent not found: letta-agent-123'
      );
    });
  });

  describe('importState', () => {
    it('should update local config from state', () => {
      const state: LettaAgentState = {
        yiId: 'other-id',
        lettaAgentId: 'other-letta-id',
        config: {
          name: 'Other Worker',
          role: 'Other Role',
          teamId: 'other-team',
          skills: ['other-skill'],
          salary: 100000,
          systemPrompt: 'Different prompt.',
          tools: ['new-tool'],
        },
        memoryBlocks: [],
        metadata: {
          exportedAt: '2026-01-05T12:00:00Z',
          version: '1.0.0',
        },
      };

      contributor.importState(state);

      // Note: importState only updates systemPrompt and tools (mutable fields)
      // ID and other BaseContributor fields are set at construction time
    });
  });

  describe('restoreFromState', () => {
    const savedState: LettaAgentState = {
      yiId: 'test-id',
      lettaAgentId: 'letta-agent-123',
      config: {
        name: 'Test Worker',
        role: 'Test Role',
        teamId: 'test-team',
        skills: ['testing'],
        salary: 50000,
        systemPrompt: 'You are a test agent.',
        tools: ['tool1', 'tool2'],
      },
      memoryBlocks: [
        { label: 'persona', value: '{"name":"Test Worker"}' },
        { label: 'task_context', value: 'Working on task X.' },
      ],
      metadata: {
        exportedAt: '2026-01-05T12:00:00Z',
        version: '1.0.0',
      },
    };

    it('should reconnect to existing Letta agent', async () => {
      await contributor.restoreFromState(savedState);

      expect(mockClient.getAgent).toHaveBeenCalledWith('letta-agent-123');
      expect(contributor.getLettaAgentId()).toBe('letta-agent-123');
      // Should update memory blocks to match saved state
      expect(mockClient.updateMemoryBlock).toHaveBeenCalledWith(
        'letta-agent-123',
        'persona',
        '{"name":"Test Worker"}'
      );
      expect(mockClient.updateMemoryBlock).toHaveBeenCalledWith(
        'letta-agent-123',
        'task_context',
        'Working on task X.'
      );
    });

    it('should create new agent if original is gone', async () => {
      mockClient.getAgent.mockResolvedValueOnce(null);
      const newAgent = { ...mockAgent, id: 'new-letta-agent-456' };
      mockClient.createAgent.mockResolvedValueOnce(newAgent);

      await contributor.restoreFromState(savedState);

      expect(mockClient.createAgent).toHaveBeenCalledWith({
        name: 'yi-test-id',
        description: 'Yi Contributor: Test Worker (Test Role) [restored]',
        system: 'You are a test agent.',
        tools: ['tool1', 'tool2'],
        memoryBlocks: savedState.memoryBlocks,
      });
      expect(contributor.getLettaAgentId()).toBe('new-letta-agent-456');
    });

    it('should handle memory block update failures gracefully', async () => {
      mockClient.updateMemoryBlock.mockRejectedValueOnce(new Error('Update failed'));

      // Should not throw - just logs warning
      await contributor.restoreFromState(savedState);

      expect(contributor.getLettaAgentId()).toBe('letta-agent-123');
    });
  });

  describe('isAgentAlive', () => {
    it('should return true if agent exists', async () => {
      await contributor.initialize();
      const isAlive = await contributor.isAgentAlive();
      expect(isAlive).toBe(true);
    });

    it('should return false if agent not found', async () => {
      await contributor.initialize();
      mockClient.getAgent.mockResolvedValueOnce(null);
      const isAlive = await contributor.isAgentAlive();
      expect(isAlive).toBe(false);
    });

    it('should return false if not initialized', async () => {
      const isAlive = await contributor.isAgentAlive();
      expect(isAlive).toBe(false);
    });
  });

  describe('syncMemory', () => {
    it('should sync memory blocks to server', async () => {
      await contributor.initialize();
      const blocks = [
        { label: 'persona', value: '{"updated":"data"}' },
        { label: 'custom', value: 'custom value' },
      ];

      await contributor.syncMemory(blocks);

      expect(mockClient.updateMemoryBlock).toHaveBeenCalledWith(
        'letta-agent-123',
        'persona',
        '{"updated":"data"}'
      );
      expect(mockClient.updateMemoryBlock).toHaveBeenCalledWith(
        'letta-agent-123',
        'custom',
        'custom value'
      );
    });

    it('should throw if not initialized', async () => {
      await expect(
        contributor.syncMemory([{ label: 'test', value: 'value' }])
      ).rejects.toThrow('Cannot sync: Letta agent not initialized');
    });
  });

  describe('getMemoryBlocks', () => {
    it('should retrieve memory blocks from server', async () => {
      await contributor.initialize();
      const blocks = await contributor.getMemoryBlocks();

      expect(blocks).toHaveLength(2);
      expect(blocks[0].label).toBe('persona');
      expect(blocks[1].label).toBe('task_context');
    });

    it('should throw if not initialized', async () => {
      await expect(contributor.getMemoryBlocks()).rejects.toThrow(
        'Cannot get memory: Letta agent not initialized'
      );
    });

    it('should throw if agent not found', async () => {
      await contributor.initialize();
      mockClient.getAgent.mockResolvedValueOnce(null);

      await expect(contributor.getMemoryBlocks()).rejects.toThrow(
        'Letta agent not found: letta-agent-123'
      );
    });
  });

  describe('terminate', () => {
    it('should delete Letta agent', async () => {
      await contributor.initialize();
      await contributor.terminate();

      expect(mockClient.deleteAgent).toHaveBeenCalledWith('letta-agent-123');
      expect(contributor.getLettaAgentId()).toBeNull();
    });

    it('should handle deletion failures gracefully', async () => {
      await contributor.initialize();
      mockClient.deleteAgent.mockRejectedValueOnce(new Error('Delete failed'));

      // Should not throw - just logs warning
      await contributor.terminate();

      expect(contributor.getLettaAgentId()).toBeNull();
    });

    it('should do nothing if not initialized', async () => {
      await contributor.terminate();
      expect(mockClient.deleteAgent).not.toHaveBeenCalled();
    });
  });
});
