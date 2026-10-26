import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_TURNS } from '@shared/models';
import { notice, errorMessage, type ChatMessage } from '../types';
import { fromStored, mergeRestored, toHistoryPayload, toPersistedMessages } from './history';

const chat = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, kind: 'chat', content });

describe('toHistoryPayload', () => {
    it('sends the conversation only, never notices or errors', () => {
        const messages = [
            notice('chat.notices.modelSwitched', { model: 'x' }),
            chat('1', 'user', 'install nginx'),
            errorMessage('Error connecting to AI service.'),
            chat('2', 'assistant', 'Run this'),
            { id: '3', role: 'user' as const, kind: 'command-output' as const, command: 'apt install -y nginx', content: 'done' }
        ];
        expect(toHistoryPayload(messages)).toEqual([
            { role: 'user', content: 'install nginx' },
            { role: 'assistant', content: 'Run this' },
            { role: 'user', kind: 'command-output', command: 'apt install -y nginx', content: 'done' }
        ]);
    });

    it('bounds the number and size of turns', () => {
        const many = Array.from({ length: 30 }, (_, i) => chat(String(i), i % 2 ? 'assistant' : 'user', 'x'.repeat(9000)));
        const payload = toHistoryPayload(many);
        expect(payload).toHaveLength(MAX_HISTORY_TURNS);
        expect(payload.every((turn) => turn.content.length <= 4000)).toBe(true);
    });
});

describe('toPersistedMessages', () => {
    it('drops notices and errors and caps every message', () => {
        const stored = toPersistedMessages([
            chat('1', 'user', 'hello'),
            notice('chat.notices.autoRunEnabled'),
            errorMessage('boom'),
            chat('2', 'assistant', 'y'.repeat(30_000))
        ]);
        expect(stored).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'y'.repeat(20_000) }]);
    });

    it('keeps the last 100 messages and the payload under the route limit', () => {
        const big = Array.from({ length: 150 }, (_, i) => chat(String(i), 'user', `${i}`.padEnd(20_000, '.')));
        const stored = toPersistedMessages(big);
        expect(stored.length).toBeLessThanOrEqual(100);
        expect(JSON.stringify(stored).length).toBeLessThan(8 * 1024 * 1024);
        expect(stored.at(-1)?.content.startsWith('149')).toBe(true);
    });
});

describe('partial answers', () => {
    const stopped: ChatMessage = { id: 's', role: 'assistant', kind: 'chat', content: 'Remove it:\n```bash\nrm -rf /tmp/build-ca', stopped: true };
    const cutOff: ChatMessage = { id: 'c', role: 'assistant', kind: 'chat', content: 'Step 1', stopReason: 'max_tokens' };

    it('are saved and sent as history with their partial mark', () => {
        const messages = [chat('1', 'user', 'free some space'), stopped, chat('2', 'user', 'go on'), cutOff, chat('3', 'assistant', 'done')];
        expect(toPersistedMessages(messages).map((message) => message.partial)).toEqual([undefined, true, undefined, true, undefined]);
        expect(toHistoryPayload(messages).map((message) => message.partial)).toEqual([undefined, true, undefined, true, undefined]);
    });

    it('come back from the saved history as stopped, never as complete answers', () => {
        const [restored] = fromStored(toPersistedMessages([stopped]));
        expect(restored).toMatchObject({ role: 'assistant', kind: 'chat', content: stopped.content, stopped: true });
        // A user turn cannot claim to be partial.
        expect(fromStored([{ role: 'user', content: 'q', partial: true }])[0].stopped).toBeUndefined();
    });
});

describe('fromStored / mergeRestored', () => {
    it('validates stored messages', () => {
        const restored = fromStored([
            { role: 'user', content: 'q' },
            { role: 'system', content: 'nope' },
            { role: 'user', kind: 'command-output', command: 'df -h', content: 'Filesystem' },
            { role: 'assistant', content: '' },
            null
        ]);
        expect(restored.map(({ role, kind, content, command }) => ({ role, kind, content, command }))).toEqual([
            { role: 'user', kind: 'chat', content: 'q', command: undefined },
            { role: 'user', kind: 'command-output', content: 'Filesystem', command: 'df -h' }
        ]);
        expect(fromStored('garbage')).toEqual([]);
    });

    it('keeps messages sent before a late restore', () => {
        const typed = [chat('new-1', 'user', 'quick question')];
        const restored = [chat('h1', 'user', 'old'), chat('h2', 'assistant', 'answer')];
        expect(mergeRestored(typed, restored).map((message) => message.id)).toEqual(['h1', 'h2', 'new-1']);
        expect(mergeRestored(typed, [])).toBe(typed);
    });
});
