/**
 * Claude Factory - Creates Claude API-backed agents for Yi
 *
 * Implements AgentFactory to create Contributors, Managers, and Directors
 * powered by Anthropic's Claude API.
 */

import type { Employee } from '@flume/core';
import type { AgentFactory } from '@yi/adapter';
import { ClaudeContributor, type ClaudeContributorConfig } from '../agents/claude-contributor.js';
import { ClaudeManager, type ClaudeManagerConfig } from '../agents/claude-manager.js';
import { ClaudeDirector, type ClaudeDirectorConfig } from '../agents/claude-director.js';

export interface ClaudeFactoryConfig {
  defaultModel?: string;
  defaultTeamId?: string;
  maxTokens?: number;
}

/**
 * Factory for creating Claude API-backed agents.
 */
export class ClaudeFactory implements AgentFactory {
  readonly name = 'claude-factory';

  private defaultModel: string;
  private defaultTeamId: string;
  private maxTokens: number;

  constructor(config: ClaudeFactoryConfig = {}) {
    this.defaultModel = config.defaultModel ?? 'claude-sonnet-4-20250514';
    this.defaultTeamId = config.defaultTeamId ?? 'default';
    this.maxTokens = config.maxTokens ?? 4096;
  }

  /**
   * Check if this factory can create agents with the given skills.
   * Claude can handle most general-purpose needs, especially coding and analysis.
   */
  canCreate(skills: string[]): boolean {
    // Claude excels at these skills
    const claudeStrengths = [
      'coding', 'analysis', 'writing', 'research',
      'general', 'typescript', 'python', 'javascript',
      'documentation', 'review', 'planning'
    ];

    // Prefer Claude if skills match
    const hasClaudeSkill = skills.some(skill =>
      claudeStrengths.includes(skill.toLowerCase())
    );

    // Reject if explicitly requesting another framework
    const excludedSkills = ['letta-native', 'agno-native', 'custom-only'];
    const hasExcluded = skills.some(skill => excludedSkills.includes(skill));

    return hasClaudeSkill || (!hasExcluded && skills.length > 0);
  }

  /**
   * Create an agent with the specified skills and role.
   */
  async createAgent(skills: string[], role?: string): Promise<Employee> {
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
   * Determine what type of agent to create.
   */
  private determineAgentType(skills: string[], role?: string): 'director' | 'manager' | 'contributor' {
    const lowerRole = role?.toLowerCase() ?? '';
    const lowerSkills = skills.map(s => s.toLowerCase());

    if (
      lowerRole.includes('director') ||
      lowerRole.includes('vp') ||
      lowerSkills.includes('director') ||
      lowerSkills.includes('strategy')
    ) {
      return 'director';
    }

    if (
      lowerRole.includes('manager') ||
      lowerRole.includes('lead') ||
      lowerSkills.includes('manager') ||
      lowerSkills.includes('management')
    ) {
      return 'manager';
    }

    return 'contributor';
  }

  /**
   * Create a Claude Contributor.
   */
  createContributor(
    skills: string[],
    role?: string,
    config?: Partial<ClaudeContributorConfig>
  ): ClaudeContributor {
    const contributor = new ClaudeContributor({
      name: config?.name ?? this.generateName('Dev'),
      role: role ?? config?.role ?? 'Claude Contributor',
      teamId: config?.teamId ?? this.defaultTeamId,
      skills,
      salary: config?.salary ?? 80000,
      model: config?.model ?? this.defaultModel,
      maxTokens: config?.maxTokens ?? this.maxTokens,
      ...config,
    });

    console.log(`[ClaudeFactory] Created contributor: ${contributor.name}`);
    return contributor;
  }

  /**
   * Create a Claude Manager.
   */
  createManager(
    skills: string[],
    role?: string,
    config?: Partial<ClaudeManagerConfig>
  ): ClaudeManager {
    const manager = new ClaudeManager({
      name: config?.name ?? this.generateName('Lead'),
      role: role ?? config?.role ?? 'Claude Team Lead',
      teamId: config?.teamId ?? this.defaultTeamId,
      skills: ['management', ...skills],
      salary: config?.salary ?? 130000,
      model: config?.model ?? this.defaultModel,
      maxTokens: config?.maxTokens ?? this.maxTokens,
      ...config,
    });

    console.log(`[ClaudeFactory] Created manager: ${manager.name}`);
    return manager;
  }

  /**
   * Create a Claude Director.
   */
  createDirector(
    skills: string[],
    role?: string,
    config?: Partial<ClaudeDirectorConfig>
  ): ClaudeDirector {
    const director = new ClaudeDirector({
      name: config?.name ?? this.generateName('VP'),
      role: role ?? config?.role ?? 'Claude VP',
      teamId: config?.teamId ?? this.defaultTeamId,
      skills: ['strategy', 'leadership', ...skills],
      salary: config?.salary ?? 280000,
      model: config?.model ?? this.defaultModel,
      ...config,
    });

    console.log(`[ClaudeFactory] Created director: ${director.name}`);
    return director;
  }

  /**
   * Generate a random agent name.
   */
  private generateName(suffix: string): string {
    const adjectives = ['Brilliant', 'Clever', 'Precise', 'Thorough', 'Sharp', 'Quick', 'Astute'];
    const nouns = ['Sage', 'Scholar', 'Analyst', 'Expert', 'Maven', 'Wizard', 'Pro'];

    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];

    return `${adj} ${noun} ${suffix}`;
  }

  /**
   * Get default model.
   */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  /**
   * Set default model.
   */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }
}
