/**
 * Letta Factory - Creates Letta-backed agents for Yi
 *
 * Implements AgentFactory to create Contributors, Managers, and Directors
 * backed by Letta agents.
 */

import type { Employee } from '@flume/core';
import type { AgentFactory } from '@yi/adapter';
import { LettaClient, DEFAULT_LETTA_CONFIG, type LettaConfig } from '../client/letta-client.js';
import { LettaContributor, type LettaContributorConfig } from '../agents/letta-contributor.js';
import { LettaManager, type LettaManagerConfig } from '../agents/letta-manager.js';
import { LettaDirector, type LettaDirectorConfig } from '../agents/letta-director.js';

export interface LettaFactoryConfig {
  lettaConfig?: LettaConfig;
  defaultTeamId?: string;
  defaultTools?: string[];
}

/**
 * Factory for creating Letta-backed agents.
 */
export class LettaFactory implements AgentFactory {
  readonly name = 'letta-factory';

  private lettaClient: LettaClient;
  private defaultTeamId: string;
  private defaultTools: string[];
  private connected = false;

  constructor(config: LettaFactoryConfig = {}) {
    this.lettaClient = new LettaClient(config.lettaConfig ?? DEFAULT_LETTA_CONFIG);
    this.defaultTeamId = config.defaultTeamId ?? 'default';
    this.defaultTools = config.defaultTools ?? [];
  }

  /**
   * Get the Letta client instance.
   */
  getClient(): LettaClient {
    return this.lettaClient;
  }

  /**
   * Verify connection to Letta server.
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;

    console.log(`[LettaFactory] Connecting to Letta server...`);
    const healthy = await this.lettaClient.health();

    if (healthy) {
      this.connected = true;
      console.log(`[LettaFactory] Connected to Letta server`);
    } else {
      console.warn(`[LettaFactory] Letta server not available`);
    }

    return healthy;
  }

  /**
   * Check if this factory can create agents with the given skills.
   * Letta can handle most general-purpose agent needs.
   */
  canCreate(skills: string[]): boolean {
    // Letta can create agents for most skills
    // Only reject if explicitly requesting a different framework
    const excludedSkills = ['agno-native', 'claude-native', 'custom-only'];
    return !skills.some(skill => excludedSkills.includes(skill));
  }

  /**
   * Create an agent with the specified skills and role.
   */
  async createAgent(skills: string[], role?: string): Promise<Employee> {
    if (!this.connected) {
      await this.connect();
    }

    // Determine agent type based on skills/role
    const agentType = this.determineAgentType(skills, role);

    switch (agentType) {
      case 'director':
        return this.createDirector(skills, role);
      case 'manager':
        return this.createManager(skills, role);
      default:
        return this.createContributor(skills, role);
    }
  }

  /**
   * Determine what type of agent to create based on skills/role.
   */
  private determineAgentType(skills: string[], role?: string): 'director' | 'manager' | 'contributor' {
    const lowerRole = role?.toLowerCase() ?? '';
    const lowerSkills = skills.map(s => s.toLowerCase());

    // Check for director indicators
    if (
      lowerRole.includes('director') ||
      lowerRole.includes('vp') ||
      lowerRole.includes('executive') ||
      lowerSkills.includes('director') ||
      lowerSkills.includes('strategy')
    ) {
      return 'director';
    }

    // Check for manager indicators
    if (
      lowerRole.includes('manager') ||
      lowerRole.includes('lead') ||
      lowerRole.includes('supervisor') ||
      lowerSkills.includes('manager') ||
      lowerSkills.includes('management') ||
      lowerSkills.includes('leadership')
    ) {
      return 'manager';
    }

    return 'contributor';
  }

  /**
   * Create a Letta Contributor.
   */
  async createContributor(
    skills: string[],
    role?: string,
    config?: Partial<LettaContributorConfig>
  ): Promise<LettaContributor> {
    const contributor = new LettaContributor(this.lettaClient, {
      name: config?.name ?? this.generateName('Worker'),
      role: role ?? config?.role ?? 'Letta Contributor',
      teamId: config?.teamId ?? this.defaultTeamId,
      skills: skills,
      salary: config?.salary ?? 75000,
      systemPrompt: config?.systemPrompt,
      tools: config?.tools ?? this.defaultTools,
      ...config,
    });

    // Initialize the Letta agent
    await contributor.initialize();

    console.log(`[LettaFactory] Created contributor: ${contributor.name}`);
    return contributor;
  }

  /**
   * Create a Letta Manager.
   */
  async createManager(
    skills: string[],
    role?: string,
    config?: Partial<LettaManagerConfig>
  ): Promise<LettaManager> {
    const manager = new LettaManager(this.lettaClient, {
      name: config?.name ?? this.generateName('Lead'),
      role: role ?? config?.role ?? 'Letta Team Lead',
      teamId: config?.teamId ?? this.defaultTeamId,
      skills: ['management', ...skills],
      salary: config?.salary ?? 120000,
      systemPrompt: config?.systemPrompt,
      tools: config?.tools ?? this.defaultTools,
      ...config,
    });

    await manager.initialize();

    console.log(`[LettaFactory] Created manager: ${manager.name}`);
    return manager;
  }

  /**
   * Create a Letta Director.
   */
  async createDirector(
    skills: string[],
    role?: string,
    config?: Partial<LettaDirectorConfig>
  ): Promise<LettaDirector> {
    const director = new LettaDirector(this.lettaClient, {
      name: config?.name ?? this.generateName('VP'),
      role: role ?? config?.role ?? 'Letta VP',
      teamId: config?.teamId ?? this.defaultTeamId,
      skills: ['strategy', 'leadership', ...skills],
      salary: config?.salary ?? 250000,
      systemPrompt: config?.systemPrompt,
      tools: config?.tools ?? this.defaultTools,
      ...config,
    });

    await director.initialize();

    console.log(`[LettaFactory] Created director: ${director.name}`);
    return director;
  }

  /**
   * Generate a random agent name.
   */
  private generateName(suffix: string): string {
    const adjectives = ['Swift', 'Bright', 'Sharp', 'Quick', 'Keen', 'Agile', 'Bold', 'Wise'];
    const nouns = ['Phoenix', 'Falcon', 'Eagle', 'Hawk', 'Owl', 'Raven', 'Wolf', 'Lion'];

    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];

    return `${adj} ${noun} ${suffix}`;
  }

  /**
   * List all Letta agents created by this factory.
   */
  async listAgents(): Promise<Array<{ id: string; name: string }>> {
    const agents = await this.lettaClient.listAgents();
    return agents
      .filter(a => a.name.startsWith('yi-'))
      .map(a => ({ id: a.id, name: a.name }));
  }

  /**
   * Cleanup all Yi agents from Letta server.
   */
  async cleanup(): Promise<void> {
    console.log(`[LettaFactory] Cleaning up Yi agents...`);
    const agents = await this.listAgents();

    for (const agent of agents) {
      try {
        await this.lettaClient.deleteAgent(agent.id);
        console.log(`[LettaFactory] Deleted: ${agent.name}`);
      } catch (error) {
        console.warn(`[LettaFactory] Failed to delete ${agent.name}:`, error);
      }
    }
  }
}
