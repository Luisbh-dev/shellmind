import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AgentProtocol, utils, type ParsedKey } from 'ssh2';

// W7-S2: an in-process SSH agent for tests, speaking the OpenSSH agent
// protocol on a Unix socket (a named pipe on Windows) like ssh-agent or the
// Windows OpenSSH agent. It offers the given private keys and signs with them.

export type FakeAgent = {
    // What SHELLMIND_SSH_AGENT / SSH_AUTH_SOCK point at.
    path: string;
    // "identities" and "sign:<key type>" per request served.
    log: string[];
    close: () => Promise<void>;
};

function parsePrivate(key: string): ParsedKey {
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error) throw parsed;
    return Array.isArray(parsed) ? parsed[0] : parsed;
}

export async function startFakeAgent(privateKeys: string[]): Promise<FakeAgent> {
    const keys = privateKeys.map(parsePrivate);
    const log: string[] = [];
    const sockets = new Set<net.Socket>();
    const id = randomBytes(6).toString('hex');
    const dir = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-agent-'));
    const agentPath = dir ? path.join(dir, 'agent.sock') : `\\\\.\\pipe\\shellmind-test-agent-${id}`;

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        const protocol = new AgentProtocol(false);
        protocol.on('error', () => socket.destroy());
        socket.pipe(protocol).pipe(socket);
        protocol.on('identities', (request) => {
            log.push('identities');
            protocol.getIdentitiesReply(request, keys);
        });
        protocol.on('sign', (request, publicKey, data, options) => {
            const key = keys.find((candidate) => candidate.getPublicSSH().equals(publicKey.getPublicSSH()));
            if (!key) return protocol.failureReply(request);
            log.push(`sign:${key.type}`);
            protocol.signReply(request, key.sign(data, options?.hash));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(agentPath, () => resolve());
    });

    return {
        path: agentPath,
        log,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (dir) fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
