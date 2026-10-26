import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '../types';
import triageAction from './triage';

const linux: WorkspaceServer = { id: 3, name: 'web', ip: '10.0.0.3', type: 'linux' };

beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ activeServerId: 3, chatOpen: false });
    setLanguage('en');
});

describe('triage action', () => {
    it('opens the chat of the server with the triage pack attached, then closes', () => {
        const onClose = vi.fn();
        const { Component } = triageAction;
        render(<Component server={linux} onClose={onClose} />);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(useAppStore.getState()).toMatchObject({
            chatOpen: true,
            chatRequest: { serverId: 3, kind: 'context', attachment: { kind: 'triage' }, prompt: expect.stringMatching(/^Check this server for problems/) }
        });
    });

    it('is offered for SSH-capable servers only', () => {
        expect(triageAction.isAvailable?.(linux)).toBe(true);
        expect(triageAction.isAvailable?.({ ...linux, type: 'windows' })).toBe(true);
        for (const type of ['ftp', 's3', 'local'] as const) expect(triageAction.isAvailable?.({ ...linux, type })).toBe(false);
        expect(triageAction.isAvailable?.(null)).toBe(false);
    });
});
