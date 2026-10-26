import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    errorReply,
    hangReply,
    jsonReply,
    startAnthropicMock,
    streamReply,
    type AnthropicMock
} from '../../test/helpers/anthropicMock';
import { AiProviderError } from './errors';
import { callMiniMax, isClientKeyRejection, MAX_MINIMAX_ATTEMPTS, nextMiniMaxStep, type MiniMaxRequest } from './minimax';

let mock: AnthropicMock;

beforeAll(async () => {
    mock = await startAnthropicMock();
});

afterAll(async () => {
    await mock.close();
});

beforeEach(() => {
    mock.requests.length = 0;
    mock.setDefault(streamReply(['unexpected']));
});

// One mock serves both routes: the proxy at /anthropic/v1 and MiniMax's own
// API at /direct/anthropic.
const PROXY_PATH = '/anthropic/v1/messages';
const DIRECT_PATH = '/direct/anthropic/v1/messages';

const baseRequest = (overrides: Partial<MiniMaxRequest> = {}): MiniMaxRequest => ({
    model: 'MiniMax-M3',
    system: 'system prompt',
    turns: [{ role: 'user', content: 'restart nginx' }],
    clientApiKey: null,
    proxyBaseUrl: `${mock.url}/anthropic/v1`,
    apiBaseUrl: `${mock.url}/direct/anthropic`,
    ...overrides
});

function collect() {
    const deltas: string[] = [];
    return { deltas, onDelta: (text: string) => deltas.push(text) };
}

async function failure(promise: Promise<unknown>): Promise<AiProviderError> {
    try {
        await promise;
    } catch (err) {
        return err as AiProviderError;
    }
    throw new Error('expected the call to fail');
}

describe('callMiniMax (streaming)', () => {
    it('streams through the proxy without a user key', async () => {
        mock.queue(streamReply(['Hello', ' world']));
        const { deltas, onDelta } = collect();

        const result = await callMiniMax(baseRequest({ onDelta }));

        expect(result).toEqual({ text: 'Hello world', stopReason: 'end_turn' });
        expect(deltas).toEqual(['Hello', ' world']);
        const [request] = mock.requests;
        expect(request.path).toBe(PROXY_PATH);
        expect(request.headers['anthropic-version']).toBe('2023-06-01');
        expect(request.headers['x-api-key']).toBeUndefined();
        expect(request.body).toEqual({
            model: 'MiniMax-M3',
            max_tokens: 8192,
            system: 'system prompt',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'restart nginx' }] }],
            stream: true
        });
    });

    it('calls MiniMax directly with the user key, which never reaches the proxy', async () => {
        mock.queue(streamReply(['ok']));
        await callMiniMax(baseRequest({ model: 'MiniMax-M3.1-Flash', clientApiKey: 'byok-key', onDelta: () => undefined }));

        const [request] = mock.requests;
        expect(request.path).toBe(DIRECT_PATH);
        expect(request.headers['x-api-key']).toBe('byok-key');
        expect(request.headers.authorization).toBe('Bearer byok-key');
        expect(request.headers['x-minimax-api-key']).toBeUndefined();
        // The thinking model: larger budget and low effort.
        expect(request.body).toMatchObject({ model: 'MiniMax-M3.1-Flash', max_tokens: 16384, output_config: { effort: 'low' } });
    });

    it.each([['CRLF', '\r\n'], ['CR', '\r']] as const)('parses %s-framed streams', async (_name, lineEnding) => {
        mock.queue(streamReply(['a', 'b', 'c'], { lineEnding }));
        const { deltas, onDelta } = collect();
        await expect(callMiniMax(baseRequest({ onDelta }))).resolves.toEqual({ text: 'abc', stopReason: 'end_turn' });
        expect(deltas).toEqual(['a', 'b', 'c']);
    });

    it('skips thinking deltas and reports a max_tokens cut-off', async () => {
        mock.queue(streamReply(['partial'], { thinking: 'secret reasoning', stopReason: 'max_tokens' }));
        const { deltas, onDelta } = collect();
        await expect(callMiniMax(baseRequest({ onDelta }))).resolves.toEqual({ text: 'partial', stopReason: 'max_tokens' });
        expect(deltas).toEqual(['partial']);
    });

    it('asks again for a final answer when the model only thought', async () => {
        mock.queue(streamReply([], { thinking: 'hmm' }), streamReply(['final']));
        const { deltas, onDelta } = collect();

        await expect(callMiniMax(baseRequest({ onDelta }))).resolves.toMatchObject({ text: 'final' });

        expect(deltas).toEqual(['final']);
        expect(mock.requests).toHaveLength(2);
        expect(mock.requests[1].body.messages?.at(-1)?.content[0].text).toMatch(/restart nginx\n\nIMPORTANT: Return a final user-facing answer/);
    });

    it('reports a mid-stream error event after text as a retryable provider error', async () => {
        mock.queue(streamReply(['Half an'], { ending: 'error', errorType: 'overloaded_error', errorMessage: 'Overloaded' }));
        const { deltas, onDelta } = collect();

        const error = await failure(callMiniMax(baseRequest({ onDelta })));

        expect(error).toBeInstanceOf(AiProviderError);
        expect(error.message).toBe('MiniMax stream error (overloaded_error): Overloaded');
        expect(error.retryable).toBe(true);
        expect(deltas).toEqual(['Half an']);
        expect(mock.requests).toHaveLength(1);
    });

    it('does not treat a non-retryable error event as retryable', async () => {
        mock.queue(streamReply([], { ending: 'error', errorType: 'invalid_request_error', errorMessage: 'bad input' }));
        const error = await failure(callMiniMax(baseRequest({ onDelta: () => undefined })));
        expect(error.retryable).toBe(false);
        expect(error.type).toBe('invalid_request_error');
    });

    it('fails a stream that ends before message_stop instead of returning a truncated answer', async () => {
        mock.queue(streamReply(['cut'], { ending: 'truncate' }));
        const error = await failure(callMiniMax(baseRequest({ onDelta: () => undefined })));
        expect(error.message).toMatch(/ended before the answer was complete/);
        expect(error.retryable).toBe(true);
    });

    it('retries through the proxy only when MiniMax rejects the user key', async () => {
        mock.queue(errorReply(401, 'invalid api key', 'authentication_error'), streamReply(['ok']));
        await expect(callMiniMax(baseRequest({ clientApiKey: 'bad-key', onDelta: () => undefined }))).resolves.toMatchObject({ text: 'ok' });
        expect(mock.requests.map((request) => [request.path, request.headers['x-api-key']])).toEqual([
            [DIRECT_PATH, 'bad-key'],
            [PROXY_PATH, undefined]
        ]);
        expect(mock.requests.every((request) => request.headers['x-minimax-api-key'] === undefined)).toBe(true);
    });

    it('does not retry input errors elsewhere', async () => {
        mock.queue(errorReply(400, 'invalid request: prompt is too long'));
        const error = await failure(callMiniMax(baseRequest({ clientApiKey: 'byok', onDelta: () => undefined })));
        expect(error.status).toBe(400);
        expect(error.retryable).toBe(false);
        expect(error.message).toBe('400 invalid request: prompt is too long');
        expect(mock.requests).toHaveLength(1);
    });

    it('marks rate limits and server errors as retryable', async () => {
        mock.queue(errorReply(429, 'rate limit exceeded', 'rate_limit_error'));
        expect((await failure(callMiniMax(baseRequest({ onDelta: () => undefined })))).retryable).toBe(true);
        mock.queue((res) => {
            res.writeHead(502, { 'content-type': 'text/html' });
            res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
        });
        const gateway = await failure(callMiniMax(baseRequest({ clientApiKey: 'byok', onDelta: () => undefined })));
        expect(gateway.retryable).toBe(true);
        expect(gateway.message).toBe('502 502 Bad Gateway');
    });

    it('explains a proxy that is down instead of echoing its error page', async () => {
        mock.queue((res) => {
            res.writeHead(404, { 'content-type': 'text/html' });
            res.end('<!DOCTYPE html><title>Page not found</title>');
        });
        const error = await failure(callMiniMax(baseRequest({ onDelta: () => undefined })));
        expect(error.message).toMatch(/^The ShellMind AI proxy \(127\.0\.0\.1:\d+\) is not available \(HTTP 404\)\. Add your own MiniMax or Gemini API key in Settings/);
        expect(error.message).not.toContain('<');
        expect(error.retryable).toBe(false);

        // MiniMax's own API is not "the proxy".
        mock.queue((res) => {
            res.writeHead(404);
            res.end();
        });
        expect((await failure(callMiniMax(baseRequest({ clientApiKey: 'byok', onDelta: () => undefined })))).message).toBe('404 Not Found');
    });

    it('accepts a proxy that answers a stream request with plain JSON', async () => {
        mock.queue(jsonReply('whole answer'));
        const { deltas, onDelta } = collect();
        await expect(callMiniMax(baseRequest({ onDelta }))).resolves.toEqual({ text: 'whole answer', stopReason: 'end_turn' });
        expect(deltas).toEqual(['whole answer']);
    });
});

describe('callMiniMax (JSON)', () => {
    it('shares the attempt policy with streaming', async () => {
        mock.queue(errorReply(403, 'forbidden'), jsonReply(''), jsonReply('finally'));
        await expect(callMiniMax(baseRequest({ clientApiKey: 'byok' }))).resolves.toEqual({ text: 'finally', stopReason: 'end_turn' });
        expect(mock.requests.map((request) => [request.path, request.body.stream])).toEqual([
            [DIRECT_PATH, undefined],
            [PROXY_PATH, undefined],
            [PROXY_PATH, undefined]
        ]);
        expect(mock.requests[1].body.messages?.at(-1)?.content[0].text).not.toMatch(/IMPORTANT/);
        expect(mock.requests[2].body.messages?.at(-1)?.content[0].text).toMatch(/IMPORTANT/);
    });

    it('asks for a final answer on the same route', async () => {
        mock.queue(jsonReply(''), jsonReply('final'));
        await expect(callMiniMax(baseRequest({ clientApiKey: 'byok' }))).resolves.toMatchObject({ text: 'final' });
        expect(mock.requests.map((request) => request.path)).toEqual([DIRECT_PATH, DIRECT_PATH]);
    });

    it('gives up after the last attempt', async () => {
        mock.queue(jsonReply(''), jsonReply(''));
        const error = await failure(callMiniMax(baseRequest()));
        expect(error.message).toMatch(/no final text content/);
        expect(mock.requests).toHaveLength(2);
    });
});

describe('callMiniMax limits', () => {
    const quick = { connectMs: 150, idleMs: 150, totalMs: 5000 };

    it('times out when the proxy never answers', async () => {
        mock.queue(hangReply());
        const error = await failure(callMiniMax(baseRequest({ onDelta: () => undefined, timeouts: quick })));
        expect(error.type).toBe('timeout');
        expect(error.retryable).toBe(true);
        expect(error.message).toMatch(/did not respond/);
    });

    it('times out when a stream goes silent', async () => {
        mock.queue(hangReply(true));
        const error = await failure(callMiniMax(baseRequest({ onDelta: () => undefined, timeouts: quick })));
        expect(error.message).toMatch(/stopped sending data/);
    });

    it('closes the upstream request when the caller aborts', async () => {
        mock.queue(hangReply(true));
        const controller = new AbortController();
        const call = callMiniMax(baseRequest({ onDelta: () => undefined, signal: controller.signal }));
        await expect.poll(() => mock.requests.length).toBe(1);

        controller.abort();

        await expect(call).rejects.toThrow();
        await mock.requests[0].closed;
    });

    it('refuses to send prompts over plain http to a host that is not local', async () => {
        const proxy = await failure(callMiniMax(baseRequest({ proxyBaseUrl: 'http://proxy.example.com/anthropic/v1' })));
        expect(proxy.message).toMatch(/^MINIMAX_PROXY_URL must use https/);
        const direct = await failure(callMiniMax(baseRequest({ clientApiKey: 'byok', apiBaseUrl: 'http://api.example.com/anthropic' })));
        expect(direct.message).toMatch(/^MINIMAX_API_BASE_URL must use https/);
        expect(mock.requests).toHaveLength(0);
    });
});

describe('nextMiniMaxStep', () => {
    const plan = { direct: true, forceFinal: false };

    it('stops after the last attempt', () => {
        expect(nextMiniMaxStep({ direct: false, forceFinal: false }, { kind: 'empty', detail: 'x' }, MAX_MINIMAX_ATTEMPTS).action).toBe('fail');
        expect(nextMiniMaxStep(plan, { kind: 'http-error', status: 401, message: 'nope' }, MAX_MINIMAX_ATTEMPTS).action).toBe('fail');
    });

    it('switches to the proxy only for a rejected key', () => {
        expect(nextMiniMaxStep(plan, { kind: 'http-error', status: 401, message: '401 nope' }, 1)).toMatchObject({ action: 'retry', plan: { direct: false } });
        expect(nextMiniMaxStep(plan, { kind: 'http-error', status: 500, message: '500 down' }, 1).action).toBe('fail');
        expect(nextMiniMaxStep(plan, { kind: 'empty', detail: 'x' }, 1)).toMatchObject({ action: 'retry', plan: { direct: true, forceFinal: true } });
    });

    it('recognizes rejected client keys only', () => {
        expect(isClientKeyRejection(401, '')).toBe(true);
        expect(isClientKeyRejection(400, 'Invalid API key provided')).toBe(true);
        expect(isClientKeyRejection(400, 'invalid request: too many tokens')).toBe(false);
        expect(isClientKeyRejection(500, 'api key backend down')).toBe(false);
    });
});
