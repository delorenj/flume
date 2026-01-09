/**
 * Skill Match Selection Strategy
 *
 * Advanced selection strategy that scores candidates based on
 * skill overlap with task requirements. Considers:
 * - Explicit tag matching
 * - Objective keyword matching
 * - Skill proficiency weighting
 *
 * @category Selection
 */

import type { Employee, TaskPayload, SelectionStrategy, Contributor } from '@flume/core';

/**
 * Skill match score result.
 */
export interface SkillMatchScore {
  employee: Employee;
  score: number;
  matchedSkills: string[];
  matchedTags: string[];
  matchedKeywords: string[];
}

/**
 * Configuration for skill matching.
 */
export interface SkillMatchConfig {
  /** Weight for tag matches (default: 3) */
  tagWeight?: number;
  /** Weight for objective keyword matches (default: 1) */
  keywordWeight?: number;
  /** Minimum score required to be considered (default: 0) */
  minimumScore?: number;
  /** Whether to require idle state (default: true) */
  requireIdle?: boolean;
}

/**
 * Default configuration.
 */
export const DEFAULT_SKILL_MATCH_CONFIG: Required<SkillMatchConfig> = {
  tagWeight: 3,
  keywordWeight: 1,
  minimumScore: 0,
  requireIdle: true,
};

/**
 * Skill match selection - selects candidate with best skill overlap.
 *
 * Scoring algorithm:
 * - Each tag match: +tagWeight (default 3)
 * - Each objective keyword match: +keywordWeight (default 1)
 * - Candidate with highest score wins
 * - Ties broken by order (first candidate wins)
 */
export class SkillMatchSelection implements SelectionStrategy {
  readonly name = 'skill-match';
  private config: Required<SkillMatchConfig>;

  constructor(config: SkillMatchConfig = {}) {
    this.config = { ...DEFAULT_SKILL_MATCH_CONFIG, ...config };
  }

  /**
   * Select the best-matching candidate based on skills.
   */
  async select(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<Employee | null> {
    if (candidates.length === 0) {
      console.log(`[SkillMatch] No candidates provided for "${task.objective}"`);
      return null;
    }

    // Score all candidates
    const scores = await this.scoreAllCandidates(task, candidates);

    // Filter by minimum score and availability
    const eligibleScores = scores.filter(s => {
      if (s.score < this.config.minimumScore) return false;
      if (this.config.requireIdle && s.employee.state !== 'idle') return false;
      return true;
    });

    if (eligibleScores.length === 0) {
      console.log(
        `[SkillMatch] No eligible candidate found for "${task.objective}" ` +
        `(${candidates.length} candidates scored, none met criteria)`
      );
      return null;
    }

    // Sort by score descending
    eligibleScores.sort((a, b) => b.score - a.score);

    const best = eligibleScores[0];
    console.log(
      `[SkillMatch] Selected ${best.employee.name} (score: ${best.score}) for "${task.objective}". ` +
      `Matched: tags=[${best.matchedTags.join(', ')}], keywords=[${best.matchedKeywords.join(', ')}]`
    );

    return best.employee;
  }

  /**
   * Score all candidates for a task.
   * Exposed for testing and analysis.
   */
  async scoreAllCandidates(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<SkillMatchScore[]> {
    const scores: SkillMatchScore[] = [];

    for (const candidate of candidates) {
      const score = await this.scoreCandidate(task, candidate);
      scores.push(score);
    }

    return scores;
  }

  /**
   * Score a single candidate for a task.
   */
  async scoreCandidate(
    task: TaskPayload,
    candidate: Employee
  ): Promise<SkillMatchScore> {
    const skills = candidate.skills.map(s => s.toLowerCase());
    const tags = (task.tags ?? []).map(t => t.toLowerCase());
    const objectiveWords = this.extractKeywords(task.objective);

    const matchedTags: string[] = [];
    const matchedKeywords: string[] = [];
    let score = 0;

    // Score tag matches (higher weight)
    for (const tag of tags) {
      if (skills.includes(tag)) {
        matchedTags.push(tag);
        score += this.config.tagWeight;
      }
    }

    // Score objective keyword matches (lower weight)
    for (const word of objectiveWords) {
      if (skills.includes(word)) {
        matchedKeywords.push(word);
        score += this.config.keywordWeight;
      }
    }

    // For Contributors, also check canHandle
    if ('canHandle' in candidate) {
      const contributor = candidate as Contributor;
      const canHandle = await Promise.resolve(contributor.canHandle(task));
      if (!canHandle) {
        // If canHandle returns false, zero out the score
        score = 0;
      }
    }

    return {
      employee: candidate,
      score,
      matchedSkills: [...matchedTags, ...matchedKeywords],
      matchedTags,
      matchedKeywords,
    };
  }

  /**
   * Extract keywords from objective text.
   * Filters out common words and normalizes.
   */
  private extractKeywords(objective: string): string[] {
    // Common words to ignore
    const stopWords = new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
      'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it',
      'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
      'its', 'our', 'their', 'what', 'which', 'who', 'whom', 'when', 'where',
      'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
      'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than',
      'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then',
      'once', 'always', 'never', 'before', 'after', 'above', 'below',
      'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
      'into', 'through', 'during', 'while', 'about', 'against', 'between',
      'without', 'within', 'along', 'following', 'across', 'behind',
      'beyond', 'plus', 'except', 'until', 'unless', 'since', 'because',
      'although', 'though', 'whether', 'however', 'therefore', 'thus',
      'create', 'implement', 'build', 'make', 'write', 'add', 'update',
      'fix', 'change', 'modify', 'test', 'check', 'review', 'help',
    ]);

    // Split on non-word characters and filter
    const words = objective
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    // Remove duplicates
    return [...new Set(words)];
  }

  /**
   * Get detailed scoring breakdown (for debugging/analysis).
   */
  async getDetailedScores(
    task: TaskPayload,
    candidates: Employee[]
  ): Promise<{
    task: { objective: string; tags: string[]; keywords: string[] };
    scores: SkillMatchScore[];
    selected: Employee | null;
  }> {
    const scores = await this.scoreAllCandidates(task, candidates);
    const selected = await this.select(task, candidates);

    return {
      task: {
        objective: task.objective,
        tags: task.tags ?? [],
        keywords: this.extractKeywords(task.objective),
      },
      scores,
      selected,
    };
  }
}
