import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiErrorCode, apiStream, getApiBase, unwrapData } from './api';

const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const mockFetch = (...responses: Array<Response | Error>) => {
    const fn = vi.fn();
    for (const response of responses) {
        if (response instanceof Error) fn.mockRejectedValueOnce(response);
        else fn.mockResolvedValueOnce(response);
    }
    vi.stubGlobal('fetch', fn);
    return fn;
};

// The rejection value of a request that is expected to fail.
const rejectionOf = (promise: Promise<unknown>): Promise<ApiError> =>
    promise.then(
        () => { throw new Error('expected the request to fail'); },
        (error: ApiError) => error
    );

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('api', () => {
    it('defaults to the local backend', () => {
        expect(getApiBase()).toBe('http://127.0.0.1:3001');
    });

    it('GETs JSON from the API base without a body', async () => {
        const fetchMock = mockFetch(jsonResponse(200, { message: 'success', data: [] }));

        await expect(api.get('/api/servers')).resolves.toEqual({ message: 'success', data: [] });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:3001/api/servers');
        expect(init).toMatchObject({ method: 'GET', body: undefined });
        expect(init.headers).toEqual({});
    });

    it('sends JSON bodies with a content type', async () => {
        const fetchMock = mockFetch(jsonResponse(200, { message: 'success' }));

        await api.patch('/api/servers/4/os', { os_detail: 'Ubuntu 24.04' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:3001/api/servers/4/os');
        expect(init.method).toBe('PATCH');
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(JSON.parse(init.body)).toEqual({ os_detail: 'Ubuntu 24.04' });
    });

    it('sends a body with DELETE when given one', async () => {
        const fetchMock = mockFetch(jsonResponse(200, { message: 'success' }));

        await api.del('/api/config/apikey', { provider: 'gemini' });

        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE', body: '{"provider":"gemini"}' });
    });

    it('resolves undefined for an empty success body', async () => {
        mockFetch(new Response(null, { status: 204 }));
        await expect(api.post('/api/anything')).resolves.toBeUndefined();
    });

    it('rejects a non-OK response with the server message', async () => {
        mockFetch(jsonResponse(403, { error: 'Key is set via environment' }));

        const error = await rejectionOf(api.post('/api/config/apikey', { provider: 'gemini', key: 'x' }));

        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(403);
        expect(error.message).toBe('Key is set via environment');
        expect(error.body).toEqual({ error: 'Key is set via environment' });
        expect(error.isNetworkError).toBe(false);
    });

    it('reduces an HTML error page to readable text and keeps the raw body', async () => {
        const html = '<!DOCTYPE html><html><body><pre>Cannot GET /api/servers/1/status</pre></body></html>';
        mockFetch(new Response(html, { status: 404, headers: { 'Content-Type': 'text/html' } }));

        const error = await rejectionOf(api.get('/api/servers/1/status'));

        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(404);
        expect(error.message).toBe('Cannot GET /api/servers/1/status');
        expect(error.body).toBe(html);
    });

    it('falls back to the status text for an empty error body', async () => {
        mockFetch(new Response(null, { status: 500, statusText: 'Internal Server Error' }));

        await expect(api.get('/api/servers')).rejects.toMatchObject({ status: 500, message: 'Internal Server Error' });
    });

    it('rejects a success response that is not JSON', async () => {
        mockFetch(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));

        const error = await rejectionOf(api.get('/api/servers'));

        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(200);
        expect(error.body).toBe('<html></html>');
    });

    it('reports an unreachable backend as status 0', async () => {
        const cause = new TypeError('fetch failed');
        mockFetch(cause);

        const error = await rejectionOf(api.get('/api/servers'));

        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(0);
        expect(error.isNetworkError).toBe(true);
        expect(error.cause).toBe(cause);
    });

    it('passes an AbortError through untouched', async () => {
        mockFetch(new DOMException('The operation was aborted.', 'AbortError'));

        const error = await rejectionOf(api.get('/api/servers', { signal: AbortSignal.abort() }));

        expect(error).not.toBeInstanceOf(ApiError);
        expect(error.name).toBe('AbortError');
    });

    it('exposes the error code and details of the backend body', async () => {
        mockFetch(jsonResponse(409, { error: 'In use', code: 'JUMP_HOST_IN_USE', details: { dependents: [{ id: 2, name: 'db' }] } }));
        const error = await rejectionOf(api.del('/api/servers/1'));
        expect(error.code).toBe('JUMP_HOST_IN_USE');
        expect(error.details).toEqual({ dependents: [{ id: 2, name: 'db' }] });
        expect(apiErrorCode(error)).toBe('JUMP_HOST_IN_USE');

        mockFetch(new Response('<h1>Bad gateway</h1>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
        const plain = await rejectionOf(api.get('/api/servers'));
        expect(plain.code).toBeNull();
        expect(plain.details).toBeNull();
        expect(apiErrorCode(new Error('nope'))).toBeNull();
    });

    it('unwraps the data of an enveloped answer', async () => {
        mockFetch(jsonResponse(200, { message: 'success', data: [{ id: 1 }] }), jsonResponse(200, { message: 'success' }));
        await expect(api.data('/api/servers')).resolves.toEqual([{ id: 1 }]);
        const error = await rejectionOf(api.data('/api/servers'));
        expect(error).toBeInstanceOf(ApiError);
        expect(error.message).toBe('The server returned an invalid response.');
        expect(unwrapData({ data: null })).toBeNull();
    });
});

describe('apiStream', () => {
    it('POSTs JSON and returns the raw response for the caller to read', async () => {
        const response = new Response('data: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
        const fetchMock = mockFetch(response);
        const controller = new AbortController();

        const res = await apiStream('/api/chat', { message: 'hi', stream: true }, { signal: controller.signal });

        expect(res).toBe(response);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:3001/api/chat');
        expect(init.method).toBe('POST');
        expect(init.signal).toBe(controller.signal);
        expect(init.headers).toEqual({
            Accept: 'text/event-stream, application/json',
            'Content-Type': 'application/json'
        });
    });

    it('rejects a non-OK response with ApiError', async () => {
        mockFetch(jsonResponse(413, { error: 'request entity too large' }));

        await expect(apiStream('/api/chat', { message: 'x' })).rejects.toMatchObject({
            name: 'ApiError',
            status: 413,
            message: 'request entity too large'
        });
    });
});
