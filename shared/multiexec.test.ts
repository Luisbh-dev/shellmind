import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, batchOfPositions, countStatuses, isJobFinal, planBatches, reachesFailureLimit } from './multiexec';
import { groupByOutput, hashText, normalizeOutput, outputHashes, type GroupableRun } from './multiexecOutput';

describe('planBatches', () => {
    it('puts every server in one batch by default', () => {
        expect(planBatches(7, DEFAULT_STRATEGY)).toEqual([7]);
        expect(planBatches(0, DEFAULT_STRATEGY)).toEqual([]);
    });

    it('runs the canary first, then batches of N servers or N %', () => {
        expect(planBatches(10, { batch: { size: 3, unit: 'servers' }, canary: null })).toEqual([3, 3, 3, 1]);
        expect(planBatches(40, { batch: { size: 25, unit: 'percent' }, canary: { count: 2, onSuccess: 'pause' } })).toEqual([2, 10, 10, 10, 8]);
        expect(planBatches(5, { batch: null, canary: { count: 1, onSuccess: 'continue' } })).toEqual([1, 4]);
        // A tiny percentage is still a server per batch.
        expect(planBatches(3, { batch: { size: 1, unit: 'percent' }, canary: null })).toEqual([1, 1, 1]);
        // A canary as large as the job is no canary.
        expect(planBatches(2, { batch: null, canary: { count: 2, onSuccess: 'pause' } })).toEqual([2]);
        expect(batchOfPositions([1, 2, 1])).toEqual([0, 1, 1, 2]);
    });
});

describe('the failure limit', () => {
    it('is reached by a count or a share of all the servers', () => {
        expect(reachesFailureLimit(null, 5, 10)).toBe(false);
        expect(reachesFailureLimit({ count: 2, percent: null }, 1, 10)).toBe(false);
        expect(reachesFailureLimit({ count: 2, percent: null }, 2, 10)).toBe(true);
        expect(reachesFailureLimit({ count: null, percent: 30 }, 2, 10)).toBe(false);
        expect(reachesFailureLimit({ count: null, percent: 30 }, 3, 10)).toBe(true);
        expect(reachesFailureLimit({ count: 5, percent: 10 }, 1, 10)).toBe(true);
        expect(reachesFailureLimit({ count: 1, percent: null }, 0, 10)).toBe(false);
    });

    it('counts statuses and knows the final job states', () => {
        expect(countStatuses(['ok', 'ok', 'failed', 'skipped'])).toMatchObject({ ok: 2, failed: 1, skipped: 1, queued: 0 });
        expect(['done', 'stopped', 'cancelled', 'interrupted'].every((status) => isJobFinal(status as never))).toBe(true);
        expect(isJobFinal('paused')).toBe(false);
    });
});

describe('output grouping', () => {
    const web1 = { name: 'web-1', host: 'web-1.prod.example.com' };

    it('masks what differs from host to host on its own', () => {
        expect(normalizeOutput(
            'web-1 up since 2026-10-24T17:15:06Z, load 0.10\r\nweb-1.prod.example.com sshd[1234]: Accepted at Oct 24 17:15:06  \nMain PID: 987 (nginx)\n\n',
            web1
        )).toBe('<host> up since <time>, load 0.10\n<host> sshd[<pid>]: Accepted at <date> <time>\nMain PID: <pid> (nginx)');
        // Only whole names: web-10 is another host.
        expect(normalizeOutput('web-10 web-1', web1)).toBe('web-10 <host>');
        expect(normalizeOutput('dated 2026-10-24 and 24/10/2026', web1)).toBe('dated <date> and <date>');
    });

    it('hashes outputs exactly and normalized', () => {
        expect(hashText('abc')).toBe(hashText('abc'));
        expect(hashText('abc')).not.toBe(hashText('abd'));
        expect(hashText('abc')).toMatch(/^[0-9a-f]{14}$/);
        const one = outputHashes('web-1 ok at 10:00:01\n', '', web1);
        const two = outputHashes('web-2 ok at 10:00:07\n', '', { name: 'web-2', host: '10.0.0.2' });
        expect(one.outputHash).not.toBe(two.outputHash);
        expect(one.normalizedHash).toBe(two.normalizedHash);
        // stdout and stderr are told apart.
        expect(outputHashes('a', '', web1).outputHash).not.toBe(outputHashes('', 'a', web1).outputHash);
    });

    it('groups finished servers by output and exit code, largest first, the ones without output last', () => {
        const run = (serverId: number, overrides: Partial<GroupableRun>): GroupableRun => ({
            serverId, status: 'ok', exitCode: 0, errorCode: null, outputHash: 'x', normalizedHash: 'n', ...overrides,
        });
        const runs = [
            run(1, {}),
            run(2, { outputHash: 'y' }),
            run(3, {}),
            run(4, { status: 'failed', exitCode: 1, outputHash: 'z', normalizedHash: 'z' }),
            run(5, { status: 'failed', exitCode: null, errorCode: 'AUTH_FAILED', outputHash: null, normalizedHash: null }),
            run(6, { status: 'running', outputHash: null, normalizedHash: null }),
            run(7, { status: 'ok', exitCode: 2, outputHash: 'x', normalizedHash: 'n' }),
        ];
        expect(groupByOutput(runs, 'exact').map((group) => [group.kind, group.members.map((member) => member.serverId)])).toEqual([
            ['output', [1, 3]], ['output', [2]], ['output', [4]], ['output', [7]], ['none', [5]],
        ]);
        expect(groupByOutput(runs, 'normalized').map((group) => group.members.map((member) => member.serverId))).toEqual([[1, 2, 3], [4], [7], [5]]);
    });

    // CR-03: each server masks its own name, address and host name, which
    // can be a word of everyone's output: the same bytes gave three groups.
    it('never splits outputs that are the same byte for byte', () => {
        const stdout = 'Description:\tUbuntu 22.04.4 LTS\nnginx is running\n';
        const servers = [
            { serverId: 1, name: 'web-1', host: '10.0.0.11', hostname: 'ubuntu' },
            { serverId: 2, name: 'web-2', host: '10.0.0.12', hostname: 'web-2' },
            { serverId: 3, name: 'nginx', host: '10.0.0.13', hostname: 'lb-3' },
        ];
        const runs: GroupableRun[] = servers.map((server) => ({ serverId: server.serverId, status: 'ok', exitCode: 0, errorCode: null, ...outputHashes(stdout, '', server) }));
        expect(new Set(runs.map((run) => run.normalizedHash)).size).toBe(3);
        expect(groupByOutput(runs, 'exact')).toHaveLength(1);
        expect(groupByOutput(runs, 'normalized').map((group) => group.members.map((member) => member.serverId))).toEqual([[1, 2, 3]]);
    });

    it('keeps every exact group inside one normalized group, whatever the runs', () => {
        let seed = 7;
        const random = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        const statuses = ['ok', 'failed', 'timeout', 'cancelled'] as const;
        for (let round = 0; round < 300; round++) {
            const runs: GroupableRun[] = Array.from({ length: 1 + random(12) }, (_, index) => {
                const status = statuses[random(statuses.length)];
                const output = random(5) > 0;
                return {
                    serverId: index + 1,
                    status,
                    exitCode: status === 'ok' ? 0 : random(3) || null,
                    errorCode: null,
                    outputHash: output ? `x${random(4)}` : null,
                    normalizedHash: output ? `n${random(4)}` : null,
                };
            });
            const normalized = groupByOutput(runs, 'normalized');
            const groupOf = new Map(normalized.flatMap((group, index) => group.members.map((member) => [member.serverId, index] as const)));
            for (const group of groupByOutput(runs, 'exact')) {
                expect(new Set(group.members.map((member) => groupOf.get(member.serverId))).size).toBe(1);
            }
            expect(normalized.reduce((sum, group) => sum + group.members.length, 0)).toBe(runs.length);
        }
    });
});
