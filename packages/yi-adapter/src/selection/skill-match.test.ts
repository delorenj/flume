/**
 * Unit tests for SkillMatchSelection strategy
 */
import { describe, it, expect, vi } from 'vitest';
import { SkillMatchSelection, DEFAULT_SKILL_MATCH_CONFIG } from './skill-match.js';
import type { Employee, TaskPayload, Contributor, AgentState } from '@flume/core';

/**
 * Create a mock task payload for testing.
 */
function createMockTask(options: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: 'task-123',
    correlationId: 'corr-456',
    objective: 'Test objective',
    context: {},
    createdAt: new Date().toISOString(),
    ...options,
  };
}

/**
 * Create a mock Contributor for testing.
 */
function createMockContributor(
  name: string,
  skills: string[] = [],
  canHandle: boolean | (() => boolean | Promise<boolean>) = true,
  state: AgentState = 'idle'
): Contributor {
  const canHandleFn = typeof canHandle === 'function' ? canHandle : () => canHandle;
  return {
    id: `contrib-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    role: 'contributor',
    teamId: 'team-1',
    skills,
    salary: 50000,
    state,
    canHandle: vi.fn(canHandleFn),
    execute: vi.fn(),
    reportStatus: vi.fn(),
  };
}

/**
 * Create a mock Employee (non-Contributor) for testing.
 */
function createMockEmployee(
  name: string,
  skills: string[] = [],
  state: AgentState = 'idle'
): Employee {
  return {
    id: `emp-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    role: 'manager',
    teamId: 'team-1',
    skills,
    salary: 75000,
    state,
    reportStatus: vi.fn(),
  };
}

describe('SkillMatchSelection', () => {
  describe('DEFAULT_SKILL_MATCH_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_SKILL_MATCH_CONFIG.tagWeight).toBe(3);
      expect(DEFAULT_SKILL_MATCH_CONFIG.keywordWeight).toBe(1);
      expect(DEFAULT_SKILL_MATCH_CONFIG.minimumScore).toBe(0);
      expect(DEFAULT_SKILL_MATCH_CONFIG.requireIdle).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const strategy = new SkillMatchSelection();
      expect(strategy.name).toBe('skill-match');
    });

    it('should allow custom config', () => {
      const strategy = new SkillMatchSelection({
        tagWeight: 5,
        keywordWeight: 2,
        minimumScore: 3,
        requireIdle: false,
      });
      expect(strategy.name).toBe('skill-match');
    });
  });

  describe('select', () => {
    it('should return null for empty candidates array', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask();

      const result = await strategy.select(task, []);

      expect(result).toBeNull();
    });

    it('should select candidate with matching tag skills', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Build a feature',
        tags: ['typescript', 'react'],
      });

      const candidates = [
        createMockContributor('Python Dev', ['python', 'django']),
        createMockContributor('TypeScript Dev', ['typescript', 'nodejs']),
        createMockContributor('Full Stack', ['typescript', 'react', 'nodejs']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Full Stack'); // Has both typescript and react
    });

    it('should select candidate with matching objective keywords', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Implement authentication with OAuth and JWT',
      });

      const candidates = [
        createMockContributor('Frontend Dev', ['react', 'css']),
        createMockContributor('Security Dev', ['oauth', 'jwt', 'security']),
        createMockContributor('Backend Dev', ['nodejs', 'express']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Security Dev');
    });

    it('should prioritize tag matches over keyword matches', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Build API with python backend',
        tags: ['python'],
      });

      const candidates = [
        // Has keyword match (python in objective) but not tag match
        createMockContributor('API Dev', ['api', 'rest']),
        // Has tag match
        createMockContributor('Python Dev', ['python']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('Python Dev');
    });

    it('should return null when no candidate meets minimum score', async () => {
      const strategy = new SkillMatchSelection({ minimumScore: 5 });
      const task = createMockTask({
        objective: 'Build feature',
        tags: ['typescript'],
      });

      const candidates = [
        // Score: 1 keyword match = 1 point (below minimum 5)
        createMockContributor('Junior Dev', ['javascript']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result).toBeNull();
    });

    it('should skip non-idle candidates when requireIdle is true', async () => {
      const strategy = new SkillMatchSelection({ requireIdle: true });
      const task = createMockTask({
        tags: ['typescript'],
      });

      const candidates = [
        createMockContributor('Busy Dev', ['typescript', 'react'], true, 'working'),
        createMockContributor('Available Dev', ['typescript']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('Available Dev');
    });

    it('should include non-idle candidates when requireIdle is false', async () => {
      const strategy = new SkillMatchSelection({ requireIdle: false });
      const task = createMockTask({
        tags: ['typescript', 'react'],
      });

      const candidates = [
        createMockContributor('Busy Expert', ['typescript', 'react'], true, 'working'),
        createMockContributor('Available Junior', ['typescript']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('Busy Expert'); // Higher score wins
    });

    it('should respect canHandle returning false', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        tags: ['typescript'],
      });

      const candidates = [
        // Skills match but canHandle returns false
        createMockContributor('Unavailable Expert', ['typescript', 'react'], false),
        createMockContributor('Available Junior', ['typescript']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('Available Junior');
    });

    it('should handle async canHandle', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        tags: ['typescript'],
      });

      const asyncCanHandle = async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return true;
      };

      const candidates = [
        createMockContributor('Async Dev', ['typescript'], asyncCanHandle),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('Async Dev');
    });

    it('should handle non-Contributor employees', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        tags: ['management'],
      });

      const candidates = [
        createMockEmployee('Manager', ['management', 'planning']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('Manager');
    });

    it('should skip non-idle non-Contributor employees', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        tags: ['management'],
      });

      const candidates = [
        createMockEmployee('Busy Manager', ['management'], 'working'),
        createMockContributor('Available Dev', ['typescript']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('Available Dev');
    });
  });

  describe('scoreCandidate', () => {
    it('should score tag matches with tagWeight', async () => {
      const strategy = new SkillMatchSelection({ tagWeight: 3 });
      const task = createMockTask({ tags: ['typescript', 'react'] });
      const candidate = createMockContributor('Dev', ['typescript', 'react']);

      const score = await strategy.scoreCandidate(task, candidate);

      expect(score.score).toBe(6); // 2 tags × 3 weight
      expect(score.matchedTags).toEqual(['typescript', 'react']);
    });

    it('should score keyword matches with keywordWeight', async () => {
      const strategy = new SkillMatchSelection({ keywordWeight: 1 });
      const task = createMockTask({ objective: 'Build typescript application' });
      const candidate = createMockContributor('Dev', ['typescript', 'application']);

      const score = await strategy.scoreCandidate(task, candidate);

      expect(score.matchedKeywords).toContain('typescript');
      expect(score.matchedKeywords).toContain('application');
    });

    it('should combine tag and keyword scores', async () => {
      const strategy = new SkillMatchSelection({ tagWeight: 3, keywordWeight: 1 });
      const task = createMockTask({
        objective: 'Build application with typescript',
        tags: ['typescript'],
      });
      const candidate = createMockContributor('Dev', ['typescript', 'application']);

      const score = await strategy.scoreCandidate(task, candidate);

      // 1 tag (typescript) × 3 + 1 keyword (application) × 1 = 4
      // Note: typescript is counted as tag, not keyword
      expect(score.score).toBeGreaterThanOrEqual(3);
      expect(score.matchedTags).toContain('typescript');
    });

    it('should zero out score when canHandle returns false', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({ tags: ['typescript'] });
      const candidate = createMockContributor('Dev', ['typescript'], false);

      const score = await strategy.scoreCandidate(task, candidate);

      expect(score.score).toBe(0);
    });

    it('should handle case insensitive matching', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({ tags: ['TypeScript', 'REACT'] });
      const candidate = createMockContributor('Dev', ['typescript', 'react']);

      const score = await strategy.scoreCandidate(task, candidate);

      expect(score.matchedTags).toEqual(['typescript', 'react']);
    });
  });

  describe('scoreAllCandidates', () => {
    it('should score all candidates', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({ tags: ['typescript'] });
      const candidates = [
        createMockContributor('Expert', ['typescript', 'react']),
        createMockContributor('Junior', ['javascript']),
      ];

      const scores = await strategy.scoreAllCandidates(task, candidates);

      expect(scores).toHaveLength(2);
      expect(scores[0].employee.name).toBe('Expert');
      expect(scores[0].score).toBeGreaterThan(scores[1].score);
    });
  });

  describe('getDetailedScores', () => {
    it('should return detailed breakdown', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Build API with typescript',
        tags: ['typescript'],
      });
      const candidates = [createMockContributor('Dev', ['typescript', 'api'])];

      const result = await strategy.getDetailedScores(task, candidates);

      expect(result.task.objective).toBe('Build API with typescript');
      expect(result.task.tags).toEqual(['typescript']);
      expect(result.task.keywords).toContain('api');
      expect(result.scores).toHaveLength(1);
      expect(result.selected?.name).toBe('Dev');
    });
  });

  describe('keyword extraction', () => {
    it('should filter out common stop words', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'The quick brown fox jumps over the lazy dog with typescript',
      });
      const candidate = createMockContributor('Dev', ['quick', 'brown', 'fox', 'typescript']);

      const scores = await strategy.getDetailedScores(task, [candidate]);

      // 'the', 'over', 'with' should be filtered as stop words
      expect(scores.task.keywords).not.toContain('the');
      expect(scores.task.keywords).not.toContain('over');
      expect(scores.task.keywords).not.toContain('with');
      // These should be included
      expect(scores.task.keywords).toContain('quick');
      expect(scores.task.keywords).toContain('typescript');
    });

    it('should filter out action words like create, implement', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Create and implement authentication system',
      });

      const scores = await strategy.getDetailedScores(task, []);

      expect(scores.task.keywords).not.toContain('create');
      expect(scores.task.keywords).not.toContain('implement');
      expect(scores.task.keywords).toContain('authentication');
      expect(scores.task.keywords).toContain('system');
    });

    it('should filter out short words (< 3 chars)', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Do it now or go to api',
      });

      const scores = await strategy.getDetailedScores(task, []);

      expect(scores.task.keywords).not.toContain('do');
      expect(scores.task.keywords).not.toContain('it');
      expect(scores.task.keywords).not.toContain('or');
      expect(scores.task.keywords).not.toContain('go');
      expect(scores.task.keywords).not.toContain('to');
      expect(scores.task.keywords).toContain('api');
    });

    it('should remove duplicate keywords', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Build typescript app with typescript framework',
      });

      const scores = await strategy.getDetailedScores(task, []);

      const typescriptCount = scores.task.keywords.filter(k => k === 'typescript').length;
      expect(typescriptCount).toBe(1);
    });
  });

  describe('tie breaking', () => {
    it('should select first candidate when scores are tied', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({ tags: ['typescript'] });

      const candidates = [
        createMockContributor('First Dev', ['typescript']),
        createMockContributor('Second Dev', ['typescript']),
      ];

      const result = await strategy.select(task, candidates);

      expect(result?.name).toBe('First Dev');
    });
  });

  describe('edge cases', () => {
    it('should handle task with no tags or meaningful keywords', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        objective: 'Do the thing',
        tags: [],
      });

      const candidates = [createMockContributor('Dev', ['typescript'])];

      const result = await strategy.select(task, candidates);

      // Should still select since canHandle returns true and score meets minimum (0)
      expect(result?.name).toBe('Dev');
    });

    it('should handle candidate with no skills', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        tags: ['typescript'],
      });

      const candidates = [createMockContributor('Newbie', [])];

      const result = await strategy.select(task, candidates);

      // Should be selected since canHandle returns true and minimum score is 0
      expect(result?.name).toBe('Newbie');
    });

    it('should handle mixed contributors and employees', async () => {
      const strategy = new SkillMatchSelection();
      const task = createMockTask({
        tags: ['typescript', 'management'],
      });

      const candidates = [
        createMockEmployee('Manager', ['management']),
        createMockContributor('Dev', ['typescript', 'react']),
        createMockContributor('Expert', ['typescript', 'management']),
      ];

      const result = await strategy.select(task, candidates);

      // Expert has both skills, highest score
      expect(result?.name).toBe('Expert');
    });
  });

  describe('custom weights', () => {
    it('should apply custom tag weight', async () => {
      const strategy = new SkillMatchSelection({ tagWeight: 10 });
      const task = createMockTask({ tags: ['typescript'] });
      const candidate = createMockContributor('Dev', ['typescript']);

      const score = await strategy.scoreCandidate(task, candidate);

      expect(score.score).toBe(10);
    });

    it('should apply custom keyword weight', async () => {
      const strategy = new SkillMatchSelection({ keywordWeight: 5 });
      const task = createMockTask({ objective: 'Build application' });
      const candidate = createMockContributor('Dev', ['application']);

      const score = await strategy.scoreCandidate(task, candidate);

      expect(score.matchedKeywords).toContain('application');
      expect(score.score).toBe(5);
    });
  });
});
