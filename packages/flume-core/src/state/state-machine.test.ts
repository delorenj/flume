/**
 * Unit tests for AgentStateMachine
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AgentStateMachine,
  StateMachineError,
  TransitionGuard,
  isBusyState,
  isTerminalState,
  canAcceptTask,
  needsAttention,
  getStateDescription,
  getSuggestedNextStates,
  DEFAULT_STATE_MACHINE_CONFIG,
} from './state-machine.js';
import { AgentState } from '../types/state.js';

describe('AgentStateMachine', () => {
  let machine: AgentStateMachine;

  beforeEach(() => {
    machine = new AgentStateMachine('emp-123');
  });

  afterEach(() => {
    machine.dispose();
  });

  describe('constructor', () => {
    it('should initialize with default state', () => {
      expect(machine.getState()).toBe('initializing');
    });

    it('should initialize with custom initial state', () => {
      const customMachine = new AgentStateMachine('emp-456', 'idle');
      expect(customMachine.getState()).toBe('idle');
      customMachine.dispose();
    });

    it('should use default config values', () => {
      expect(DEFAULT_STATE_MACHINE_CONFIG.workingTimeoutMs).toBe(30 * 60 * 1000);
      expect(DEFAULT_STATE_MACHINE_CONFIG.delegatingTimeoutMs).toBe(60 * 60 * 1000);
      expect(DEFAULT_STATE_MACHINE_CONFIG.blockedTimeoutMs).toBe(24 * 60 * 60 * 1000);
      expect(DEFAULT_STATE_MACHINE_CONFIG.maxErrorRetries).toBe(3);
    });
  });

  describe('getState', () => {
    it('should return current state', () => {
      expect(machine.getState()).toBe('initializing');
    });
  });

  describe('getTimeInState', () => {
    it('should return time spent in current state', async () => {
      const timeInState = machine.getTimeInState();
      expect(timeInState).toBeGreaterThanOrEqual(0);
      expect(timeInState).toBeLessThan(1000);
    });
  });

  describe('getHistory', () => {
    it('should start with empty history', () => {
      expect(machine.getHistory()).toHaveLength(0);
    });

    it('should track transitions in history', async () => {
      await machine.transition('onboarding', 'context_loaded');
      await machine.transition('idle', 'onboarding_complete');

      const history = machine.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].fromState).toBe('initializing');
      expect(history[0].toState).toBe('onboarding');
      expect(history[1].fromState).toBe('onboarding');
      expect(history[1].toState).toBe('idle');
    });

    it('should return readonly history', () => {
      const history = machine.getHistory();
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('canTransition', () => {
    it('should allow valid transitions from initializing', () => {
      expect(machine.canTransition('onboarding')).toBe(true);
      expect(machine.canTransition('errored')).toBe(true);
      expect(machine.canTransition('terminated')).toBe(true);
    });

    it('should reject invalid transitions from initializing', () => {
      expect(machine.canTransition('working')).toBe(false);
      expect(machine.canTransition('idle')).toBe(false);
    });

    it('should allow valid transitions from idle', async () => {
      await machine.transition('onboarding', 'loaded');
      await machine.transition('idle', 'ready');

      expect(machine.canTransition('working')).toBe(true);
      expect(machine.canTransition('delegating')).toBe(true);
      expect(machine.canTransition('errored')).toBe(true);
      expect(machine.canTransition('terminated')).toBe(true);
    });
  });

  describe('getValidTransitions', () => {
    it('should return valid transitions from current state', () => {
      const valid = machine.getValidTransitions();
      expect(valid).toContain('onboarding');
      expect(valid).toContain('errored');
      expect(valid).toContain('terminated');
    });

    it('should return empty array from terminated', async () => {
      await machine.forceTerminate('test');
      expect(machine.getValidTransitions()).toHaveLength(0);
    });
  });

  describe('transition', () => {
    it('should transition to valid state', async () => {
      const transition = await machine.transition('onboarding', 'context_loaded');

      expect(machine.getState()).toBe('onboarding');
      expect(transition.fromState).toBe('initializing');
      expect(transition.toState).toBe('onboarding');
      expect(transition.trigger).toBe('context_loaded');
      expect(transition.employeeId).toBe('emp-123');
    });

    it('should throw StateMachineError for invalid transition', async () => {
      await expect(machine.transition('working', 'invalid'))
        .rejects.toThrow(StateMachineError);
    });

    it('should include error message in StateMachineError', async () => {
      try {
        await machine.transition('working', 'invalid');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StateMachineError);
        const error = err as StateMachineError;
        expect(error.from).toBe('initializing');
        expect(error.to).toBe('working');
        expect(error.message).toContain('Invalid transition');
      }
    });

    it('should store taskId in transition', async () => {
      await machine.transition('onboarding', 'loaded');
      await machine.transition('idle', 'ready');
      const transition = await machine.transition('working', 'task_assigned', {
        taskId: 'task-123',
      });

      expect(transition.taskId).toBe('task-123');
    });

    it('should store error in transition', async () => {
      await machine.transition('onboarding', 'loaded');
      await machine.transition('idle', 'ready');
      await machine.transition('working', 'task_assigned');

      const transition = await machine.transition('errored', 'error_occurred', {
        error: 'Something went wrong',
      });

      expect(transition.error).toBe('Something went wrong');
    });

    it('should call onTransition callback', async () => {
      const onTransition = vi.fn();
      const customMachine = new AgentStateMachine('emp-456', 'initializing', {
        onTransition,
      });

      await customMachine.transition('onboarding', 'loaded');

      expect(onTransition).toHaveBeenCalledOnce();
      expect(onTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          fromState: 'initializing',
          toState: 'onboarding',
        })
      );

      customMachine.dispose();
    });

    it('should call onInvalidTransition callback', async () => {
      const onInvalidTransition = vi.fn();
      const customMachine = new AgentStateMachine('emp-456', 'initializing', {
        onInvalidTransition,
      });

      await expect(customMachine.transition('working', 'invalid')).rejects.toThrow();

      expect(onInvalidTransition).toHaveBeenCalledOnce();
      expect(onInvalidTransition).toHaveBeenCalledWith(
        'initializing',
        'working',
        expect.objectContaining({ trigger: 'invalid' })
      );

      customMachine.dispose();
    });
  });

  describe('transition guards', () => {
    it('should run guards and allow transition if all pass', async () => {
      const guard: TransitionGuard = vi.fn().mockReturnValue(true);
      const customMachine = new AgentStateMachine('emp-456', 'initializing', {
        guards: [guard],
      });

      await customMachine.transition('onboarding', 'loaded');

      expect(guard).toHaveBeenCalled();
      expect(customMachine.getState()).toBe('onboarding');

      customMachine.dispose();
    });

    it('should block transition if guard returns false', async () => {
      const guard: TransitionGuard = vi.fn().mockReturnValue(false);
      const customMachine = new AgentStateMachine('emp-456', 'initializing', {
        guards: [guard],
      });

      await expect(customMachine.transition('onboarding', 'loaded'))
        .rejects.toThrow('blocked by guard');

      expect(customMachine.getState()).toBe('initializing');

      customMachine.dispose();
    });

    it('should support async guards', async () => {
      const guard: TransitionGuard = vi.fn().mockResolvedValue(true);
      const customMachine = new AgentStateMachine('emp-456', 'initializing', {
        guards: [guard],
      });

      await customMachine.transition('onboarding', 'loaded');

      expect(guard).toHaveBeenCalled();
      expect(customMachine.getState()).toBe('onboarding');

      customMachine.dispose();
    });

    it('should run multiple guards in order', async () => {
      const callOrder: number[] = [];
      const guard1: TransitionGuard = vi.fn(() => {
        callOrder.push(1);
        return true;
      });
      const guard2: TransitionGuard = vi.fn(() => {
        callOrder.push(2);
        return true;
      });

      const customMachine = new AgentStateMachine('emp-456', 'initializing', {
        guards: [guard1, guard2],
      });

      await customMachine.transition('onboarding', 'loaded');

      expect(callOrder).toEqual([1, 2]);

      customMachine.dispose();
    });
  });

  describe('error recovery', () => {
    beforeEach(async () => {
      // Get to errored state
      await machine.transition('onboarding', 'loaded');
      await machine.transition('idle', 'ready');
      await machine.transition('working', 'task_assigned');
      await machine.transition('errored', 'error_occurred');
    });

    it('should recover from errored state', async () => {
      const recovered = await machine.attemptErrorRecovery();

      expect(recovered).toBe(true);
      expect(machine.getState()).toBe('idle');
    });

    it('should track retry count', async () => {
      expect(machine.getErrorRetryCount()).toBe(0);

      await machine.attemptErrorRecovery();
      expect(machine.getErrorRetryCount()).toBe(1);

      // Back to errored
      await machine.transition('working', 'task_assigned');
      await machine.transition('errored', 'error_again');

      await machine.attemptErrorRecovery();
      expect(machine.getErrorRetryCount()).toBe(2);
    });

    it('should fail recovery after max retries', async () => {
      const customMachine = new AgentStateMachine('emp-456', 'errored', {
        maxErrorRetries: 2,
      });

      expect(await customMachine.attemptErrorRecovery()).toBe(true); // 1
      await customMachine.transition('errored', 'error');

      expect(await customMachine.attemptErrorRecovery()).toBe(true); // 2
      await customMachine.transition('errored', 'error');

      expect(await customMachine.attemptErrorRecovery()).toBe(false); // 3 - exceeds max

      customMachine.dispose();
    });

    it('should return false if not in errored state', async () => {
      const idleMachine = new AgentStateMachine('emp-456', 'idle');
      const result = await idleMachine.attemptErrorRecovery();
      expect(result).toBe(false);
      idleMachine.dispose();
    });

    it('should reset retry count when entering idle normally', async () => {
      await machine.attemptErrorRecovery(); // retry count = 1
      expect(machine.getErrorRetryCount()).toBe(1);

      // Normal workflow resets count
      await machine.transition('working', 'task');
      await machine.transition('idle', 'done');

      expect(machine.getErrorRetryCount()).toBe(0);
    });
  });

  describe('forceTerminate', () => {
    it('should terminate from any state', async () => {
      const transition = await machine.forceTerminate('emergency_stop');

      expect(machine.getState()).toBe('terminated');
      expect(transition.trigger).toBe('emergency_stop');
    });

    it('should terminate from working state', async () => {
      await machine.transition('onboarding', 'loaded');
      await machine.transition('idle', 'ready');
      await machine.transition('working', 'task');

      await machine.forceTerminate('user_request');

      expect(machine.getState()).toBe('terminated');
    });

    it('should throw if already terminated', async () => {
      await machine.forceTerminate('first');

      await expect(machine.forceTerminate('second'))
        .rejects.toThrow('already terminated');
    });

    it('should record termination in history', async () => {
      await machine.forceTerminate('shutdown');

      const history = machine.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].toState).toBe('terminated');
      expect(history[0].trigger).toBe('shutdown');
    });
  });

  describe('dispose', () => {
    it('should clear timeouts on dispose', () => {
      // This is mostly to ensure no errors/memory leaks
      machine.dispose();
      machine.dispose(); // Should be safe to call twice
    });
  });
});

describe('Utility Functions', () => {
  describe('isBusyState', () => {
    it('should return true for busy states', () => {
      expect(isBusyState('working')).toBe(true);
      expect(isBusyState('delegating')).toBe(true);
      expect(isBusyState('reviewing')).toBe(true);
    });

    it('should return false for non-busy states', () => {
      expect(isBusyState('idle')).toBe(false);
      expect(isBusyState('initializing')).toBe(false);
      expect(isBusyState('blocked')).toBe(false);
      expect(isBusyState('errored')).toBe(false);
      expect(isBusyState('terminated')).toBe(false);
    });
  });

  describe('isTerminalState', () => {
    it('should return true only for terminated', () => {
      expect(isTerminalState('terminated')).toBe(true);
    });

    it('should return false for all other states', () => {
      const nonTerminal: AgentState[] = [
        'initializing', 'onboarding', 'idle', 'working',
        'delegating', 'blocked', 'reviewing', 'errored'
      ];
      nonTerminal.forEach(state => {
        expect(isTerminalState(state)).toBe(false);
      });
    });
  });

  describe('canAcceptTask', () => {
    it('should return true only for idle', () => {
      expect(canAcceptTask('idle')).toBe(true);
    });

    it('should return false for all other states', () => {
      const notIdle: AgentState[] = [
        'initializing', 'onboarding', 'working',
        'delegating', 'blocked', 'reviewing', 'errored', 'terminated'
      ];
      notIdle.forEach(state => {
        expect(canAcceptTask(state)).toBe(false);
      });
    });
  });

  describe('needsAttention', () => {
    it('should return true for blocked and errored', () => {
      expect(needsAttention('blocked')).toBe(true);
      expect(needsAttention('errored')).toBe(true);
    });

    it('should return false for other states', () => {
      expect(needsAttention('idle')).toBe(false);
      expect(needsAttention('working')).toBe(false);
      expect(needsAttention('terminated')).toBe(false);
    });
  });

  describe('getStateDescription', () => {
    it('should return descriptions for all states', () => {
      const states: AgentState[] = [
        'initializing', 'onboarding', 'idle', 'working',
        'delegating', 'blocked', 'reviewing', 'errored', 'terminated'
      ];

      states.forEach(state => {
        const desc = getStateDescription(state);
        expect(desc).toBeTruthy();
        expect(typeof desc).toBe('string');
      });
    });

    it('should return meaningful descriptions', () => {
      expect(getStateDescription('idle')).toBe('Ready for work');
      expect(getStateDescription('working')).toBe('Actively executing a task');
      expect(getStateDescription('terminated')).toBe('Permanently stopped');
    });
  });

  describe('getSuggestedNextStates', () => {
    it('should return suggestions for all states', () => {
      const states: AgentState[] = [
        'initializing', 'onboarding', 'idle', 'working',
        'delegating', 'blocked', 'reviewing', 'errored', 'terminated'
      ];

      states.forEach(state => {
        const suggestions = getSuggestedNextStates(state);
        expect(Array.isArray(suggestions)).toBe(true);
      });
    });

    it('should return empty array for terminated', () => {
      expect(getSuggestedNextStates('terminated')).toHaveLength(0);
    });

    it('should return valid suggestions', () => {
      expect(getSuggestedNextStates('idle')).toContain('working');
      expect(getSuggestedNextStates('errored')).toContain('idle');
    });
  });
});
