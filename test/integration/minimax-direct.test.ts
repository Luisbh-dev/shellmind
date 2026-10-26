import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, type TestServer } from '../helpers/testServer';

type Captured = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

// Minimal Anthropic-compatible endpoint that streams a fixed answer.
function startMockApi(captured: Captured[]): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            captured.push({ path: req.url || '', headers: req.headers, body: JSON.parse(raw || '{}') });
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const events = [
                { type: 'message_start', message: { id: 'msg_1' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Use ' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '`df -h`.' } },
                { type: 'message_stop' },
            ];
            for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const directCalls: Captured[] = [];
const proxyCalls: Captured[] = [];
let directApi: http.Server;
let proxy: http.Server;
let server: TestServer;

beforeAll(async () => {
    directApi = await startMockApi(directCalls);
    proxy = await startMockApi(proxyCalls);
    server = await bootTestServer({
        env: {
            MINIMAX_API_KEY: 'user-own-key',
            MINIMAX_API_BASE_URL: `http://127.0.0.1:${(directApi.address() as AddressInfo).port}/anthropic`,
            MINIMAX_PROXY_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        },
    });
});

afterAll(async () => {
    await server?.close();
    directApi?.close();
    proxy?.close();
});

describe('MiniMax with the user\'s own key', () => {
    it('calls the official API directly and never sends the key to the proxy', async () => {
        const res = await server.fetch('/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'how do I check disk usage on a linux server', history: [], stream: true, model: 'MiniMax-M3' }),
        });
        const text = await res.text();

        expect(text).toContain('"type":"done"');
        expect(text).toContain('Use `df -h`.');
        expect(proxyCalls).toHaveLength(0);
        expect(directCalls).toHaveLength(1);

        const [call] = directCalls;
        expect(call.path).toBe('/anthropic/v1/messages');
        expect(call.headers['x-api-key']).toBe('user-own-key');
        expect(call.headers.authorization).toBe('Bearer user-own-key');
        expect(call.body.model).toBe('MiniMax-M3');
        expect(call.body.stream).toBe(true);
    });

    it('maps a retired model in the request to its successor', async () => {
        directCalls.length = 0;
        await (await server.fetch('/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'list docker containers on the server', history: [], stream: true, model: 'MiniMax-M2.7' }),
        })).text();

        expect(directCalls[0]?.body.model).toBe('MiniMax-M3');
    });
});
