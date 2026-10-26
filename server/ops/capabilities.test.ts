import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CMD_LINE_LIMIT, encodedPowerShellCommand } from './remote';
import { LINUX_CAPABILITIES_SCRIPT, WINDOWS_CAPABILITIES_SCRIPT, parseLinuxCapabilities, parseWindowsCapabilities } from './capabilities';

const report = (sections: Record<string, string>) =>
    `${Object.entries(sections).map(([name, body]) => `\n@@SM:${name}\n${body}`).join('')}\n@@SM:end\n`;

describe('parseLinuxCapabilities', () => {
    it('detects root, systemd, the journal and Docker with compose', () => {
        const caps = parseLinuxCapabilities(report({ uid: '0', sudo: '', systemd: 'yes', journal: 'yes', docker: 'ok 26.1.4', podman: '', compose: 'yes' }), 5);
        expect(caps).toEqual({
            platform: 'linux', root: true, sudo: false, systemd: true, journal: true,
            containers: { engine: 'docker', version: '26.1.4', sudo: false, compose: true, problem: null },
            detectedAt: 5,
        });
    });

    it('uses sudo for Docker when the socket is not the user\'s', () => {
        const caps = parseLinuxCapabilities(report({ uid: '1000', sudo: 'yes', systemd: 'yes', journal: 'yes', docker: 'sudo 24.0.7', compose: '' }));
        expect(caps).toMatchObject({ root: false, sudo: true, containers: { engine: 'docker', sudo: true, version: '24.0.7', compose: false } });
    });

    it('falls back to Podman and explains why Docker is unusable', () => {
        const podman = parseLinuxCapabilities(report({ uid: '1000', docker: '', podman: 'ok 4.9.3' }));
        expect(podman.containers).toEqual({ engine: 'podman', version: '4.9.3', sudo: false, compose: false, problem: null });

        const denied = parseLinuxCapabilities(report({
            uid: '1000',
            docker: 'error permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
        }));
        expect(denied.containers).toMatchObject({ engine: null, problem: expect.stringMatching(/^permission denied/) });
        expect(parseLinuxCapabilities(report({ uid: '1000' })).containers.problem).toMatch(/Neither Docker nor Podman/);
    });

    it('refuses a cut-off report', () => {
        expect(() => parseLinuxCapabilities('@@SM:uid\n0\n')).toThrow(/cut off/);
    });

    it('keeps the Docker template in single quotes for sh', () => {
        expect(LINUX_CAPABILITIES_SCRIPT).toContain("docker version --format '{{.Server.Version}}'");
        expect(LINUX_CAPABILITIES_SCRIPT).toContain('sudo -n true');
    });
});

// The real script in a real sh, with stand-ins for id, sudo and docker.
const HAS_SH = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe.skipIf(!HAS_SH)('LINUX_CAPABILITIES_SCRIPT in sh', () => {
    let bin: string;
    beforeAll(() => {
        bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-caps-'));
        const stub = (name: string, body: string) => {
            fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
            fs.chmodSync(path.join(bin, name), 0o755);
        };
        stub('id', 'echo 1000');
        // Passwordless sudo that runs the command as the same user.
        stub('sudo', '[ "$1" = -n ] && shift; [ "$1" = true ] && exit 0; exec "$@"');
        stub('docker', 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1');
    });
    afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

    it('keeps Docker\'s own error when the sudo attempt fails too', () => {
        const result = spawnSync('sh', ['-s'], { input: LINUX_CAPABILITIES_SCRIPT, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } });
        const caps = parseLinuxCapabilities(result.stdout);
        expect(caps).toMatchObject({ root: false, sudo: true });
        expect(caps.containers).toMatchObject({ engine: null, problem: expect.stringMatching(/^Cannot connect to the Docker daemon/) });
    });
});

describe('parseWindowsCapabilities', () => {
    it('reads the JSON report', () => {
        expect(parseWindowsCapabilities('{"admin":true,"docker":"ok 24.0.7","compose":true}', 3)).toEqual({
            platform: 'windows', root: true, sudo: false, systemd: false, journal: false,
            containers: { engine: 'docker', version: '24.0.7', sudo: false, compose: true, problem: null },
            detectedAt: 3,
        });
        expect(parseWindowsCapabilities('{"admin":false,"docker":null,"compose":false}').containers).toMatchObject({ engine: null, problem: 'Docker is not installed.' });
        expect(() => parseWindowsCapabilities('')).toThrow(/no data/);
    });

    it('fits on a cmd.exe command line in the encoded fallback', () => {
        expect(encodedPowerShellCommand(WINDOWS_CAPABILITIES_SCRIPT).length).toBeLessThan(CMD_LINE_LIMIT);
    });
});
