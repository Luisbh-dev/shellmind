import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '../../shared/chat';
import { createSseParser } from '../../shared/sse';
import { startAnthropicMock, streamReply, type AnthropicMock } from '../helpers/anthropicMock';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// API keys saved under another data key (the database was moved without its
// shellmind.key): the chat treats them as missing, exactly as the Settings
// status reports them, instead of failing every message with a 500.

let server: TestServer;
let mock: AnthropicMock;

function sql(statement: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => server.db.run(statement, params, (err) => (err ? reject(err) : resolve())));
}

beforeAll(async () => {
    mock = await startAnthropicMock();
    server = await bootTestServer({ env: { MINIMAX_PROXY_URL: mock.url, ALLOW_CLIENT_MINIMAX_KEY: 'true' } });
    // Backend modules read the environment on import: after the boot.
    const { encryptWithKey } = await import('../../server/security/secrets');
    const otherKey = randomBytes(32);
    for (const name of ['MINIMAX_API_KEY', 'GEMINI_API_KEY']) {
        await sql('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [name, encryptWithKey(otherKey, `${name}-value`)]);
    }
    const { settingsRepo } = await import('../../server/db/settingsRepo');
    settingsRepo.clearCache();
});

afterAll(async () => {
    await server?.close();
    await mock?.close();
});

const postChat = (body: Record<string, unknown>) => server.fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
});

describe('chat with a saved API key that no longer decrypts', () => {
    it('reports both providers as not configured', async () => {
        const status = (await (await server.fetch('/api/config/status')).json()) as {
            providers: Record<string, { configured: boolean; source: string }>;
            features: { minimaxProxy: { route: string } };
        };
        expect(status.providers.minimax).toEqual({ configured: false, source: 'none' });
        expect(status.providers.gemini).toEqual({ configured: false, source: 'none' });
        expect(status.features.minimaxProxy.route).toBe('proxy');
    });

    it('answers MiniMax through the proxy, as the status says, without the unreadable key', async () => {
        mock.queue(streamReply(['Use `df -h`.']));
        const res = await postChat({ message: 'which disk is full?', stream: true });
        expect(res.status).toBe(200);
        const events: ChatStreamEvent[] = [];
        const parser = createSseParser(({ data }) => events.push(JSON.parse(data) as ChatStreamEvent));
        parser.push(await res.text());
        parser.end();
        expect(events.at(-1)).toEqual({ type: 'done', usedModel: 'MiniMax-M3', fullText: 'Use `df -h`.' });
        expect(mock.requests).toHaveLength(1);
        expect(mock.requests[0].headers['x-api-key']).toBeUndefined();
    });

    it('asks for the Gemini key again with a 409 instead of a 500', async () => {
        const res = await postChat({ message: 'which disk is full?', model: 'gemini-3.8-flash' });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({
            error: 'The saved Gemini API key cannot be decrypted (the data key changed). Enter it again in Settings.',
            code: 'SECRET_UNREADABLE',
            details: { provider: 'gemini' }
        });
    });
});
