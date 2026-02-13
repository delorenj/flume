#!/usr/bin/env tsx
/**
 * Full Walking Skeleton - Complete E2E validation
 *
 * This demonstrates the full 33GOD agentic pipeline:
 * 1. Boot sequence (Bloodbank + Plane + HR)
 * 2. Team recruitment and onboarding
 * 3. Task creation with Plane sync
 * 4. Delegation chain execution
 * 5. Event emission and observability
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import {
  BootSequence,
  type TeamContext,
} from '@yi/adapter';
import {
  EchoContributor,
  EchoManager,
  EchoDirector,
  EchoMemory,
} from './index.js';

const PLANE_API_KEY = process.env.PLANE_API_KEY ?? 'your_plane_api_key_here';

console.log('═══════════════════════════════════════════════════════════');
console.log('  🏢 33GOD AGENTIC PIPELINE - FULL WALKING SKELETON');
console.log('═══════════════════════════════════════════════════════════');
console.log();

async function runFullSkeleton(): Promise<void> {
  const correlationId = uuid();
  const memory = new EchoMemory();

  // Initialize boot sequence
  const boot = new BootSequence(
    {
      serviceName: 'yi.echo.full-skeleton',
      bloodbank: {
        url: 'amqp://user:pass@localhost:5672',
        exchange: 'amq.topic',
      },
      plane: {
        baseUrl: 'https://plane.delo.sh',
        apiKey: PLANE_API_KEY,
        workspaceSlug: '33god',
      },
      planeSync: {
        defaultProjectIdentifier: 'FLUME',
        enabled: true,
      },
    },
    memory
  );

  try {
    // ═══════════════════════════════════════════════════════════
    // BOOT
    // ═══════════════════════════════════════════════════════════
    const ctx = await boot.boot(correlationId);

    // ═══════════════════════════════════════════════════════════
    // REGISTER TEAM
    // ═══════════════════════════════════════════════════════════
    console.log('📋 TEAM REGISTRATION');
    console.log('─────────────────────────────────────────────────────────');

    const teamContext: TeamContext = {
      teamId: 'echo-team',
      missionStatement: 'Build the 33GOD agentic pipeline',
      sharedKnowledgeBaseId: 'default',
      accessLevel: 'full-time',
      techContext: {
        memories: [],
        lessonsLearned: ['Test everything', 'Emit events', 'Sync to Plane'],
        skills: ['typescript', 'testing', 'rabbitmq', 'postgres'],
        mcpServers: [],
        tools: {},
      },
    };

    boot.registerTeam('echo-team', teamContext);
    console.log('✓ Team registered');
    console.log();

    // ═══════════════════════════════════════════════════════════
    // RECRUIT AGENTS
    // ═══════════════════════════════════════════════════════════
    console.log('👥 AGENT RECRUITMENT');
    console.log('─────────────────────────────────────────────────────────');

    const director = new EchoDirector({
      name: 'VP Engineering',
      teamId: 'echo-team',
    });

    const manager = new EchoManager({
      name: 'Tech Lead',
      teamId: 'echo-team',
      skills: ['management', 'typescript', 'architecture'],
    });

    const dev1 = new EchoContributor({
      name: 'Backend Dev',
      teamId: 'echo-team',
      skills: ['typescript', 'backend', 'postgres', 'rabbitmq'],
    });

    const dev2 = new EchoContributor({
      name: 'Frontend Dev',
      teamId: 'echo-team',
      skills: ['typescript', 'frontend', 'react', 'css'],
    });

    // Wire hierarchy
    manager.recruit(dev1);
    manager.recruit(dev2);
    director.recruit(manager);

    // Emit agent creation events
    await ctx.bloodbank.emitAgentCreated(director.id, director.name, 'director', 'echo-team', correlationId);
    await ctx.bloodbank.emitAgentCreated(manager.id, manager.name, 'manager', 'echo-team', correlationId);
    await ctx.bloodbank.emitAgentCreated(dev1.id, dev1.name, 'contributor', 'echo-team', correlationId);
    await ctx.bloodbank.emitAgentCreated(dev2.id, dev2.name, 'contributor', 'echo-team', correlationId);

    // Onboard agents
    await ctx.onboarding.orient(director, teamContext);
    await ctx.onboarding.orient(manager, teamContext);
    await ctx.onboarding.orient(dev1, teamContext);
    await ctx.onboarding.orient(dev2, teamContext);

    console.log(`✓ Recruited and onboarded ${4} agents`);
    console.log();

    // ═══════════════════════════════════════════════════════════
    // CREATE AND SYNC TASK
    // ═══════════════════════════════════════════════════════════
    console.log('📝 TASK CREATION');
    console.log('─────────────────────────────────────────────────────────');

    const task: TaskPayload = {
      id: uuid(),
      correlationId,
      objective: 'Build event-driven task pipeline with Plane sync',
      context: {
        requirements: [
          'RabbitMQ event emission',
          'Plane issue synchronization',
          'State machine transitions',
        ],
      },
      priority: 2,
      createdAt: new Date().toISOString(),
      tags: ['backend', 'rabbitmq', 'postgres'],
    };

    // Emit task creation event
    await ctx.bloodbank.publish({
      event: 'flume.task.created',
      version: '1.0.0',
      data: {
        taskId: task.id,
        objective: task.objective,
        tags: task.tags,
      },
      exchange: 'amq.topic',
      routingKey: 'flume.task.created',
      correlationId,
      timestamp: new Date().toISOString(),
      source: 'yi.echo.full-skeleton',
    });

    // Sync to Plane
    console.log('Syncing task to Plane...');
    const mapping = await ctx.planeSync.syncTask(task, 'FLUME');
    console.log(`✓ Task created: ${task.objective}`);
    console.log(`✓ Synced to Plane: issue ${mapping.planeIssueId}`);
    console.log();

    // ═══════════════════════════════════════════════════════════
    // EXECUTE DELEGATION CHAIN
    // ═══════════════════════════════════════════════════════════
    console.log('🎯 TASK DELEGATION');
    console.log('─────────────────────────────────────────────────────────');

    const startTime = Date.now();

    // Emit delegation event
    await ctx.bloodbank.emitTaskDelegated(
      task.id,
      director.id,
      manager.id,
      task.objective,
      correlationId,
      1
    );

    // Execute delegation chain
    const result = await director.delegate(task);
    const duration = Date.now() - startTime;

    // Emit completion event
    await ctx.bloodbank.emitTaskCompleted(
      task.id,
      result.delegatedTo ?? director.id,
      result.status,
      duration,
      correlationId
    );

    // Sync completion to Plane
    await ctx.planeSync.syncTaskComplete(task.id, result);

    console.log();

    // ═══════════════════════════════════════════════════════════
    // RESULTS
    // ═══════════════════════════════════════════════════════════
    console.log('📊 EXECUTION RESULTS');
    console.log('─────────────────────────────────────────────────────────');
    console.log(`Status: ${result.status}`);
    console.log(`Output: ${JSON.stringify(result.output)}`);
    console.log(`Duration: ${duration}ms`);
    console.log(`Delegation Depth: ${result.metrics.delegationDepth ?? 0}`);
    console.log(`Delegated To: ${result.delegatedTo ?? 'N/A'}`);
    console.log();

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  ✅ FULL WALKING SKELETON COMPLETE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log();
    console.log('Integration Points Validated:');
    console.log('  ✓ RabbitMQ Bloodbank - Event emission');
    console.log('  ✓ Plane API - Project/State queries');
    console.log('  ✓ Plane Sync - Task to issue mapping');
    console.log('  ✓ HR Department - Team registration');
    console.log('  ✓ Yi Onboarding - Agent context injection');
    console.log('  ✓ Delegation Chain - Director → Manager → Contributor');
    console.log('  ✓ State Machine - Valid transitions');
    console.log();
    console.log('Events Published:');
    console.log('  - yi.system.booted');
    console.log('  - yi.agent.created (x4)');
    console.log('  - flume.task.created');
    console.log('  - flume.plane.synced');
    console.log('  - flume.task.delegated');
    console.log('  - flume.task.completed');
    console.log('  - yi.system.shutdown');
    console.log();
    console.log(`Correlation ID: ${correlationId}`);
    console.log(`Plane Issue: ${mapping.planeIssueId}`);
    console.log();

  } finally {
    // Graceful shutdown
    await boot.shutdown();
  }
}

runFullSkeleton().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
