import { describe, expect, it } from 'vitest';
import type { ServerSummary } from '../../shared/types';
import { connectionFingerprint } from './scan';

// CR-05: a reading belongs to the connection the SSH pool makes. A Windows
// server keeps its SSH port in ssh_port; its `port` is the RDP port.

const windows = (extra: Partial<ServerSummary> = {}): ServerSummary => ({ id: 7, name: 'win', ip: '203.0.113.5', type: 'windows', port: 3389, ssh_port: 2222, username: 'ops', updated_at: 1, ...extra });
const linux = (extra: Partial<ServerSummary> = {}): ServerSummary => ({ id: 8, name: 'web', ip: 'web.example', type: 'linux', port: 22, username: 'root', updated_at: 1, ...extra });

describe('the fingerprint of a patch reading', () => {
    it('changes with a Windows server\'s SSH port, not with its RDP port', () => {
        expect(connectionFingerprint(windows({ ssh_port: 2223 }))).not.toBe(connectionFingerprint(windows()));
        expect(connectionFingerprint(windows({ port: 3390 }))).toBe(connectionFingerprint(windows()));
    });

    it('changes with what the connection uses, and only with that', () => {
        const base = connectionFingerprint(linux());
        for (const change of [{ port: 2200 }, { ip: 'db.example' }, { username: 'ops' }, { jump_server_id: 3 }, { identity_id: 4 }, { type: 'windows' as const }]) {
            expect(connectionFingerprint(linux(change)), JSON.stringify(change)).not.toBe(base);
        }
        // The same host written differently, and a port left to its default.
        expect(connectionFingerprint(linux({ ip: 'WEB.example' }))).toBe(base);
        expect(connectionFingerprint(linux({ port: null }))).toBe(base);
        expect(connectionFingerprint(linux({ name: 'renamed', notes: 'x' }))).toBe(base);
    });
});
