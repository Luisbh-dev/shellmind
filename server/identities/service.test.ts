import { describe, expect, it } from 'vitest';
import type { InstallEvent } from '../../shared/identities';
import type { SshTarget } from '../connections/target';
import type { SshLease } from '../ssh/pool';
import { generateEd25519 } from './keys';
import { installKey, type InstallDeps, type KeyPair } from './service';

const pair = generateEd25519('t');
const key: KeyPair = { privateKey: pair.privateKey, passphrase: null, info: pair };

const lease = (serverId: number): SshLease => ({
    serverId,
    client: {} as SshLease['client'],
    target: { serverId, os: 'linux' } as SshTarget,
    release: () => undefined,
    onClose: () => () => undefined,
});

describe('installKey', () => {
    it('installs on servers sharing an account one after the other, and on the rest in parallel', async () => {
        const accounts: Record<number, string> = { 1: 'alice@host', 2: 'alice@host', 3: 'bob@host', 4: 'alice@host' };
        const running = new Map<string, number>();
        let maxPerAccount = 0;
        let maxOverall = 0;
        const order: number[] = [];
        const deps: InstallDeps = {
            acquire: async (serverId) => lease(serverId),
            accountOf: async (serverId) => accounts[serverId],
            verify: async () => ({ ok: true }),
            record: async () => undefined,
            remove: async () => ({ status: 'absent', removed: 0, file: null }),
            install: async (held) => {
                const account = accounts[held.serverId];
                running.set(account, (running.get(account) ?? 0) + 1);
                maxPerAccount = Math.max(maxPerAccount, running.get(account) ?? 0);
                maxOverall = Math.max(maxOverall, [...running.values()].reduce((sum, count) => sum + count, 0));
                await new Promise((resolve) => setTimeout(resolve, 20));
                running.set(account, (running.get(account) ?? 1) - 1);
                order.push(held.serverId);
                return { status: order.filter((id) => accounts[id] === account).length > 1 ? 'present' : 'installed', file: null, warnings: [] };
            },
        };
        const events: InstallEvent[] = [];
        const results = await installKey({
            servers: [1, 2, 3, 4].map((serverId) => ({ serverId, name: `s${serverId}` })),
            key,
            identity: { id: 9, name: 'deploy' },
            signal: new AbortController().signal,
            emit: (event) => events.push(event),
            action: 'install',
        }, deps);

        expect(maxPerAccount).toBe(1);
        expect(maxOverall).toBe(2);
        expect(order.filter((id) => accounts[id] === 'alice@host')).toEqual([1, 2, 4]);
        expect(results.map((result) => [result.serverId, result.status, result.verified])).toEqual(expect.arrayContaining([
            [1, 'installed', true], [2, 'present', true], [3, 'installed', true], [4, 'present', true],
        ]));
        expect(events.filter((event) => event.type === 'result')).toHaveLength(4);
    });

    it('reports the servers it did not start once cancelled', async () => {
        const controller = new AbortController();
        const deps: InstallDeps = {
            acquire: async (serverId) => lease(serverId),
            accountOf: async () => 'same',
            verify: async () => ({ ok: true }),
            record: async () => undefined,
            remove: async () => ({ status: 'absent', removed: 0, file: null }),
            install: async () => {
                controller.abort();
                return { status: 'installed', file: null, warnings: [] };
            },
        };
        const results = await installKey({
            servers: [{ serverId: 1, name: 'a' }, { serverId: 2, name: 'b' }],
            key, identity: { id: 1, name: 'x' }, signal: controller.signal, emit: () => undefined, action: 'install',
        }, deps);
        expect(results).toEqual([
            { serverId: 1, name: 'a', status: 'installed', warnings: [] },
            { serverId: 2, name: 'b', status: 'failed', errorCode: 'CANCELLED', error: 'Cancelled.' },
        ]);
    });
});
