/**
 * Integration Tests for yi-letta
 *
 * These tests verify the Letta-backed agents:
 * - Agent creation and lifecycle
 * - Memory block management
 * - State persistence and restoration
 *
 * Note: These tests require a running Letta server.
 * Set LETTA_BASE_URL environment variable to point to your server.
 * They are skipped in CI unless Letta server is available.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  LettaClient,
  LettaContributor,
  LettaManager,
  LettaDirector,
  LettaFactory,
  DEFAULT_LETTA_CONFIG,
} from '@yi/letta';
import type { TaskPayload } from '@flume/core';

// Check if Letta server is available
const LETTA_URL = process.env.LETTA_BASE_URL ?? DEFAULT_LETTA_CONFIG.baseUrl;
let lettaAvailable = false;

beforeAll(async () => {
  try {
    const client = new LettaClient({ baseUrl: LETTA_URL });
    lettaAvailable = await client.health();
  } catch {
    lettaAvailable = false;
  }
});

const describeWithLetta = () => (lettaAvailable ? describe : describe.skip);

describe('Yi Letta Integration', () => {
  describeWithLetta()('LettaContributor Lifecycle', () => {
    let client: LettaClient;
    let contributor: LettaContributor;

    beforeEach(() => {
      client = new LettaClient({ baseUrl: LETTA_URL });
    });

    afterEach(async () => {
      // Clean up Letta agent
      if (contributor) {
        try {
          await contributor.terminate();
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should create Letta agent on initialize', async () => {
      contributor = new LettaContributor(client, {
        id: `test-contrib-${uuid().slice(0, 8)}`,
        name: 'Test Worker',
        role: 'Integration Test Contributor',
        skills: ['testing'],
      });

      await contributor.initialize();

      const agentId = contributor.getLettaAgentId();
      expect(agentId).toBeTruthy();

      // Verify agent exists on server
      const agent = await client.getAgent(agentId!);
      expect(agent).toBeTruthy();
      expect(agent!.name).toContain('yi-');
    }, 60000);

    it('should execute task via Letta', async () => {
      contributor = new LettaContributor(client, {
        id: `test-exec-${uuid().slice(0, 8)}`,
        name: 'Task Executor',
        role: 'Task Handler',
      });

      await contributor.initialize();

      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Say "Hello from Letta" in your response.',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.executeTask(task);

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    }, 120000);

    it('should preserve correlation ID', async () => {
      contributor = new LettaContributor(client, {
        id: `test-corr-${uuid().slice(0, 8)}`,
        name: 'Correlation Tester',
      });

      await contributor.initialize();

      const correlationId = uuid();
      const task: TaskPayload = {
        id: uuid(),
        correlationId,
        objective: 'Just say OK',
        priority: 'low',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.executeTask(task);

      expect(result.correlationId).toBe(correlationId);
    }, 60000);
  });

  describeWithLetta()('LettaContributor State Persistence', () => {
    let client: LettaClient;
    let contributor: LettaContributor;

    beforeEach(() => {
      client = new LettaClient({ baseUrl: LETTA_URL });
    });

    afterEach(async () => {
      if (contributor) {
        try {
          await contributor.terminate();
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should export and import state', async () => {
      contributor = new LettaContributor(client, {
        id: `test-state-${uuid().slice(0, 8)}`,
        name: 'State Worker',
        role: 'State Tester',
        skills: ['persistence'],
        systemPrompt: 'You remember everything.',
      });

      await contributor.initialize();

      // Export state
      const state = await contributor.exportState();

      expect(state.yiId).toBe(contributor.id);
      expect(state.lettaAgentId).toBe(contributor.getLettaAgentId());
      expect(state.config.name).toBe('State Worker');
      expect(state.config.skills).toContain('persistence');
      expect(state.memoryBlocks.length).toBeGreaterThan(0);
      expect(state.metadata.version).toBe('1.0.0');
    }, 60000);

    it('should restore from persisted state', async () => {
      // Create and export first contributor
      const firstContributor = new LettaContributor(client, {
        id: `test-restore-${uuid().slice(0, 8)}`,
        name: 'First Worker',
        role: 'Original',
      });

      await firstContributor.initialize();
      const state = await firstContributor.exportState();

      // Create new contributor and restore from state
      contributor = new LettaContributor(client, {
        id: state.yiId,
        name: 'Second Worker', // Different name
      });

      await contributor.restoreFromState(state);

      // Should reconnect to same Letta agent
      expect(contributor.getLettaAgentId()).toBe(state.lettaAgentId);

      // Verify agent is alive
      const isAlive = await contributor.isAgentAlive();
      expect(isAlive).toBe(true);

      // Clean up first contributor's agent
      await firstContributor.terminate();
    }, 120000);

    it('should sync memory blocks', async () => {
      contributor = new LettaContributor(client, {
        id: `test-sync-${uuid().slice(0, 8)}`,
        name: 'Sync Worker',
      });

      await contributor.initialize();

      // Get current blocks
      const blocks = await contributor.getMemoryBlocks();
      expect(blocks.length).toBeGreaterThan(0);

      // Update a block
      await contributor.syncMemory([
        { label: 'task_context', value: 'Updated context for testing.' },
      ]);

      // Verify update
      const updatedBlocks = await contributor.getMemoryBlocks();
      const taskContext = updatedBlocks.find((b) => b.label === 'task_context');
      expect(taskContext?.value).toContain('Updated context');
    }, 60000);
  });

  describeWithLetta()('Letta Manager Delegation', () => {
    let client: LettaClient;
    let manager: LettaManager;
    let contributor: LettaContributor;

    beforeEach(() => {
      client = new LettaClient({ baseUrl: LETTA_URL });
    });

    afterEach(async () => {
      // Clean up agents
      if (contributor) {
        try {
          await contributor.terminate();
        } catch {
          // Ignore
        }
      }
      if (manager) {
        try {
          await manager.terminate();
        } catch {
          // Ignore
        }
      }
    });

    it('should delegate to Letta subordinates', async () => {
      const baseId = uuid().slice(0, 8);

      contributor = new LettaContributor(client, {
        id: `letta-sub-${baseId}`,
        name: 'Letta Subordinate',
        skills: ['work'],
      });

      manager = new LettaManager(client, {
        id: `letta-mgr-${baseId}`,
        name: 'Letta Manager',
      });

      await contributor.initialize();
      await manager.initialize();

      manager.addSubordinate(contributor);

      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Delegated task - say hello',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await manager.executeTask(task);

      expect(result.success).toBe(true);
    }, 180000);
  });

  describeWithLetta()('Letta Factory', () => {
    let client: LettaClient;
    let contributor: LettaContributor;

    beforeEach(() => {
      client = new LettaClient({ baseUrl: LETTA_URL });
    });

    afterEach(async () => {
      if (contributor) {
        try {
          await contributor.terminate();
        } catch {
          // Ignore
        }
      }
    });

    it('should create agents using factory', async () => {
      const factory = new LettaFactory(client, {
        defaultTeamId: 'integration-test',
      });

      contributor = factory.createContributor({
        id: `factory-contrib-${uuid().slice(0, 8)}`,
        name: 'Factory Worker',
        skills: ['factory', 'testing'],
      });

      expect(contributor.teamId).toBe('integration-test');

      await contributor.initialize();

      const agentId = contributor.getLettaAgentId();
      expect(agentId).toBeTruthy();
    }, 60000);
  });

  describeWithLetta()('Agent Health Monitoring', () => {
    let client: LettaClient;
    let contributor: LettaContributor;

    beforeEach(() => {
      client = new LettaClient({ baseUrl: LETTA_URL });
    });

    afterEach(async () => {
      if (contributor) {
        try {
          await contributor.terminate();
        } catch {
          // Ignore
        }
      }
    });

    it('should report agent alive status', async () => {
      contributor = new LettaContributor(client, {
        id: `health-test-${uuid().slice(0, 8)}`,
        name: 'Health Check Worker',
      });

      // Before initialization
      const beforeInit = await contributor.isAgentAlive();
      expect(beforeInit).toBe(false);

      await contributor.initialize();

      // After initialization
      const afterInit = await contributor.isAgentAlive();
      expect(afterInit).toBe(true);

      await contributor.terminate();

      // After termination
      const afterTerminate = await contributor.isAgentAlive();
      expect(afterTerminate).toBe(false);
    }, 60000);
  });
});
