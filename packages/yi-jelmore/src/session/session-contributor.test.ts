/**
 * Tests for SessionContributor bidirectional communication
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionContributor, type CompletionResult } from './session-contributor.js';

describe('SessionContributor', () => {
  describe('parseOutputForCompletion', () => {
    let contributor: SessionContributor;

    beforeEach(() => {
      contributor = new SessionContributor({
        name: 'Test Contributor',
        completionSignal: 'TASK_COMPLETE',
      });
    });

    it('should return not completed when signal not found', () => {
      const output = ['line 1', 'line 2', 'some output'];
      const result = contributor.parseOutputForCompletion(output);

      expect(result.completed).toBe(false);
      expect(result.output).toEqual(output);
    });

    it('should detect completion signal', () => {
      const output = ['Starting task...', 'Working...', 'TASK_COMPLETE'];
      const result = contributor.parseOutputForCompletion(output);

      expect(result.completed).toBe(true);
      expect(result.output).toEqual(output);
    });

    it('should extract result after completion signal', () => {
      const output = [
        'Working...',
        'TASK_COMPLETE',
        'The task was successful',
      ];
      const result = contributor.parseOutputForCompletion(output);

      expect(result.completed).toBe(true);
      expect(result.result).toBe('The task was successful');
    });

    it('should extract JSON result block', () => {
      const output = [
        'Working...',
        'TASK_COMPLETE',
        '```json',
        '{"status": "success", "files": ["a.ts", "b.ts"]}',
        '```',
      ];
      const result = contributor.parseOutputForCompletion(output);

      expect(result.completed).toBe(true);
      expect(result.result).toBe('{"status": "success", "files": ["a.ts", "b.ts"]}');
    });

    it('should extract RESULT: prefixed content', () => {
      const output = [
        'Working...',
        'TASK_COMPLETE',
        'RESULT:',
        '42 files processed',
        '',
      ];
      const result = contributor.parseOutputForCompletion(output);

      expect(result.completed).toBe(true);
      expect(result.result).toBe('42 files processed');
    });

    it('should handle completion signal with content on same line', () => {
      const output = [
        'Working...',
        'TASK_COMPLETE - all tests passed',
      ];
      const result = contributor.parseOutputForCompletion(output);

      expect(result.completed).toBe(true);
    });

    it('should handle custom completion signal', () => {
      const customContributor = new SessionContributor({
        name: 'Custom Contributor',
        completionSignal: 'DONE',
      });

      const output = ['Working...', 'DONE'];
      const result = customContributor.parseOutputForCompletion(output);

      expect(result.completed).toBe(true);
    });
  });

  describe('parseOutputForError', () => {
    let contributor: SessionContributor;

    beforeEach(() => {
      contributor = new SessionContributor({
        name: 'Test Contributor',
      });
    });

    it('should return null when no errors found', () => {
      const output = ['Starting task...', 'Working...', 'Done'];
      const result = contributor.parseOutputForError(output);

      expect(result).toBeNull();
    });

    it('should detect TASK_FAILED signal', () => {
      const output = ['Working...', 'TASK_FAILED', 'Something went wrong'];
      const result = contributor.parseOutputForError(output);

      expect(result).not.toBeNull();
      expect(result).toContain('TASK_FAILED');
    });

    it('should detect TASK_ERROR signal', () => {
      const output = ['Working...', 'TASK_ERROR: Connection refused'];
      const result = contributor.parseOutputForError(output);

      expect(result).not.toBeNull();
      expect(result).toContain('TASK_ERROR');
    });

    it('should detect Error: prefix', () => {
      const output = ['Working...', 'Error: Cannot find module', 'at line 42'];
      const result = contributor.parseOutputForError(output);

      expect(result).not.toBeNull();
      expect(result).toContain('Cannot find module');
    });

    it('should detect fatal error', () => {
      const output = ['Compiling...', 'fatal error: out of memory'];
      const result = contributor.parseOutputForError(output);

      expect(result).not.toBeNull();
      expect(result).toContain('fatal error');
    });

    it('should detect panic', () => {
      const output = ['Running...', 'panic: runtime error'];
      const result = contributor.parseOutputForError(output);

      expect(result).not.toBeNull();
      expect(result).toContain('panic');
    });

    it('should include context lines after error', () => {
      const output = [
        'Working...',
        'Error: Something failed',
        'at function A',
        'at function B',
        'at function C',
        'at function D',
      ];
      const result = contributor.parseOutputForError(output);

      expect(result).not.toBeNull();
      // Should include error line plus up to 4 more lines
      expect(result).toContain('function A');
      expect(result).toContain('function D');
    });
  });

  describe('configuration', () => {
    it('should use default configuration', () => {
      const contributor = new SessionContributor();

      expect(contributor['pollIntervalMs']).toBe(5000);
      expect(contributor['maxWaitMs']).toBe(600000);
      expect(contributor['waitForCompletion']).toBe(false);
      expect(contributor['completionSignal']).toBe('TASK_COMPLETE');
    });

    it('should accept custom configuration', () => {
      const contributor = new SessionContributor({
        pollIntervalMs: 1000,
        maxWaitMs: 30000,
        waitForCompletion: true,
        completionSignal: 'DONE',
      });

      expect(contributor['pollIntervalMs']).toBe(1000);
      expect(contributor['maxWaitMs']).toBe(30000);
      expect(contributor['waitForCompletion']).toBe(true);
      expect(contributor['completionSignal']).toBe('DONE');
    });
  });

  describe('session manager access', () => {
    it('should provide access to session manager', () => {
      const contributor = new SessionContributor();
      const manager = contributor.getSessionManager();

      expect(manager).toBeDefined();
    });
  });
});
