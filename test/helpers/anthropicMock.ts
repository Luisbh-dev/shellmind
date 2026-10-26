import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// In-process stand-in for the Anthropic-compatible MiniMax proxy
// (POST <base>/anthropic/v1/messages). Each request is answered by the next
// queued handler (or the default one) and recorded for assertions.

// The Anthropic Messages request body as the client sends it.
export type MockBody = {
    model?: string;
    system?: string;
    max_tokens?: number;
    stream?: boolean;
    messages?: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
};

export type MockRequest = {
    path: string;
    headers: IncomingHttpHeaders;
    body: MockBody;
    // Resolves when the client closed the connection.
    closed: Promise<void>;
};

export type MockHandler = (res: ServerResponse, req: MockRequest) => void | Promise<void>;

export type AnthropicMock = {
    // Pass to MINIMAX_PROXY_URL (the client appends /anthropic/v1/messages).
    url: string;
    requests: MockRequest[];
    queue: (...handlers: MockHandler[]) => void;
    setDefault: (handler: MockHandler) => void;
    close: () => Promise<void>;
};

type StreamOptions = {
    lineEnding?: '\n' | '\r\n' | '\r';
    stopReason?: string;
    // Thinking deltas before the text (skipped by the client).
    thinking?: string;
    // How the stream ends: normally, with an error event, or cut off.
    ending?: 'stop' | 'error' | 'truncate';
    errorType?: string;
    errorMessage?: string;
    // Delay between events, in ms.
    delayMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function sseEvent(type: string, data: object, lineEnding = '\n'): string {
    return `event: ${type}${lineEnding}data: ${JSON.stringify(data)}${lineEnding}${lineEnding}`;
}

// A streamed Anthropic message whose text is `parts`, one delta each.
export function streamReply(parts: string[], options: StreamOptions = {}): MockHandler {
    return async (res) => {
        const le = options.lineEnding ?? '\n';
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const write = async (type: string, data: object) => {
            res.write(sseEvent(type, data, le));
            if (options.delayMs) await sleep(options.delayMs);
        };

        await write('message_start', { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } });
        if (options.thinking) {
            await write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
            await write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: options.thinking } });
            await write('content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        if (parts.length) {
            await write('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
            for (const text of parts) {
                await write('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });
            }
        }
        await write('ping', { type: 'ping' });

        const ending = options.ending ?? 'stop';
        if (ending === 'error') {
            await write('error', { type: 'error', error: { type: options.errorType ?? 'overloaded_error', message: options.errorMessage ?? 'Overloaded' } });
            res.end();
            return;
        }
        if (ending === 'truncate') {
            res.end();
            return;
        }
        if (parts.length) await write('content_block_stop', { type: 'content_block_stop', index: 1 });
        await write('message_delta', { type: 'message_delta', delta: { stop_reason: options.stopReason ?? 'end_turn' } });
        await write('message_stop', { type: 'message_stop' });
        res.end();
    };
}

export function jsonReply(text: string, stopReason = 'end_turn'): MockHandler {
    return (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: text ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: '...' }], stop_reason: stopReason }));
    };
}

export function errorReply(status: number, message: string, type = 'invalid_request_error'): MockHandler {
    return (res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type, message } }));
    };
}

// Accepts the request and never answers (or stops after the headers).
export function hangReply(afterHeaders = false): MockHandler {
    return (res) => {
        if (afterHeaders) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(sseEvent('message_start', { type: 'message_start', message: { id: 'msg_1' } }));
        }
    };
}

export async function startAnthropicMock(): Promise<AnthropicMock> {
    const queued: MockHandler[] = [];
    let fallback: MockHandler = streamReply(['ok']);
    const requests: MockRequest[] = [];
    const sockets = new Set<import('node:net').Socket>();

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            let body: MockBody = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MockBody; } catch { /* not JSON */ }
            const closed = new Promise<void>((resolve) => res.on('close', () => resolve()));
            const request: MockRequest = { path: req.url ?? '', headers: req.headers, body, closed };
            requests.push(request);
            const handler = queued.shift() ?? fallback;
            Promise.resolve(handler(res, request)).catch(() => res.destroy());
        });
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        queue: (...handlers) => queued.push(...handlers),
        setDefault: (handler) => { fallback = handler; },
        close: () => new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        })
    };
}
