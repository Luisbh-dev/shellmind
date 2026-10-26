import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { streamReply, type MockHandler } from '../../helpers/anthropicMock';

// A local stand-in for the Anthropic-compatible MiniMax proxy the backend
// calls without a user key (MINIMAX_PROXY_URL). It streams every answer in
// small deltas, picks the answer from the last user message (the specs steer
// it with the markers below) and keeps what it was sent, which the specs read
// back from GET /__mock/requests.

// The chat asks for a command: Auto-Run types it into the terminal.
export const AUTORUN_MARKER = 'e2e-autorun';
export const AUTORUN_COMMAND = 'echo "autorun-ok-$((6*7))"';
export const AUTORUN_OUTPUT = 'autorun-ok-42';
// The chat suggests a destructive command: Auto-Run must wait for the user.
// (Harmless if it ever ran: the test hosts have no mkfs and no such device.)
export const DANGEROUS_MARKER = 'e2e-dangerous';
export const DANGEROUS_COMMAND = 'mkfs.ext4 /dev/e2e-disk';

export type RecordedRequest = {
    path: string;
    model?: string;
    system: string;
    // The last user message, all its text blocks joined.
    lastUser: string;
    messages: number;
};

export type AiMock = {
    url: string;
    close: () => Promise<void>;
};

type Content = string | Array<{ type?: string; text?: string }>;
type Body = { model?: string; system?: Content; messages?: Array<{ role?: string; content?: Content }> };

function text(content: Content | undefined): string {
    if (typeof content === 'string') return content;
    return (content ?? []).map((block) => block.text ?? '').join('\n');
}

// The last user message also carries the recent terminal output, so the
// markers are checked in this order.
function answerFor(lastUser: string): MockHandler {
    const delayMs = 40;
    if (lastUser.includes(DANGEROUS_MARKER)) {
        return streamReply(['This would clean it up:\n\n', '```bash\n', `${DANGEROUS_COMMAND}\n`, '```\n'], { delayMs });
    }
    if (lastUser.includes(AUTORUN_OUTPUT)) {
        return streamReply(['The command ', 'printed ', `${AUTORUN_OUTPUT}. `, 'Nothing else to run.'], { delayMs });
    }
    if (lastUser.includes(AUTORUN_MARKER)) {
        return streamReply(['Run this to check the shell:\n\n', '```bash\n', `${AUTORUN_COMMAND}\n`, '```\n'], { delayMs });
    }
    // Slow enough to see the answer arrive (and stop it).
    return streamReply(['Mock answer: ', 'streaming ', 'works ', 'from the ', 'local provider.'], { delayMs: 300 });
}

export async function startAiMock(): Promise<AiMock> {
    const requests: RecordedRequest[] = [];
    const sockets = new Set<Socket>();

    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/__mock/requests') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(requests));
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            let body: Body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
            } catch {
                // Not JSON: answered like an empty conversation.
            }
            const users = (body.messages ?? []).filter((message) => message.role === 'user');
            const lastUser = text(users.at(-1)?.content);
            requests.push({ path: req.url ?? '', model: body.model, system: text(body.system), lastUser, messages: body.messages?.length ?? 0 });
            Promise.resolve(answerFor(lastUser)(res, { path: req.url ?? '', headers: req.headers, body: {}, closed: Promise.resolve() }))
                .catch(() => res.destroy());
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
        close: () => new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        }),
    };
}
