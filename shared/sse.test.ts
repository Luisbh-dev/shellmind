import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from './sse';

function parse(chunks: string[], end = true): SseEvent[] {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    for (const chunk of chunks) parser.push(chunk);
    if (end) parser.end();
    return events;
}

describe('createSseParser', () => {
    it('parses LF-framed events with event names and data', () => {
        expect(parse(['event: ping\ndata: {"a":1}\n\ndata: plain\n\n'])).toEqual([
            { event: 'ping', data: '{"a":1}' },
            { event: 'message', data: 'plain' }
        ]);
    });

    it('accepts CRLF and bare CR line endings', () => {
        expect(parse(['data: one\r\n\r\ndata: two\r\rdata: three\n\n'])).toEqual([
            { event: 'message', data: 'one' },
            { event: 'message', data: 'two' },
            { event: 'message', data: 'three' }
        ]);
    });

    it('handles a CRLF pair split across chunks without an extra blank line', () => {
        const events = parse(['data: a\r', '\ndata: b\r', '\n\r', '\n']);
        expect(events).toEqual([{ event: 'message', data: 'a\nb' }]);
    });

    it('reassembles fields and events split at any position', () => {
        const stream = 'event: content_block_delta\ndata: {"text":"héllo"}\n\n';
        for (let cut = 1; cut < stream.length; cut++) {
            expect(parse([stream.slice(0, cut), stream.slice(cut)])).toEqual([
                { event: 'content_block_delta', data: '{"text":"héllo"}' }
            ]);
        }
    });

    it('joins multi-line data, ignores comments and unknown fields, keeps ids', () => {
        expect(parse([': keep-alive\nid: 7\nretry: 100\nfoo: bar\ndata: line 1\ndata:line 2\n\n'])).toEqual([
            { event: 'message', data: 'line 1\nline 2', id: '7' }
        ]);
    });

    it('does not dispatch events without data', () => {
        expect(parse(['event: lonely\n\n'])).toEqual([]);
    });

    it('flushes an unterminated final event on end()', () => {
        expect(parse(['data: first\n\ndata: truncated'], false)).toEqual([{ event: 'message', data: 'first' }]);
        expect(parse(['data: first\n\ndata: truncated'])).toEqual([
            { event: 'message', data: 'first' },
            { event: 'message', data: 'truncated' }
        ]);
    });
});
