import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/appStore';
import { isAutoRunStep, onCommandUndelivered, reportUndelivered, takeQueuedWhere } from './commandDelivery';

beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('takeQueuedWhere', () => {
    it('takes only the picked entries and leaves the others queued as they were', () => {
        const store = useAppStore.getState();
        store.queueCommand(1, 'one', 'snippet');
        store.queueCommand(1, 'step', 'ai-autorun');
        store.queueCommand(1, 'two', 'ai');
        store.queueCommand(2, 'other server', 'ai-autorun');
        const before = useAppStore.getState().pendingCommands[1];

        const taken = takeQueuedWhere(1, isAutoRunStep);
        expect(taken).toEqual([before[1]]);
        expect(useAppStore.getState().pendingCommands[1]).toEqual([before[0], before[2]]);
        expect(useAppStore.getState().pendingCommands[2]).toHaveLength(1);

        // Nothing picked: the state is left alone.
        const state = useAppStore.getState();
        expect(takeQueuedWhere(1, isAutoRunStep)).toEqual([]);
        expect(useAppStore.getState()).toBe(state);

        takeQueuedWhere(2, isAutoRunStep);
        expect(useAppStore.getState().pendingCommands).not.toHaveProperty('2');
    });
});

describe('reportUndelivered', () => {
    it('tells every listener, even when one of them throws, until it unsubscribes', () => {
        const broken = vi.fn(() => {
            throw new Error('broken');
        });
        const listener = vi.fn();
        const stopBroken = onCommandUndelivered(broken);
        const stop = onCommandUndelivered(listener);

        reportUndelivered({ command: 'uptime', source: 'ai-autorun' }, 3, 'full-screen');
        expect(broken).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith({ serverId: 3, command: 'uptime', source: 'ai-autorun', reason: 'full-screen' });

        stop();
        stopBroken();
        reportUndelivered({ command: 'uptime', source: 'ai-autorun' }, 3, 'no-prompt');
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
