import { describe, expect, it } from 'vitest';
import { sanitizeChatHistory } from './history';

describe('sanitizeChatHistory', () => {
    it('returns an empty transcript for non-array input', () => {
        expect(sanitizeChatHistory(undefined, 'id')).toEqual([]);
        expect(sanitizeChatHistory(null, 'id')).toEqual([]);
        expect(sanitizeChatHistory('hello', 'id')).toEqual([]);
        expect(sanitizeChatHistory({ role: 'user', content: 'hi' }, 'id')).toEqual([]);
    });

    it('keeps only user/assistant turns with non-empty string content, trimmed', () => {
        const result = sanitizeChatHistory([
            { role: 'system', content: 'ignored' },
            { role: 'user', content: '  first question  ' },
            { role: 'assistant', content: 42 },
            { role: 'assistant', content: '   ' },
            null,
            'not an object',
            { role: 'assistant', content: 'an answer' },
        ], 'id');

        expect(result).toEqual([
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'an answer' },
        ]);
    });

    it('merges consecutive turns of the same role', () => {
        const result = sanitizeChatHistory([
            { role: 'user', content: 'one' },
            { role: 'user', content: 'two' },
            { role: 'assistant', content: 'three' },
            { role: 'assistant', content: 'four' },
        ], 'id');

        expect(result).toEqual([
            { role: 'user', content: 'one\n\ntwo' },
            { role: 'assistant', content: 'three\n\nfour' },
        ]);
    });

    it('truncates each oversized turn to 4000 characters before merging', () => {
        const long = 'x'.repeat(4500);
        const [turn] = sanitizeChatHistory([{ role: 'user', content: long }], 'id');
        expect(turn.content).toBe(`${'x'.repeat(4000)}\n[...truncated]`);

        // The limit applies per incoming turn, so a merged turn can exceed it.
        const [merged] = sanitizeChatHistory([
            { role: 'user', content: 'a'.repeat(3000) },
            { role: 'user', content: 'b'.repeat(3000) },
        ], 'id');
        expect(merged.content).toHaveLength(6002);
    });

    it('turns command output into a data block, masked and clipped in the middle', () => {
        const output = `start\nTOKEN=abcdef123456\n${'y'.repeat(5000)}\nthe end`;
        const [turn] = sanitizeChatHistory([{ role: 'user', kind: 'command-output', command: 'cat .env', content: output }], 'f00d');

        expect(turn.role).toBe('user');
        expect(turn.content.startsWith('ShellMind request: output of the command that ran automatically.\n<<<DATA kind="command-output" id="f00d">>>\n$ cat .env\nstart\nTOKEN=[REDACTED]')).toBe(true);
        expect(turn.content).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/);
        expect(turn.content.endsWith('the end\n<<<END DATA id="f00d">>>')).toBe(true);
    });

    it('tells the model which earlier answers were interrupted', () => {
        expect(sanitizeChatHistory([
            { role: 'user', content: 'free some space', partial: true },
            { role: 'assistant', content: 'Remove the cache:\n```bash\nrm -rf /tmp/build-ca', partial: true },
            { role: 'user', content: 'go on' },
            { role: 'assistant', content: 'done' }
        ], 'id')).toEqual([
            { role: 'user', content: 'free some space' },
            { role: 'assistant', content: 'Remove the cache:\n```bash\nrm -rf /tmp/build-ca\n\n[This answer was interrupted before it was complete.]' },
            { role: 'user', content: 'go on' },
            { role: 'assistant', content: 'done' }
        ]);
    });

    it('ignores the command-output kind on assistant turns', () => {
        expect(sanitizeChatHistory([{ role: 'user', content: 'q' }, { role: 'assistant', kind: 'command-output', content: 'answer' }], 'id')).toEqual([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'answer' }
        ]);
    });

    it('keeps the last 12 turns and never starts with an assistant turn', () => {
        const raw = Array.from({ length: 15 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `turn ${i}`,
        }));

        const result = sanitizeChatHistory(raw, 'id');

        // Turns 3..14 are the last 12; turn 3 is an assistant turn and is dropped.
        expect(result).toHaveLength(11);
        expect(result[0]).toEqual({ role: 'user', content: 'turn 4' });
        expect(result[result.length - 1]).toEqual({ role: 'user', content: 'turn 14' });
    });

    it('drops a transcript that only contains assistant turns', () => {
        expect(sanitizeChatHistory([{ role: 'assistant', content: 'hello' }], 'id')).toEqual([]);
    });
});
