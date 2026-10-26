import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '../../shared/chat';
import { createSseParser } from '../../shared/sse';
import { startAnthropicMock, streamReply, type AnthropicMock } from '../helpers/anthropicMock';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// While the model thinks, the chat stream must not go silent: a reverse proxy
// with an idle read timeout would cut the answer. The chat router is mounted
// with a short heartbeat on the backend's own module graph (DB, settings).

let server: TestServer;
let mock: AnthropicMock;
let chatApp: http.Server;
let chatUrl = '';

beforeAll(async () => {
    mock = await startAnthropicMock();
    server = await bootTestServer({ env: { MINIMAX_PROXY_URL: mock.url } });
    const { createChatRouter } = await import('../../server/http/routes/chat');
    const app = express();
    app.use(express.json());
    app.use(createChatRouter({ heartbeatMs: 30 }));
    chatApp = http.createServer(app);
    await new Promise<void>((resolve) => chatApp.listen(0, '127.0.0.1', resolve));
    chatUrl = `http://127.0.0.1:${(chatApp.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => chatApp?.close(() => resolve()));
    await server?.close();
    await mock?.close();
});

describe('POST /api/chat (stream heartbeat)', () => {
    it('sends comment lines while the model is still thinking, and they do not reach the events', async () => {
        mock.queue(streamReply(['df -h'], { thinking: 'checking the disks', delayMs: 120 }));

        const res = await fetch(`${chatUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'which disk is full?', stream: true })
        });
        const raw = await res.text();

        // Pings arrive before the first text delta (the silent thinking phase).
        const firstDelta = raw.indexOf('"type":"delta"');
        expect(firstDelta).toBeGreaterThan(0);
        expect(raw.slice(0, firstDelta)).toContain(': ping\n\n');

        const events: ChatStreamEvent[] = [];
        const parser = createSseParser(({ data }) => events.push(JSON.parse(data) as ChatStreamEvent));
        parser.push(raw);
        parser.end();
        expect(events).toEqual([
            { type: 'model', model: 'MiniMax-M3' },
            { type: 'delta', text: 'df -h' },
            { type: 'done', usedModel: 'MiniMax-M3', fullText: 'df -h' }
        ]);
    });
});
