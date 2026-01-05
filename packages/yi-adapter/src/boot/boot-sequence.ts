/**
 * Boot Sequence - Initializes the 33GOD agentic pipeline
 *
 * This is the entry point for bringing up the full Flume/Yi system:
 * 1. Connect to Bloodbank (RabbitMQ)
 * 2. Connect to Plane
 * 3. Initialize HR and onboarding
 * 4. Boot registered teams
 * 5. Start event listeners
 */

import type { PlaneClient, PlaneConfig } from '@flume/core';
import { PlaneClient as PlaneClientImpl } from '@flume/core';
import {
  BloodbankPublisher,
  BloodbankConfig,
  DEFAULT_BLOODBANK_CONFIG,
} from '../events/bloodbank-publisher.js';
import { PlaneSyncService, PlaneSyncConfig, DEFAULT_PLANE_SYNC_CONFIG } from '../sync/plane-sync.js';
import { HRDepartment } from '../hr/hr-department.js';
import { YiOnboarding } from '../hr/onboarding-specialist.js';
import type { YiMemoryStrategy } from '../memory/strategy.js';
import type { TeamContext } from '../memory/team-context.js';

/**
 * Boot configuration.
 */
export interface BootConfig {
  serviceName: string;
  bloodbank: BloodbankConfig;
  plane: PlaneConfig;
  planeSync: PlaneSyncConfig;
}

/**
 * Default boot configuration for 33GOD.
 */
export const DEFAULT_BOOT_CONFIG: BootConfig = {
  serviceName: 'yi.boot',
  bloodbank: DEFAULT_BLOODBANK_CONFIG,
  plane: {
    baseUrl: process.env.PLANE_URL ?? 'https://plane.delo.sh',
    apiKey: process.env.PLANE_API_KEY ?? '',
    workspaceSlug: process.env.PLANE_WORKSPACE ?? '33god',
  },
  planeSync: DEFAULT_PLANE_SYNC_CONFIG,
};

/**
 * Boot context - holds all initialized services.
 */
export interface BootContext {
  bloodbank: BloodbankPublisher;
  plane: PlaneClient;
  planeSync: PlaneSyncService;
  hr: HRDepartment;
  onboarding: YiOnboarding;
  correlationId: string;
}

/**
 * Boot sequence for the 33GOD agentic pipeline.
 */
export class BootSequence {
  private context: BootContext | null = null;
  private running = false;

  constructor(
    private config: BootConfig = DEFAULT_BOOT_CONFIG,
    private memory: YiMemoryStrategy
  ) {}

  /**
   * Boot the system.
   */
  async boot(correlationId: string): Promise<BootContext> {
    if (this.running) {
      throw new Error('System already running');
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  🚀 33GOD AGENTIC PIPELINE - BOOT SEQUENCE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log();
    console.log(`Service: ${this.config.serviceName}`);
    console.log(`Correlation ID: ${correlationId}`);
    console.log();

    try {
      // Step 1: Connect to Bloodbank
      console.log('📡 STEP 1: Connecting to Bloodbank (RabbitMQ)');
      console.log('─────────────────────────────────────────────────────────');
      const bloodbank = new BloodbankPublisher(
        this.config.bloodbank,
        this.config.serviceName
      );
      await bloodbank.connect();
      console.log('✓ Bloodbank connected');
      console.log();

      // Step 2: Connect to Plane
      console.log('🛫 STEP 2: Connecting to Plane');
      console.log('─────────────────────────────────────────────────────────');
      const plane = new PlaneClientImpl(this.config.plane);
      const projects = await plane.listProjects();
      console.log(`✓ Plane connected - ${projects.length} projects found`);
      console.log();

      // Step 3: Initialize Plane sync
      console.log('🔄 STEP 3: Initializing Plane Sync');
      console.log('─────────────────────────────────────────────────────────');
      const planeSync = new PlaneSyncService(
        plane,
        bloodbank,
        this.config.planeSync
      );
      console.log('✓ Plane sync initialized');
      console.log();

      // Step 4: Initialize HR
      console.log('👥 STEP 4: Initializing HR Department');
      console.log('─────────────────────────────────────────────────────────');
      const onboarding = new YiOnboarding(this.memory);
      const hr = new HRDepartment(onboarding);
      console.log('✓ HR department ready');
      console.log();

      // Emit boot event
      await bloodbank.publish({
        event: 'yi.system.booted',
        version: '1.0.0',
        data: {
          serviceName: this.config.serviceName,
          projectCount: projects.length,
          bootTime: new Date().toISOString(),
        },
        exchange: 'amq.topic',
        routingKey: 'yi.system.booted',
        correlationId,
        timestamp: new Date().toISOString(),
        source: this.config.serviceName,
      });

      this.context = {
        bloodbank,
        plane,
        planeSync,
        hr,
        onboarding,
        correlationId,
      };

      this.running = true;

      console.log('═══════════════════════════════════════════════════════════');
      console.log('  ✅ BOOT SEQUENCE COMPLETE');
      console.log('═══════════════════════════════════════════════════════════');
      console.log();

      return this.context;
    } catch (error) {
      console.error('❌ Boot failed:', error);
      throw error;
    }
  }

  /**
   * Register a team with the system.
   */
  registerTeam(teamId: string, context: TeamContext): void {
    if (!this.context) {
      throw new Error('System not booted');
    }
    this.context.hr.registerTeamContext(teamId, context);
    console.log(`[Boot] Registered team: ${teamId}`);
  }

  /**
   * Shutdown the system gracefully.
   */
  async shutdown(): Promise<void> {
    if (!this.running || !this.context) {
      return;
    }

    console.log();
    console.log('🛑 SHUTTING DOWN');
    console.log('─────────────────────────────────────────────────────────');

    // Emit shutdown event
    await this.context.bloodbank.publish({
      event: 'yi.system.shutdown',
      version: '1.0.0',
      data: {
        serviceName: this.config.serviceName,
        shutdownTime: new Date().toISOString(),
      },
      exchange: 'amq.topic',
      routingKey: 'yi.system.shutdown',
      correlationId: this.context.correlationId,
      timestamp: new Date().toISOString(),
      source: this.config.serviceName,
    });

    await this.context.bloodbank.close();
    this.running = false;
    this.context = null;

    console.log('✓ Shutdown complete');
  }

  /**
   * Check if the system is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current boot context.
   */
  getContext(): BootContext | null {
    return this.context;
  }
}
