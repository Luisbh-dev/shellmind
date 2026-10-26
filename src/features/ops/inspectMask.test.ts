import { describe, expect, it } from 'vitest';
import podmanInspect from '../../../test/fixtures/ops/podman-inspect.json';
import dockerInspect from '../../../test/fixtures/ops/docker-inspect.json';
import { maskInspect } from './inspectMask';

// W7-S3: the raw inspect output of the container panel shows no environment
// value until the user reveals them (Docker's Config.Env, and Podman's
// Config.CreateCommand, which repeats every -e).

const MASK = '••••••••';
const SECRETS = ['topsecret-podman', 'key-from-flag', 'glued-token'];

describe('maskInspect', () => {
    it('masks Config.Env and the -e, --env= and -eKEY= arguments of Podman\'s CreateCommand', () => {
        const [raw] = podmanInspect as Array<{ Config: { Env: string[]; CreateCommand: string[] } }>;
        const text = JSON.stringify(raw);
        for (const secret of SECRETS) expect(text).toContain(secret);

        const masked = maskInspect(raw, MASK) as typeof raw;
        const maskedText = JSON.stringify(masked);
        for (const secret of SECRETS) expect(maskedText).not.toContain(secret);
        expect(maskedText).not.toContain('MODE=prod');
        expect(masked.Config.Env).toContain(`DB_PASSWORD=${MASK}`);
        expect(masked.Config.CreateCommand).toEqual([
            'podman', 'run', '-d', '--name', 'envtest',
            '-e', `DB_PASSWORD=${MASK}`, `--env=API_KEY=${MASK}`, `-eTOKEN=${MASK}`, '-e', `MODE=${MASK}`,
            '--label', 'app=envtest', 'docker.io/library/alpine:3', 'sleep', 'infinity',
        ]);
        // Everything else is as the engine printed it.
        expect(masked).toMatchObject({ Name: 'envtest', Config: { Hostname: (raw.Config as { Hostname?: string }).Hostname } });
        expect(raw.Config.Env).toContain('DB_PASSWORD=topsecret-podman');
    });

    it('masks a value given with -e that the environment no longer lists, and leaves other arguments alone', () => {
        const raw = { Config: { Env: ['A=1'], CreateCommand: ['podman', 'run', '-e', 'OLD=stale-secret', '-e', 'FROM_HOST', '--name', 'x=y'] }, Args: ['--level=A=1x'] };
        expect(maskInspect(raw, MASK)).toEqual({
            Config: { Env: [`A=${MASK}`], CreateCommand: ['podman', 'run', '-e', `OLD=${MASK}`, '-e', 'FROM_HOST', '--name', 'x=y'] },
            Args: [`--level=A=${MASK}x`],
        });
    });

    it('masks Docker\'s environment and keeps what is not an object as it is', () => {
        // The route answers the first (only) object of `docker inspect`.
        const [raw] = dockerInspect as Array<{ Config: { Env: string[] } }>;
        const masked = JSON.stringify(maskInspect(raw, MASK));
        expect(raw.Config.Env.length).toBeGreaterThan(0);
        for (const entry of raw.Config.Env) {
            const [name, value] = [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)];
            if (value) expect(masked).toContain(`"${name}=${MASK}"`);
        }
        expect(maskInspect(null, MASK)).toBeNull();
        expect(maskInspect('text', MASK)).toBe('text');
    });
});
