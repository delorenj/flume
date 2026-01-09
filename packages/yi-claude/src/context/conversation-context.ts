/**
 * Conversation Context - Token-aware context window management for Claude
 *
 * Tracks token usage and automatically truncates when approaching limits.
 * Supports configurable retention strategies.
 */

import { EventEmitter } from 'events';

/**
 * A message in the conversation history.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Estimated token count for this message */
  tokenCount: number;
  /** When this message was added */
  timestamp: Date;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Context truncation event data.
 */
export interface TruncationEvent {
  /** Number of messages removed */
  messagesRemoved: number;
  /** Total tokens removed */
  tokensRemoved: number;
  /** Tokens remaining after truncation */
  tokensRemaining: number;
  /** Strategy used for truncation */
  strategy: TruncationStrategy;
  /** Timestamp of truncation */
  timestamp: Date;
}

/**
 * Context window statistics.
 */
export interface ContextStats {
  /** Total messages in context */
  messageCount: number;
  /** Total estimated tokens */
  totalTokens: number;
  /** User message tokens */
  userTokens: number;
  /** Assistant message tokens */
  assistantTokens: number;
  /** System message tokens */
  systemTokens: number;
  /** Percentage of context window used */
  usagePercent: number;
  /** Estimated tokens remaining */
  tokensRemaining: number;
}

/**
 * Strategy for truncating context when approaching limits.
 */
export type TruncationStrategy =
  | 'sliding_window' // Remove oldest messages first
  | 'keep_recent' // Keep N most recent messages
  | 'keep_first_last' // Keep first and last N messages
  | 'smart'; // Attempt to keep important context

/**
 * Configuration for ConversationContext.
 */
export interface ConversationContextConfig {
  /** Maximum tokens allowed in context window (default: 128000 for Claude 3) */
  maxTokens?: number;
  /** Threshold (0-1) at which to trigger truncation (default: 0.9) */
  truncationThreshold?: number;
  /** Strategy for truncation (default: 'sliding_window') */
  truncationStrategy?: TruncationStrategy;
  /** Number of messages to keep with 'keep_recent' strategy (default: 10) */
  keepRecentCount?: number;
  /** Average chars per token for estimation (default: 4) */
  charsPerToken?: number;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Event types emitted by ConversationContext.
 */
export interface ConversationContextEvents {
  /** Emitted when context is truncated */
  truncated: (event: TruncationEvent) => void;
  /** Emitted when approaching truncation threshold */
  warning: (usage: ContextStats) => void;
  /** Emitted when message is added */
  messageAdded: (message: ConversationMessage) => void;
  /** Emitted when context is cleared */
  cleared: () => void;
}

/**
 * Manages conversation context with token-aware truncation.
 */
export class ConversationContext extends EventEmitter {
  private messages: ConversationMessage[] = [];
  private systemMessage?: ConversationMessage;
  private maxTokens: number;
  private truncationThreshold: number;
  private truncationStrategy: TruncationStrategy;
  private keepRecentCount: number;
  private charsPerToken: number;
  private verbose: boolean;
  private _totalTruncations: number = 0;
  private _totalTokensTruncated: number = 0;

  constructor(config: ConversationContextConfig = {}) {
    super();
    this.maxTokens = config.maxTokens ?? 128000; // Claude 3 default
    this.truncationThreshold = config.truncationThreshold ?? 0.9;
    this.truncationStrategy = config.truncationStrategy ?? 'sliding_window';
    this.keepRecentCount = config.keepRecentCount ?? 10;
    this.charsPerToken = config.charsPerToken ?? 4;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Estimate token count for a string.
   * Uses simple character-based estimation (4 chars ≈ 1 token for English).
   */
  estimateTokens(text: string): number {
    // Simple estimation: ~4 chars per token for English text
    // This is a rough estimate; for production, use tiktoken or Claude's tokenizer
    return Math.ceil(text.length / this.charsPerToken);
  }

  /**
   * Set the system message (persisted across truncations).
   */
  setSystemMessage(content: string): void {
    const tokenCount = this.estimateTokens(content);
    this.systemMessage = {
      role: 'system',
      content,
      tokenCount,
      timestamp: new Date(),
    };
    this.log(`System message set (${tokenCount} tokens)`);
  }

  /**
   * Get the current system message.
   */
  getSystemMessage(): string | undefined {
    return this.systemMessage?.content;
  }

  /**
   * Add a message to the conversation.
   */
  addMessage(
    role: 'user' | 'assistant',
    content: string,
    metadata?: Record<string, unknown>
  ): ConversationMessage {
    const tokenCount = this.estimateTokens(content);
    const message: ConversationMessage = {
      role,
      content,
      tokenCount,
      timestamp: new Date(),
      metadata,
    };

    this.messages.push(message);
    this.emit('messageAdded', message);
    this.log(`Added ${role} message (${tokenCount} tokens)`);

    // Check if we need to truncate
    this.checkAndTruncate();

    return message;
  }

  /**
   * Add a user message.
   */
  addUserMessage(content: string, metadata?: Record<string, unknown>): ConversationMessage {
    return this.addMessage('user', content, metadata);
  }

  /**
   * Add an assistant message.
   */
  addAssistantMessage(content: string, metadata?: Record<string, unknown>): ConversationMessage {
    return this.addMessage('assistant', content, metadata);
  }

  /**
   * Update token counts from actual API usage.
   * Call this after receiving response with actual token counts.
   */
  updateActualTokens(inputTokens: number, _outputTokens: number): void {
    // Update the last assistant message with actual output tokens
    const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      // We don't have per-message tokens from API, but we can log for reference
      this.log(`Actual API usage: input=${inputTokens}, output=${_outputTokens}`);
    }
  }

  /**
   * Get current context statistics.
   */
  getStats(): ContextStats {
    const userTokens = this.messages
      .filter((m) => m.role === 'user')
      .reduce((sum, m) => sum + m.tokenCount, 0);

    const assistantTokens = this.messages
      .filter((m) => m.role === 'assistant')
      .reduce((sum, m) => sum + m.tokenCount, 0);

    const systemTokens = this.systemMessage?.tokenCount ?? 0;
    const totalTokens = userTokens + assistantTokens + systemTokens;

    return {
      messageCount: this.messages.length + (this.systemMessage ? 1 : 0),
      totalTokens,
      userTokens,
      assistantTokens,
      systemTokens,
      usagePercent: (totalTokens / this.maxTokens) * 100,
      tokensRemaining: this.maxTokens - totalTokens,
    };
  }

  /**
   * Get all messages for API call (excluding system message).
   */
  getMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
  }

  /**
   * Get full messages with metadata.
   */
  getFullMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  /**
   * Check if truncation is needed and perform it.
   */
  private checkAndTruncate(): void {
    const stats = this.getStats();
    const thresholdTokens = this.maxTokens * this.truncationThreshold;

    // Emit warning when approaching threshold
    if (stats.totalTokens > this.maxTokens * 0.8) {
      this.emit('warning', stats);
    }

    // Perform truncation if over threshold
    if (stats.totalTokens > thresholdTokens) {
      this.truncate();
    }
  }

  /**
   * Perform truncation based on configured strategy.
   */
  truncate(): TruncationEvent {
    const beforeStats = this.getStats();
    let removedMessages: ConversationMessage[] = [];

    switch (this.truncationStrategy) {
      case 'sliding_window':
        removedMessages = this.truncateSlidingWindow();
        break;
      case 'keep_recent':
        removedMessages = this.truncateKeepRecent();
        break;
      case 'keep_first_last':
        removedMessages = this.truncateKeepFirstLast();
        break;
      case 'smart':
        removedMessages = this.truncateSmart();
        break;
    }

    const afterStats = this.getStats();
    const tokensRemoved = beforeStats.totalTokens - afterStats.totalTokens;

    const event: TruncationEvent = {
      messagesRemoved: removedMessages.length,
      tokensRemoved,
      tokensRemaining: afterStats.tokensRemaining,
      strategy: this.truncationStrategy,
      timestamp: new Date(),
    };

    this._totalTruncations++;
    this._totalTokensTruncated += tokensRemoved;

    this.log(
      `Truncated: removed ${event.messagesRemoved} messages (${tokensRemoved} tokens). ` +
        `Remaining: ${afterStats.totalTokens} tokens (${afterStats.usagePercent.toFixed(1)}%)`
    );

    this.emit('truncated', event);
    return event;
  }

  /**
   * Sliding window: remove oldest messages first until under threshold.
   */
  private truncateSlidingWindow(): ConversationMessage[] {
    const targetTokens = this.maxTokens * (this.truncationThreshold - 0.1);
    const removed: ConversationMessage[] = [];

    while (this.messages.length > 2 && this.getStats().totalTokens > targetTokens) {
      const oldest = this.messages.shift();
      if (oldest) removed.push(oldest);
    }

    return removed;
  }

  /**
   * Keep recent: remove all but the N most recent messages.
   */
  private truncateKeepRecent(): ConversationMessage[] {
    if (this.messages.length <= this.keepRecentCount) {
      return [];
    }

    const removed = this.messages.splice(0, this.messages.length - this.keepRecentCount);
    return removed;
  }

  /**
   * Keep first and last: keep first N and last N messages.
   */
  private truncateKeepFirstLast(): ConversationMessage[] {
    const keepCount = Math.floor(this.keepRecentCount / 2);
    if (this.messages.length <= keepCount * 2) {
      return [];
    }

    const first = this.messages.slice(0, keepCount);
    const last = this.messages.slice(-keepCount);
    const removed = this.messages.slice(keepCount, -keepCount);

    this.messages = [...first, ...last];
    return removed;
  }

  /**
   * Smart truncation: attempt to keep important context.
   * Removes middle messages, keeps first (context) and recent (relevant).
   */
  private truncateSmart(): ConversationMessage[] {
    // For now, smart is similar to keep_first_last but with dynamic counts
    const targetTokens = this.maxTokens * (this.truncationThreshold - 0.1);
    const stats = this.getStats();

    if (stats.totalTokens <= targetTokens) {
      return [];
    }

    // Keep first 2 messages (initial context) and as many recent as fit
    const first = this.messages.slice(0, 2);
    const firstTokens = first.reduce((sum, m) => sum + m.tokenCount, 0);
    const systemTokens = this.systemMessage?.tokenCount ?? 0;
    const availableTokens = targetTokens - firstTokens - systemTokens;

    // Add recent messages until we run out of tokens
    const recent: ConversationMessage[] = [];
    let recentTokens = 0;

    for (let i = this.messages.length - 1; i >= 2; i--) {
      const msg = this.messages[i];
      if (recentTokens + msg.tokenCount > availableTokens) break;
      recent.unshift(msg);
      recentTokens += msg.tokenCount;
    }

    const removed = this.messages.slice(2, this.messages.length - recent.length);
    this.messages = [...first, ...recent];

    return removed;
  }

  /**
   * Clear all messages (but keep system message).
   */
  clear(): void {
    this.messages = [];
    this.log('Conversation context cleared');
    this.emit('cleared');
  }

  /**
   * Reset everything including system message.
   */
  reset(): void {
    this.messages = [];
    this.systemMessage = undefined;
    this._totalTruncations = 0;
    this._totalTokensTruncated = 0;
    this.log('Conversation context reset');
    this.emit('cleared');
  }

  /**
   * Get total number of truncations performed.
   */
  get totalTruncations(): number {
    return this._totalTruncations;
  }

  /**
   * Get total tokens truncated.
   */
  get totalTokensTruncated(): number {
    return this._totalTokensTruncated;
  }

  /**
   * Get maximum tokens allowed.
   */
  get maxContextTokens(): number {
    return this.maxTokens;
  }

  /**
   * Set maximum tokens.
   */
  setMaxTokens(tokens: number): void {
    this.maxTokens = tokens;
    this.checkAndTruncate();
  }

  /**
   * Get truncation strategy.
   */
  get strategy(): TruncationStrategy {
    return this.truncationStrategy;
  }

  /**
   * Set truncation strategy.
   */
  setStrategy(strategy: TruncationStrategy): void {
    this.truncationStrategy = strategy;
  }

  /**
   * Check if context is approaching limit.
   */
  isApproachingLimit(): boolean {
    const stats = this.getStats();
    return stats.usagePercent > 80;
  }

  /**
   * Check if context will fit additional tokens.
   */
  canFit(additionalTokens: number): boolean {
    const stats = this.getStats();
    return stats.totalTokens + additionalTokens <= this.maxTokens;
  }

  /**
   * Log message if verbose mode enabled.
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(`[ConversationContext] ${message}`);
    }
  }

  // TypeScript event emitter typing
  on<E extends keyof ConversationContextEvents>(
    event: E,
    listener: ConversationContextEvents[E]
  ): this {
    return super.on(event, listener);
  }

  emit<E extends keyof ConversationContextEvents>(
    event: E,
    ...args: Parameters<ConversationContextEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Default context window sizes for different Claude models.
 */
export const CLAUDE_CONTEXT_WINDOWS = {
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-2.1': 200000,
  'claude-2.0': 100000,
  'claude-instant': 100000,
} as const;

/**
 * Create a ConversationContext configured for a specific model.
 */
export function createContextForModel(
  model: keyof typeof CLAUDE_CONTEXT_WINDOWS,
  config?: Omit<ConversationContextConfig, 'maxTokens'>
): ConversationContext {
  return new ConversationContext({
    ...config,
    maxTokens: CLAUDE_CONTEXT_WINDOWS[model],
  });
}
