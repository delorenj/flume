#!/usr/bin/env tsx
/**
 * Walking Skeleton with Real RabbitMQ Bloodbank
 *
 * This demonstrates the full lifecycle with actual RabbitMQ event emission:
 * - All state transitions emit events to RabbitMQ
 * - Events published to amq.topic exchange
 * - Full traceability via correlation IDs
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import {
  HRDepartment,
  YiOnboarding,
  type TeamContext,
  BloodbankPublisher,
  DEFAULT_BLOODBANK_CONFIG,
} from '@yi/adapter';
import {
  EchoContributor,
  EchoManager,
  EchoDirector,
  EchoMemory,
} from './index.js';

console.log('═══════════════════════════════════════════════════════════');
console.log('  🏢 FLUME/YI WALKING SKELETON - Real RabbitMQ Bloodbank');
console.log('═══════════════════════════════════════════════════════════');
console.log();

async function runWithRabbitMQ(): Promise<void> {
  const correlationId = uuid();
  console.log(`Correlation ID: ${correlationId}`);
  console.log(`RabbitMQ URL: ${DEFAULT_BLOODBANK_CONFIG.url.replace(/:[^:@]+@/, ':****@')}`);
  console.log();

  // Initialize real RabbitMQ Bloodbank publisher
  const bloodbank = new BloodbankPublisher(
    DEFAULT_BLOODBANK_CONFIG,
    'yi.echo.skeleton'
  );

  try {
    // ═══════════════════════════════════════════════════════════
    // CONNECT TO BLOODBANK
    // ═══════════════════════════════════════════════════════════
    console.log('🔌 CONNECT - Establishing Bloodbank connection');
    console.log('─────────────────────────────────────────────────────────');

    await bloodbank.connect();
    console.log('✓ Connected to RabbitMQ');
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
        lessonsLearned: ['Test everything', 'Emit events to Bloodbank'],
        skills: ['typescript', 'testing', 'rabbitmq'],
        mcpServers: [],
        tools: {},
      },
    };

    hr.registerTeamContext('echo-team', teamContext);
    console.log('✓ Infrastructure ready');
    console.log();

    // ═══════════════════════════════════════════════════════════
    // RECRUIT - With real Bloodbank events
    // ═══════════════════════════════════════════════════════════
    console.log('👥 RECRUIT - Building team (publishing to Bloodbank)');
    console.log('─────────────────────────────────────────────────────────');

    const director = new EchoDirector({
      name: 'RabbitMQ VP',
      teamId: 'echo-team',
    });

    const manager = new EchoManager({
      name: 'RabbitMQ Lead',
      teamId: 'echo-team',
      skills: ['management', 'typescript'],
    });

    const contributor = new EchoContributor({
      name: 'RabbitMQ Dev',
      teamId: 'echo-team',
      skills: ['typescript', 'backend', 'auth'],
    });

    // Wire hierarchy
    manager.recruit(contributor);
    director.recruit(manager);

    // Emit agent creation events to RabbitMQ
    await bloodbank.emitAgentCreated(
      director.id,
      director.name,
      'director',
      'echo-team',
      correlationId
    );

    await bloodbank.emitAgentCreated(
      manager.id,
      manager.name,
      'manager',
      'echo-team',
      correlationId
    );

    await bloodbank.emitAgentCreated(
      contributor.id,
      contributor.name,
      'contributor',
      'echo-team',
      correlationId
    );

    // Onboard everyone
    await onboarding.orient(director, teamContext);
    await onboarding.orient(manager, teamContext);
    await onboarding.orient(contributor, teamContext);

    console.log();
    console.log(`✓ Team created with ${3} agents, events published to Bloodbank`);
    console.log();

    // ═══════════════════════════════════════════════════════════
    // CREATE TASK - With Bloodbank event
    // ═══════════════════════════════════════════════════════════
    console.log('📝 CREATE - Task creation');
    console.log('─────────────────────────────────────────────────────────');

    const task: TaskPayload = {
      id: uuid(),
      correlationId,
      objective: 'Build OAuth2 authentication with RabbitMQ observability',
      context: { requirements: ['OAuth2', 'JWT tokens', 'Refresh flow', 'Event emission'] },
      priority: 1,
      createdAt: new Date().toISOString(),
      tags: ['auth', 'backend', 'typescript'],
    };

    // Emit task creation via convenience method pattern
    await bloodbank.publish({
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
      source: 'yi.echo.skeleton',
    });

    console.log(`✓ Task: ${task.objective}`);
    console.log();

    // ═══════════════════════════════════════════════════════════
    // DELEGATE - With events at each step
    // ═══════════════════════════════════════════════════════════
    console.log('🎯 DELEGATE - Task delegation chain');
    console.log('─────────────────────────────────────────────────────────');

    const startTime = Date.now();

    // Emit delegation start
    await bloodbank.emitTaskDelegated(
      task.id,
      director.id,
      manager.id,
      task.objective,
      correlationId,
      1
    );

    const result = await director.delegate(task);
    const duration = Date.now() - startTime;

    // Emit completion event
    await bloodbank.emitTaskCompleted(
      task.id,
      contributor.id,
      result.status,
      duration,
      correlationId
    );

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
    // VERIFY EVENTS IN RABBITMQ
    // ═══════════════════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  ✅ WALKING SKELETON WITH RABBITMQ COMPLETE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log();
    console.log('Events published to RabbitMQ amq.topic exchange:');
    console.log('  - yi.agent.created (x3)');
    console.log('  - flume.task.created (x1)');
    console.log('  - yi.task.delegated (x1)');
    console.log('  - yi.task.completed (x1)');
    console.log();
    console.log(`Verify at: http://192.168.1.12:15672/#/queues`);
    console.log(`Correlation ID for trace: ${correlationId}`);

  } finally {
    // Always close the connection
    await bloodbank.close();
  }
}

runWithRabbitMQ().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
