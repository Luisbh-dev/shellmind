import { randomBytes } from 'node:crypto';
import http from 'node:http';

export type RawResponse = { status: number; headers: http.IncomingHttpHeaders; text: string; body: unknown };

function readResponse(res: http.IncomingMessage): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = null;
            try { body = JSON.parse(text); } catch { /* not JSON */ }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
        });
    });
}

// A request through node:http, which (unlike fetch) lets tests forge the Host
// header the way a DNS-rebinding page would send it.
export function rawRequest(
    port: number,
    options: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: options.method ?? 'GET',
            path: options.path,
            headers: options.headers,
        }, (res) => readResponse(res).then(resolve, reject));
        req.on('error', reject);
        req.end(options.body);
    });
}

// A WebSocket handshake with forged headers: status 101 when the server
// accepted the upgrade, else the status and body of its refusal.
export function rawUpgrade(
    port: number,
    options: { path: string; headers?: Record<string, string> }
): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: options.path,
            headers: {
                connection: 'Upgrade',
                upgrade: 'websocket',
                'sec-websocket-version': '13',
                'sec-websocket-key': randomBytes(16).toString('base64'),
                ...options.headers,
            },
        });
        req.on('upgrade', (res, socket) => {
            socket.destroy();
            resolve({ status: res.statusCode ?? 0, text: '' });
        });
        req.on('response', (res) => readResponse(res).then(({ status, text }) => resolve({ status, text }), reject));
        req.on('error', reject);
        req.end();
    });
}
