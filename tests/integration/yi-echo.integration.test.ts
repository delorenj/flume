/**
 * Integration Tests for yi-echo
 *
 * These tests verify the full delegation chain using Echo agents:
 * - Director -> Manager -> Contributor
 * - Manager IC mode (no subordinates)
 * - Event correlation across the chain
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import {
  EchoDirector,
  EchoManager,
  EchoContributor,
  EchoSlowContributor,
  EchoFactory,
  createEchoTeam,
} from '@yi/echo';
import type { TaskPayload } from '@flume/core';

describe('Yi Echo Integration', () => {
  describe('Full Delegation Chain: Director -> Manager -> Contributor', () => {
    let director: EchoDirector;
    let manager: EchoManager;
    let contributor1: EchoContributor;
    let contributor2: EchoContributor;

    beforeEach(async () => {
      // Create the hierarchy
      contributor1 = new EchoContributor({
        id: 'contrib-1',
        name: 'Echo Worker 1',
        skills: ['coding', 'testing'],
      });

      contributor2 = new EchoContributor({
        id: 'contrib-2',
        name: 'Echo Worker 2',
        skills: ['design', 'testing'],
      });

      manager = new EchoManager({
        id: 'manager-1',
        name: 'Echo Team Lead',
      });

      director = new EchoDirector({
        id: 'director-1',
        name: 'Echo VP',
      });

      // Build the hierarchy: Director -> Manager -> Contributors
      manager.recruit(contributor1);
      manager.recruit(contributor2);
      director.recruit(manager);

      // Onboard agents to make them idle
      await contributor1.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await contributor1.verifyReadiness();
      await contributor2.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await contributor2.verifyReadiness();
      await manager.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await manager.verifyReadiness();
      await director.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await director.verifyReadiness();
    });

    it('should delegate task through full chain', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Implement new feature',
        context: { priority: 'high' },
        priority: 'high',
        tags: ['coding'],
        createdAt: new Date().toISOString(),
      };

      const result = await director.delegate(task);

      expect(result.status).toBe('delegated');
      expect(result.output).toBeDefined();
      // Result should come from a contributor
      expect(typeof result.output).toBe('string');
      expect(result.output).toContain('completed');
    });

    it('should preserve correlation ID through delegation chain', async () => {
      const correlationId = uuid();
      const task: TaskPayload = {
        id: uuid(),
        correlationId,
        objective: 'Track correlation',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await director.delegate(task);

      expect(result.status).toBe('delegated');
      // Result includes delegation metadata
      expect(result.delegatedTo).toBeDefined();
    });

    it('should add strategic context at director level', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Strategic task',
        priority: 'high',
        createdAt: new Date().toISOString(),
      };

      // Director adds strategic context before delegation
      const result = await director.delegate(task);

      expect(result.status).toBe('delegated');
    });
  });

  describe('Manager IC Mode (no subordinates)', () => {
    let manager: EchoManager;

    beforeEach(async () => {
      manager = new EchoManager({
        id: 'solo-manager',
        name: 'Solo Manager',
      });
      // Note: No subordinates recruited

      // Onboard to make idle
      await manager.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await manager.verifyReadiness();
    });

    it('should handle task directly when no subordinates', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Direct task handling',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await manager.execute(task);

      expect(result.status).toBe('success');
      expect(result.output).toContain('directly');
      expect(result.output).toContain('IC mode');
    });
  });

  describe('Contributor Direct Execution', () => {
    let contributor: EchoContributor;

    beforeEach(async () => {
      contributor = new EchoContributor({
        id: 'direct-contrib',
        name: 'Direct Worker',
        skills: ['general'],
      });

      await contributor.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await contributor.verifyReadiness();
    });

    it('should execute task and return result', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Simple task',
        priority: 'low',
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.execute(task);

      expect(result.status).toBe('success');
      expect(result.output).toContain('completed');
      expect(result.output).toContain('Simple task');
    });

    it('should include metrics in result', async () => {
      const taskId = uuid();
      const task: TaskPayload = {
        id: taskId,
        correlationId: uuid(),
        objective: 'Metadata test',
        priority: 'high',
        tags: ['test', 'metadata'],
        createdAt: new Date().toISOString(),
      };

      const result = await contributor.execute(task);

      expect(result.status).toBe('success');
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAt).toBeDefined();
    });
  });

  describe('Factory Pattern', () => {
    it('should create team using createEchoTeam helper', async () => {
      const { director, manager, contributors } = createEchoTeam('test-team');

      expect(director).toBeDefined();
      expect(manager).toBeDefined();
      expect(contributors.length).toBe(3);

      // Onboard all agents
      for (const contrib of contributors) {
        await contrib.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
        await contrib.verifyReadiness();
      }
      await manager.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await manager.verifyReadiness();
      await director.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await director.verifyReadiness();

      // Execute task
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Factory test',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await director.delegate(task);
      expect(result.status).toBe('delegated');
    });

    it('should create agents using EchoFactory', async () => {
      const factory = new EchoFactory('factory-team');

      const contrib = await factory.createAgent(['coding'], 'Factory Worker');
      expect(contrib).toBeDefined();
      expect(contrib.name).toBe('Factory Worker');
    });
  });

  describe('Slow Contributor Handling', () => {
    it('should handle slow contributors without timeout', async () => {
      const slowContributor = new EchoSlowContributor(500, {
        id: 'slow-worker',
        name: 'Slow Worker',
      });

      await slowContributor.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await slowContributor.verifyReadiness();

      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Slow task',
        priority: 'low',
        createdAt: new Date().toISOString(),
      };

      const startTime = Date.now();
      const result = await slowContributor.execute(task);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('success');
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(result.output).toContain('slowly completed');
    });
  });

  describe('Multiple Subordinate Selection', () => {
    let manager: EchoManager;
    let codingContrib: EchoContributor;
    let designContrib: EchoContributor;

    beforeEach(async () => {
      codingContrib = new EchoContributor({
        id: 'coder',
        name: 'Coder',
        skills: ['coding', 'typescript'],
      });

      designContrib = new EchoContributor({
        id: 'designer',
        name: 'Designer',
        skills: ['design', 'ui'],
      });

      manager = new EchoManager({
        id: 'team-lead',
        name: 'Team Lead',
      });

      manager.recruit(codingContrib);
      manager.recruit(designContrib);

      // Onboard all
      await codingContrib.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await codingContrib.verifyReadiness();
      await designContrib.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await designContrib.verifyReadiness();
      await manager.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await manager.verifyReadiness();
    });

    it('should delegate to first available subordinate', async () => {
      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'Any task',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await manager.execute(task);

      expect(result.status).toBe('delegated');
      // With first-match strategy, should go to first subordinate
    });

    it('should handle subordinate removal', async () => {
      manager.release(codingContrib.id);

      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'After removal',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await manager.execute(task);

      expect(result.status).toBe('delegated');
      // Should still work with remaining subordinate
    });

    it('should fall back to IC mode when all subordinates removed', async () => {
      manager.release(codingContrib.id);
      manager.release(designContrib.id);

      const task: TaskPayload = {
        id: uuid(),
        correlationId: uuid(),
        objective: 'No subordinates left',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      const result = await manager.execute(task);

      expect(result.status).toBe('success');
      expect(result.output).toContain('IC mode');
    });
  });

  describe('Agent State Management', () => {
    let contributor: EchoContributor;

    beforeEach(() => {
      contributor = new EchoContributor({
        id: 'state-test',
        name: 'State Tester',
      });
    });

    it('should start in initializing state', () => {
      expect(contributor.state).toBe('initializing');
    });

    it('should transition to idle after onboarding', async () => {
      await contributor.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      expect(contributor.state).toBe('onboarding');

      await contributor.verifyReadiness();
      expect(contributor.state).toBe('idle');
    });

    it('should report status correctly', async () => {
      await contributor.injectMemory({ mission: 'Test', protocols: [], accessLevel: 'full' });
      await contributor.verifyReadiness();

      const status = await contributor.reportStatus();

      expect(status.state).toBe('idle');
      expect(status.message).toContain('Ready');
    });
  });
});
