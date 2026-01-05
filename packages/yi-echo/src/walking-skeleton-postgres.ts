#!/usr/bin/env tsx
/**
 * Walking Skeleton with PostgreSQL Persistence
 *
 * This demonstrates the full 33GOD agentic pipeline with database persistence:
 * - Employees stored in PostgreSQL
 * - Tasks stored in PostgreSQL
 * - State transitions logged
 * - Events stored for replay
 */

import { v4 as uuid } from 'uuid';
import type { TaskPayload } from '@flume/core';
import { PostgresClient } from '@flume/core';
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

const PLANE_API_KEY = 'plane_api_72e0decd8f9e46e68e2885521b8d64ff';
const POSTGRES_PASSWORD = 'REDACTED_CREDENTIAL';

console.log('═══════════════════════════════════════════════════════════');
console.log('  🏢 33GOD AGENTIC PIPELINE - PostgreSQL Persistence');
console.log('═══════════════════════════════════════════════════════════');
console.log();

async function runWithPostgres(): Promise<void> {
  const correlationId = uuid();
  const memory = new EchoMemory();

  // Initialize PostgreSQL client
  const db = new PostgresClient({
    host: '192.168.1.12',
    port: 5432,
    database: '33god',
    user: 'delorenj',
    password: POSTGRES_PASSWORD,
  });

  // Initialize boot sequence
  const boot = new BootSequence(
    {
      serviceName: 'yi.echo.postgres-skeleton',
      bloodbank: {
        url: 'amqp://delorenj:REDACTED_CREDENTIAL@192.168.1.12:5672',
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
    // CONNECT TO DATABASE
    // ═══════════════════════════════════════════════════════════
    console.log('🗄️  CONNECTING TO POSTGRESQL');
    console.log('─────────────────────────────────────────────────────────');
    await db.connect();
    console.log('✓ Database connected');
    console.log();

    // ═══════════════════════════════════════════════════════════
    // BOOT SYSTEM
    // ═══════════════════════════════════════════════════════════
    const ctx = await boot.boot(correlationId);

    // Store boot event in database
    await db.storeEvent({
      id: uuid(),
      event: 'yi.system.booted',
      version: '1.0.0',
      correlationId,
      source: 'yi.echo.postgres-skeleton',
      exchange: 'amq.topic',
      routingKey: 'yi.system.booted',
      data: { serviceName: 'yi.echo.postgres-skeleton' },
    });

    // ═══════════════════════════════════════════════════════════
    // CREATE TEAM IN DATABASE
    // ═══════════════════════════════════════════════════════════
    console.log('📋 CREATING TEAM IN DATABASE');
    console.log('─────────────────────────────────────────────────────────');

    const teamId = uuid();
    await db.createTeam({
      id: teamId,
      name: 'Echo Postgres Team',
      missionStatement: 'Build the 33GOD agentic pipeline with persistence',
      sharedKnowledgeBaseId: 'default',
    });
    console.log(`✓ Team created: ${teamId}`);

    const teamContext: TeamContext = {
      teamId,
      missionStatement: 'Build the 33GOD agentic pipeline with persistence',
      sharedKnowledgeBaseId: 'default',
      accessLevel: 'full-time',
      techContext: {
        memories: [],
        lessonsLearned: ['Persist everything', 'Log state transitions'],
        skills: ['typescript', 'postgres', 'rabbitmq'],
        mcpServers: [],
        tools: {},
      },
    };

    boot.registerTeam(teamId, teamContext);
    console.log();

    // ═══════════════════════════════════════════════════════════
    // RECRUIT AGENTS WITH DATABASE PERSISTENCE
    // ═══════════════════════════════════════════════════════════
    console.log('👥 RECRUITING AGENTS (persisted to PostgreSQL)');
    console.log('─────────────────────────────────────────────────────────');

    const director = new EchoDirector({
      name: 'DB-Persisted VP',
      teamId,
    });

    const manager = new EchoManager({
      name: 'DB-Persisted Lead',
      teamId,
      skills: ['management', 'typescript'],
    });

    const contributor = new EchoContributor({
      name: 'DB-Persisted Dev',
      teamId,
      skills: ['typescript', 'backend', 'postgres'],
    });

    // Wire hierarchy
    manager.recruit(contributor);
    director.recruit(manager);

    // Persist employees to database
    await db.createEmployee({
      id: director.id,
      name: director.name,
      role: 'director',
      agentType: 'custom',
      teamId,
      skills: [],
    });

    await db.createEmployee({
      id: manager.id,
      name: manager.name,
      role: 'manager',
      agentType: 'custom',
      teamId,
      reportsToId: director.id,
      skills: ['management', 'typescript'],
    });

    await db.createEmployee({
      id: contributor.id,
      name: contributor.name,
      role: 'contributor',
      agentType: 'custom',
      teamId,
      reportsToId: manager.id,
      skills: ['typescript', 'backend', 'postgres'],
    });

    console.log(`✓ Director persisted: ${director.id}`);
    console.log(`✓ Manager persisted: ${manager.id}`);
    console.log(`✓ Contributor persisted: ${contributor.id}`);

    // Emit creation events
    await ctx.bloodbank.emitAgentCreated(director.id, director.name, 'director', teamId, correlationId);
    await ctx.bloodbank.emitAgentCreated(manager.id, manager.name, 'manager', teamId, correlationId);
    await ctx.bloodbank.emitAgentCreated(contributor.id, contributor.name, 'contributor', teamId, correlationId);

    // Onboard
    await ctx.onboarding.orient(director, teamContext);
    await ctx.onboarding.orient(manager, teamContext);
    await ctx.onboarding.orient(contributor, teamContext);

    // Update state in database after onboarding
    await db.updateEmployeeState(director.id, 'idle');
    await db.updateEmployeeState(manager.id, 'idle');
    await db.updateEmployeeState(contributor.id, 'idle');

    // Log state transitions
    await db.logStateTransition(director.id, 'initializing', 'idle', 'onboarding_complete');
    await db.logStateTransition(manager.id, 'initializing', 'idle', 'onboarding_complete');
    await db.logStateTransition(contributor.id, 'initializing', 'idle', 'onboarding_complete');

    console.log('✓ All agents onboarded and state persisted');
    console.log();

    // ═══════════════════════════════════════════════════════════
    // CREATE TASK WITH DATABASE PERSISTENCE
    // ═══════════════════════════════════════════════════════════
    console.log('📝 CREATING TASK (persisted to PostgreSQL)');
    console.log('─────────────────────────────────────────────────────────');

    const task: TaskPayload = {
      id: uuid(),
      correlationId,
      objective: 'Build PostgreSQL persistence layer for 33GOD',
      context: {
        requirements: ['Employee CRUD', 'Task CRUD', 'State history logging'],
      },
      priority: 2,
      createdAt: new Date().toISOString(),
      tags: ['backend', 'postgres', 'typescript'],
    };

    // Persist task to database
    const taskRecord = await db.createTask({
      id: task.id,
      correlationId: task.correlationId,
      title: task.objective,
      description: 'Build PostgreSQL persistence layer for 33GOD agentic pipeline',
      requirements: task.context as Record<string, unknown>,
      priority: 'high',
    });
    console.log(`✓ Task persisted: ${taskRecord.id}`);

    // Sync to Plane
    const mapping = await ctx.planeSync.syncTask(task, 'FLUME');
    console.log(`✓ Synced to Plane: ${mapping.planeIssueId}`);
    console.log();

    // ═══════════════════════════════════════════════════════════
    // EXECUTE DELEGATION WITH STATE PERSISTENCE
    // ═══════════════════════════════════════════════════════════
    console.log('🎯 EXECUTING DELEGATION (state persisted)');
    console.log('─────────────────────────────────────────────────────────');

    // Update task state
    await db.updateTaskState(task.id, 'assigned');

    const startTime = Date.now();
    const result = await director.delegate(task);
    const duration = Date.now() - startTime;

    // Update final task state in database (done for success/delegated, closed for failure)
    const finalState = ['success', 'delegated'].includes(result.status) ? 'done' : 'closed';
    await db.updateTaskState(task.id, finalState);

    // Log final state transitions
    await db.logStateTransition(director.id, 'delegating', 'idle', 'task_complete', task.id);
    await db.logStateTransition(manager.id, 'delegating', 'idle', 'task_complete', task.id);
    await db.logStateTransition(contributor.id, 'working', 'idle', 'task_complete', task.id);

    // Emit completion
    await ctx.bloodbank.emitTaskCompleted(task.id, contributor.id, result.status, duration, correlationId);

    console.log();

    // ═══════════════════════════════════════════════════════════
    // VERIFY PERSISTENCE
    // ═══════════════════════════════════════════════════════════
    console.log('🔍 VERIFYING DATABASE PERSISTENCE');
    console.log('─────────────────────────────────────────────────────────');

    const storedTask = await db.getTask(task.id);
    const storedEmployees = await db.getEmployeesByTeam(teamId);
    const storedEvents = await db.getEventsByCorrelation(correlationId);

    console.log(`✓ Task in DB: ${storedTask?.title}`);
    console.log(`✓ Task state: ${storedTask?.state}`);
    console.log(`✓ Employees in DB: ${storedEmployees.length}`);
    console.log(`✓ Events stored: ${storedEvents.length}`);
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
    console.log();

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  ✅ POSTGRESQL PERSISTENCE SKELETON COMPLETE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log();
    console.log('Persisted to PostgreSQL:');
    console.log(`  ✓ Team: ${teamId}`);
    console.log(`  ✓ Employees: ${storedEmployees.length}`);
    console.log(`  ✓ Task: ${task.id}`);
    console.log(`  ✓ Events: ${storedEvents.length}`);
    console.log(`  ✓ State transitions logged`);
    console.log();
    console.log(`Correlation ID: ${correlationId}`);
    console.log();

  } finally {
    await boot.shutdown();
    await db.close();
  }
}

runWithPostgres().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
