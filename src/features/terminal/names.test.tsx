import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerSummary } from '@shared/types';
import { DANGER_KEYS } from '@/features/chat/components/AutoRun';
import { setLanguage, t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { useServersStore } from '@/store/servers';
import { broadcastKey } from './broadcast';
import { dangerReasonKey, listTerminals, terminalNameOf } from './names';

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    useServersStore.setState({ servers: [{ id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux' } as ServerSummary], status: 'ready', error: null });
});

describe('broadcast names', () => {
    it('names a terminal by its server and tab, and lists many briefly', () => {
        const ids = Array.from({ length: 8 }, () => useAppStore.getState().openTerminalSession(1));
        useAppStore.getState().renameTerminalSession(1, ids[0], 'logs');
        expect(terminalNameOf(broadcastKey(1, ids[0]), t)).toBe('web-1 · logs');
        expect(terminalNameOf(broadcastKey(1, ids[1]), t)).toBe('web-1 · Terminal 2');
        const other = useAppStore.getState().openTerminalSession(9);
        expect(terminalNameOf(broadcastKey(9, other), t)).toBe('#9 · Terminal 1');
        expect(listTerminals(ids.map((id) => broadcastKey(1, id)), t)).toBe(
            'web-1 · logs, web-1 · Terminal 2, web-1 · Terminal 3, web-1 · Terminal 4, web-1 · Terminal 5, web-1 · Terminal 6 and 2 more'
        );
    });

    it('words every destructive command the way the AI chat does', () => {
        for (const [reason, key] of Object.entries(DANGER_KEYS)) {
            expect(dangerReasonKey(reason as keyof typeof DANGER_KEYS)).toBe(key);
        }
        expect(t(dangerReasonKey('recursive-delete'))).toBe('deletes files recursively');
    });
});
