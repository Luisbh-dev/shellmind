import { describe, expect, it, vi } from 'vitest';
import { readSseEvents } from './stream';

const { createSseParser } = vi.hoisted(() => ({ createSseParser: vi.fn() }));
vi.mock('@shared/sse', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@shared/sse')>();
    createSseParser.mockImplementation(actual.createSseParser);
    return { ...actual, createSseParser };
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
}

async function collect(chunks: string[]): Promise<unknown[]> {
    const events: unknown[] = [];
    await readSseEvents(streamOf(chunks), (event) => events.push(event));
    return events;
}

describe('readSseEvents', () => {
    it('parses data events split across chunks', async () => {
        expect(await collect(['data: {"type":"st', 'art"}\n', '\ndata: {"type":"done"}\n\n'])).toEqual([{ type: 'start' }, { type: 'done' }]);
    });

    it('handles CRLF separators, even split between chunks', async () => {
        expect(await collect(['data: {"a":1}\r', '\n\r\ndata: {"b":2}\r\n\r\n'])).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('skips comments, other fields and malformed payloads', async () => {
        expect(await collect([': ping\n\nevent: x\nid: 3\ndata: {"ok":true}\n\ndata: not json\n\n'])).toEqual([{ ok: true }]);
    });

    it('joins multi-line data and delivers a final event without a trailing blank line', async () => {
        expect(await collect(['data: {"text":\ndata: "two lines"}\n\ndata: {"last":1}'])).toEqual([{ text: 'two lines' }, { last: 1 }]);
    });

    // One framing implementation for the whole UI: shared/sse.ts.
    it('frames events with the shared SSE parser', async () => {
        createSseParser.mockClear();
        expect(await collect(['data: {"a":1}\r\rdata: {"b":2}\r\n\r\n'])).toEqual([{ a: 1 }, { b: 2 }]);
        expect(createSseParser).toHaveBeenCalledTimes(1);
    });

    it('keeps multi-byte characters split across chunks', async () => {
        const bytes = new TextEncoder().encode('data: {"t":"ñandú"}\n\n');
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, 15));
                controller.enqueue(bytes.slice(15));
                controller.close();
            },
        });
        const events: unknown[] = [];
        await readSseEvents(stream, (event) => events.push(event));
        expect(events).toEqual([{ t: 'ñandú' }]);
    });
});
