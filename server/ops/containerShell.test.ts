import { describe, expect, it } from 'vitest';
import { testCaps } from '../../test/helpers/opsCaps';
import { AUTO_SHELL_SCRIPT, containerShellCommand, hangUpScript, newTerminalTag, parseTerminalAttach } from './containerShell';
import { engineCommand, requireEngine } from './containers';

// W7-S3: the attach field of start-ssh and the command of a container's terminal.

describe('parseTerminalAttach', () => {
    it('reads a container attachment, without or with a shell', () => {
        expect(parseTerminalAttach(undefined)).toBeNull();
        expect(parseTerminalAttach(null)).toBeNull();
        expect(parseTerminalAttach({ kind: 'container', engine: 'docker', container: 'web-1' })).toEqual({ kind: 'container', engine: 'docker', container: 'web-1' });
        expect(parseTerminalAttach({ kind: 'container', engine: 'podman', container: '3f4e5d6c7b8a', shell: '/bin/bash', extra: 'ignored' }))
            .toEqual({ kind: 'container', engine: 'podman', container: '3f4e5d6c7b8a', shell: '/bin/bash' });
        expect(parseTerminalAttach({ kind: 'container', engine: 'docker', container: 'web', shell: '' })).toEqual({ kind: 'container', engine: 'docker', container: 'web' });
    });

    it('refuses anything that is not a valid name, engine or shell', () => {
        const invalid = [
            'container',
            { kind: 'pod', engine: 'docker', container: 'web' },
            { kind: 'container', engine: 'nerdctl', container: 'web' },
            { kind: 'container', engine: 'docker', container: 'web; reboot' },
            { kind: 'container', engine: 'docker', container: '-it' },
            { kind: 'container', engine: 'docker', container: 7 },
            { kind: 'container', engine: 'docker', container: 'web', shell: 'sh -c id' },
            { kind: 'container', engine: 'docker', container: 'web', shell: "bash'; id #" },
            { kind: 'container', engine: 'docker', container: 'web', shell: '$(id)' },
            { kind: 'container', engine: 'docker', container: 'web', shell: '../../bin/sh' },
            { kind: 'container', engine: 'docker', container: 'web', shell: '/bin/../bin/sh' },
            { kind: 'container', engine: 'docker', container: 'web', shell: 42 },
        ];
        for (const value of invalid) {
            expect(() => parseTerminalAttach(value), JSON.stringify(value)).toThrow(expect.objectContaining({ code: 'INVALID_ATTACH', status: 400 }));
        }
    });
});

const TAG = '0123456789abcdef0123456789abcdef';

describe('containerShellCommand', () => {
    it('runs `exec -it` with bash or sh unless a shell is chosen, tagged, quoted for the login shell', () => {
        expect(containerShellCommand(testCaps(), { kind: 'container', engine: 'docker', container: 'web-1' }, TAG))
            .toBe(`docker 'exec' '-it' '-e' 'SHELLMIND_TERMINAL=${TAG}' 'web-1' 'sh' '-c' '${AUTO_SHELL_SCRIPT}'`);
        expect(AUTO_SHELL_SCRIPT).not.toContain("'");
        expect(containerShellCommand(testCaps({ containers: { sudo: true } }), { kind: 'container', engine: 'docker', container: 'web-1', shell: 'bash' }, TAG))
            .toBe(`sudo -n docker 'exec' '-it' '-e' 'SHELLMIND_TERMINAL=${TAG}' 'web-1' 'bash'`);
        expect(containerShellCommand(testCaps({ containers: { engine: 'podman', compose: false } }), { kind: 'container', engine: 'podman', container: 'site_web_1', shell: '/bin/ash' }, TAG))
            .toBe(`podman 'exec' '-it' '-e' 'SHELLMIND_TERMINAL=${TAG}' 'site_web_1' '/bin/ash'`);
    });

    it('needs a Linux server whose engine is the one asked for', () => {
        expect(() => containerShellCommand(testCaps({ platform: 'windows' }), { kind: 'container', engine: 'docker', container: 'web' }, TAG))
            .toThrow(expect.objectContaining({ code: 'CONTAINER_SHELL_UNSUPPORTED' }));
        expect(() => containerShellCommand(testCaps({ containers: { engine: null, problem: 'permission denied while trying to connect to the Docker daemon socket' } }), { kind: 'container', engine: 'docker', container: 'web' }, TAG))
            .toThrow(expect.objectContaining({ code: 'NO_CONTAINER_ENGINE', message: 'permission denied while trying to connect to the Docker daemon socket' }));
        expect(() => containerShellCommand(testCaps(), { kind: 'container', engine: 'podman', container: 'web' }, TAG))
            .toThrow(expect.objectContaining({ code: 'CONTAINER_ENGINE_MISMATCH', details: { engine: 'docker', requested: 'podman' } }));
    });
});

describe('hanging up a container terminal', () => {
    it('gives every terminal its own tag', () => {
        const tags = new Set(Array.from({ length: 20 }, () => newTerminalTag()));
        expect(tags.size).toBe(20);
        for (const tag of tags) expect(tag).toMatch(/^[a-f0-9]{32}$/);
    });

    it('finds the tagged session leader the engine started and hangs up its session, the shell last', () => {
        const script = hangUpScript(TAG);
        expect(script).toContain(`t='SHELLMIND_TERMINAL=${TAG}'`);
        expect(script).toContain('grep -l -F "$t" /proc/[0-9]*/environ');
        // Parent 0 (started by the engine) and leading its own session.
        expect(script).toContain('[ "${2:-}" = 0 ] && [ "${4:-}" = "$p" ]');
        expect(script.indexOf('[ "$p" != "$x" ] && kill -HUP "$p"')).toBeLessThan(script.indexOf('for x in $l; do kill -HUP "$x"'));
        expect(script.endsWith('echo "hung-up $n"')).toBe(true);
        expect(() => hangUpScript("x'; reboot; '")).toThrow();
    });

    it('runs the script with sh in the container, through the engine and sudo as needed', () => {
        const caps = testCaps({ containers: { sudo: true } });
        const attach = { kind: 'container', engine: 'docker', container: 'web-1' } as const;
        const script = hangUpScript(TAG);
        // What the login shell receives: one single-quoted argument.
        const quoted = `'${script.replace(/'/g, `'\\''`)}'`;
        expect(containerShellCommand(caps, attach, TAG)).toContain("sudo -n docker 'exec' '-it'");
        expect(engineCommand(requireEngine(caps), ['exec', 'web-1', 'sh', '-c', script])).toBe(`sudo -n docker 'exec' 'web-1' 'sh' '-c' ${quoted}`);
    });
});
