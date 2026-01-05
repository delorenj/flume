#!/usr/bin/env tsx
/**
 * Walking Skeleton with Events - Includes Bloodbank event emission
 *
 * This demonstrates the full lifecycle with observability:
 * - All state transitions emit events
 * - Delegation decisions are tracked
 * - Task completion is logged
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import {
  HRDepartment,
  YiOnboarding,
  type TeamContext,
  ConsoleEventPublisher,
} from '@yi/adapter';
import {
  EchoContributor,
  EchoManager,
  EchoDirector,
  EchoMemory,
} from './index.js';

console.log('═══════════════════════════════════════════════════════════');
console.log('  🏢 FLUME/YI WALKING SKELETON - With Event Emission');
console.log('═══════════════════════════════════════════════════════════');
console.log();

async function runWithEvents(): Promise<void> {
  // Initialize event publisher (console for demo, RabbitMQ for prod)
  const eventPublisher = new ConsoleEventPublisher('yi.echo.demo');
  const correlationId = uuid();

  console.log(`Correlation ID: ${correlationId}`);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════
  console.log('📋 BOOT - Initializing corporate infrastructure');
  console.log('─────────────────────────────────────────────────────────');

  const memory = new EchoMemory();
  const onboarding = new YiOnboarding(memory);
  const hr = new HRDepartment(onboarding);

  const teamContext: TeamContext = {
    teamId: 'echo-team',
    missionStatement: 'Build the 33GOD agentic pipeline',
    sharedKnowledgeBaseId: 'default',
    accessLevel: 'full-time',
    techContext: {
      memories: [],
      lessonsLearned: ['Test everything', 'Emit events'],
      skills: ['typescript', 'testing'],
      mcpServers: [],
      tools: {},
    },
  };

  hr.registerTeamContext('echo-team', teamContext);
  console.log('✓ Infrastructure ready');
  console.log();

  // ═══════════════════════════════════════════════════════════
  // RECRUIT - With event emission
  // ═══════════════════════════════════════════════════════════
  console.log('👥 RECRUIT - Building team (with events)');
  console.log('─────────────────────────────────────────────────────────');

  const director = new EchoDirector({
    name: 'Event-Aware VP',
    teamId: 'echo-team',
  });

  const manager = new EchoManager({
    name: 'Event-Aware Lead',
    teamId: 'echo-team',
    skills: ['management', 'typescript'],
  });

  const contributor = new EchoContributor({
    name: 'Event-Aware Dev',
    teamId: 'echo-team',
    skills: ['typescript', 'backend', 'auth'],
  });

  // Wire hierarchy
  manager.recruit(contributor);
  director.recruit(manager);

  // Emit agent creation events
  await eventPublisher.publish({
    event: 'yi.agent.created',
    version: '1.0.0',
    data: { agentId: director.id, name: director.name, role: 'director' },
    exchange: 'amq.topic',
    routingKey: 'yi.agent.created',
    correlationId,
    timestamp: new Date().toISOString(),
    source: 'yi.echo.demo',
  });

  await eventPublisher.publish({
    event: 'yi.agent.created',
    version: '1.0.0',
    data: { agentId: manager.id, name: manager.name, role: 'manager' },
    exchange: 'amq.topic',
    routingKey: 'yi.agent.created',
    correlationId,
    timestamp: new Date().toISOString(),
    source: 'yi.echo.demo',
  });

  await eventPublisher.publish({
    event: 'yi.agent.created',
    version: '1.0.0',
    data: { agentId: contributor.id, name: contributor.name, role: 'contributor' },
    exchange: 'amq.topic',
    routingKey: 'yi.agent.created',
    correlationId,
    timestamp: new Date().toISOString(),
    source: 'yi.echo.demo',
  });

  // Onboard everyone
  await onboarding.orient(director, teamContext);
  await onboarding.orient(manager, teamContext);
  await onboarding.orient(contributor, teamContext);

  console.log();
  console.log(`✓ Team created with ${3} agents`);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // CREATE TASK - With event
  // ═══════════════════════════════════════════════════════════
  console.log('📝 CREATE - Task creation');
  console.log('─────────────────────────────────────────────────────────');

  const task: TaskPayload = {
    id: uuid(),
    correlationId,
    objective: 'Build OAuth2 authentication',
    context: { requirements: ['OAuth2', 'JWT tokens', 'Refresh flow'] },
    priority: 1,
    createdAt: new Date().toISOString(),
    tags: ['auth', 'backend', 'typescript'],
  };

  await eventPublisher.publish({
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
    source: 'yi.echo.demo',
  });

  console.log(`✓ Task: ${task.objective}`);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // DELEGATE - With events at each step
  // ═══════════════════════════════════════════════════════════
  console.log('🎯 DELEGATE - Task delegation chain');
  console.log('─────────────────────────────────────────────────────────');

  const startTime = Date.now();
  const result = await director.delegate(task);
  const duration = Date.now() - startTime;

  // Emit completion event
  await eventPublisher.publish({
    event: 'flume.task.completed',
    version: '1.0.0',
    data: {
      taskId: task.id,
      status: result.status,
      durationMs: duration,
      delegationDepth: result.metrics.delegationDepth,
    },
    exchange: 'amq.topic',
    routingKey: 'flume.task.completed',
    correlationId,
    timestamp: new Date().toISOString(),
    source: 'yi.echo.demo',
  });

  console.log();

  // ═══════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════
  console.log('📊 RESULTS');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`Status: ${result.status}`);
  console.log(`Output: ${JSON.stringify(result.output)}`);
  console.log(`Duration: ${duration}ms`);
  console.log(`Delegation Depth: ${result.metrics.delegationDepth ?? 0}`);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // EVENT SUMMARY
  // ═══════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ WALKING SKELETON WITH EVENTS COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log('Events emitted:');
  console.log('  - yi.agent.created (x3)');
  console.log('  - flume.task.created (x1)');
  console.log('  - flume.task.completed (x1)');
  console.log();
  console.log('For full event emission, use BloodbankPublisher with RabbitMQ.');
}

runWithEvents().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
