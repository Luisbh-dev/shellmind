import { describe, expect, it, vi } from 'vitest';
import type { RdpTarget } from '../connections/target';
import { AppError } from '../errors';
import { buildRdpFile, detectRdpSupport, launchNativeRdp, type RdpLaunchDeps } from './rdp';

const PASSWORD = 'S3cr3t "pa$$" & more';

const target = (overrides: Partial<RdpTarget> = {}): RdpTarget => ({
    kind: 'rdp', serverId: 7, name: 'Win Box', host: 'win.example.com', port: 3390, username: 'admin', password: PASSWORD, domain: 'CORP', ...overrides,
});

type Call = { file: string; args: string[]; input?: string };

// What `cmdkey /list:<target>` prints (localized header, then the entries).
const listing = (target: string, stored: boolean) =>
    `\r\nCredenciales almacenadas actualmente para ${target}:\r\n\r\n`
    + (stored ? `    Destino: Domain:target=${target}\r\n    Tipo: Contraseña de dominio\r\n    Usuario: CORP\\me\r\n` : '* NINGUNA *\r\n');

// Fake system: `installed` programs resolve to /bin/<name>; `codes` are exit
// codes of run(); `saved` are the credentials the user stored themselves;
// started programs are recorded (the /list probes separately).
function fakeDeps(platform: NodeJS.Platform, installed: string[], codes: Record<string, number | null> = {}, saved: string[] = []) {
    const runs: Call[] = [];
    const lists: string[] = [];
    const starts: Call[] = [];
    const files: Array<{ name: string; content: string }> = [];
    const exits: Array<() => void> = [];
    const deps: RdpLaunchDeps = {
        platform,
        resolve: async (name) => (installed.includes(name) ? `/bin/${name}` : null),
        run: async (file, args) => {
            const list = args[0]?.startsWith('/list:') ? args[0].slice('/list:'.length) : null;
            if (list !== null) {
                lists.push(list);
                return { code: 0, stdout: listing(list, saved.includes(list)) };
            }
            runs.push({ file, args });
            const name = file.replace('/bin/', '');
            return { code: name in codes ? codes[name] : 0, stdout: '' };
        },
        start: async (file, args, options) => {
            if (file.includes('broken')) throw new Error(`spawn ${file} ${args.join(' ')} ENOENT`);
            starts.push({ file, args, input: options.input });
            if (options.onExit) exits.push(options.onExit);
        },
        writeRdpFile: async (name, content) => {
            files.push({ name, content });
            return `/tmp/${name}.rdp`;
        },
    };
    return { deps, runs, lists, starts, files, exitStarted: (index = exits.length - 1) => exits[index]?.() };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
    const err = await promise.then(() => null, (error: unknown) => error);
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
}

describe('detectRdpSupport', () => {
    it.each<[NodeJS.Platform, string[], string | null]>([
        ['win32', ['mstsc', 'cmdkey'], 'mstsc'],
        ['win32', [], null],
        ['darwin', ['open'], 'rdp-file'],
        ['linux', ['xfreerdp', 'remmina', 'xdg-open'], 'xfreerdp'],
        ['linux', ['xfreerdp3', 'xfreerdp'], 'xfreerdp3'],
        ['linux', ['remmina'], 'remmina'],
        ['linux', ['xdg-open'], 'rdp-file'],
        ['linux', [], null],
        ['freebsd', ['xdg-open'], 'rdp-file'],
    ])('%s with %j uses %s', async (platform, installed, client) => {
        const { deps } = fakeDeps(platform, installed);
        expect(await detectRdpSupport(deps)).toEqual({ supported: client !== null, client, platform });
    });
});

describe('launchNativeRdp on Windows', () => {
    it('stores the credential with cmdkey, starts mstsc and removes the credential when it exits', async () => {
        const system = fakeDeps('win32', ['mstsc', 'cmdkey']);
        expect(await launchNativeRdp(target(), system.deps)).toEqual({ client: 'mstsc' });

        expect(system.lists).toEqual(['TERMSRV/win.example.com']);
        expect(system.runs).toEqual([
            { file: '/bin/cmdkey', args: ['/generic:TERMSRV/win.example.com', '/user:CORP\\admin', `/pass:${PASSWORD}`] },
        ]);
        expect(system.starts).toEqual([{ file: '/bin/mstsc', args: ['/v:win.example.com:3390'], input: undefined }]);

        system.exitStarted();
        await vi.waitFor(() => expect(system.runs).toHaveLength(2));
        expect(system.runs[1]).toEqual({ file: '/bin/cmdkey', args: ['/delete:TERMSRV/win.example.com'] });
    });

    it('neither overwrites nor deletes a credential the user saved for that host', async () => {
        const system = fakeDeps('win32', ['mstsc', 'cmdkey'], {}, ['TERMSRV/win.example.com']);
        expect(await launchNativeRdp(target(), system.deps)).toEqual({ client: 'mstsc' });
        expect(system.starts).toHaveLength(1);
        system.exitStarted();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(system.runs).toEqual([]);
    });

    it('shares its own credential between launches and deletes it after the last one', async () => {
        const system = fakeDeps('win32', ['mstsc', 'cmdkey']);
        const host = 'shared.example.com';
        await launchNativeRdp(target({ host }), system.deps);
        await launchNativeRdp(target({ host }), system.deps);
        // The second launch knows the stored credential is its own.
        expect(system.lists).toEqual([`TERMSRV/${host}`]);
        expect(system.runs.map((call) => call.args[0])).toEqual([`/generic:TERMSRV/${host}`, `/generic:TERMSRV/${host}`]);

        system.exitStarted(0);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(system.runs).toHaveLength(2);
        system.exitStarted(1);
        await vi.waitFor(() => expect(system.runs.map((call) => call.args[0])).toContain(`/delete:TERMSRV/${host}`));
    });

    it('lets mstsc ask for the password when none is saved', async () => {
        const system = fakeDeps('win32', ['mstsc', 'cmdkey']);
        await launchNativeRdp(target({ password: undefined, domain: undefined }), system.deps);
        expect(system.runs).toEqual([]);
        expect(system.starts[0].args).toEqual(['/v:win.example.com:3390']);
    });

    it('never puts the password into the error when cmdkey fails', async () => {
        const system = fakeDeps('win32', ['mstsc', 'cmdkey'], { cmdkey: 87 });
        const err = await failure(launchNativeRdp(target(), system.deps));
        expect(err.code).toBe('RDP_CREDENTIALS');
        expect(err.message).toBe('Could not store the Remote Desktop credentials (cmdkey exited with code 87).');
        expect(JSON.stringify({ ...err, message: err.message })).not.toContain('S3cr3t');
        expect(system.starts).toEqual([]);
    });

    it('removes the credential and reports a generic error when mstsc cannot start', async () => {
        const system = fakeDeps('win32', ['mstsc', 'cmdkey']);
        system.deps.resolve = async (name) => (name === 'mstsc' ? '/bin/broken-mstsc' : `/bin/${name}`);
        const err = await failure(launchNativeRdp(target(), system.deps));
        expect(err.message).toBe('Could not start the Remote Desktop client (mstsc).');
        expect(err.message).not.toContain(PASSWORD);
        await vi.waitFor(() => expect(system.runs.map((call) => call.args[0])).toContain('/delete:TERMSRV/win.example.com'));
    });

    it('brackets IPv6 addresses', async () => {
        const system = fakeDeps('win32', ['mstsc']);
        await launchNativeRdp(target({ host: 'fe80::1', password: undefined }), system.deps);
        expect(system.starts[0].args).toEqual(['/v:[fe80::1]:3390']);
    });
});

describe('launchNativeRdp elsewhere', () => {
    it('opens a .rdp file without the password on macOS', async () => {
        const system = fakeDeps('darwin', ['open']);
        expect(await launchNativeRdp(target(), system.deps)).toEqual({ client: 'rdp-file' });
        expect(system.files).toHaveLength(1);
        expect(system.files[0].name).toBe('Win_Box');
        expect(system.files[0].content).toContain('full address:s:win.example.com:3390');
        expect(system.files[0].content).not.toContain('S3cr3t');
        expect(system.starts).toEqual([{ file: '/bin/open', args: ['/tmp/Win_Box.rdp'], input: undefined }]);
    });

    it('hands the password to FreeRDP on stdin, not on the command line', async () => {
        const system = fakeDeps('linux', ['xfreerdp']);
        await launchNativeRdp(target(), system.deps);
        const [call] = system.starts;
        expect(call.file).toBe('/bin/xfreerdp');
        expect(call.args).toEqual(['/v:win.example.com:3390', '/cert:tofu', '/dynamic-resolution', '/u:admin', '/d:CORP', '/from-stdin:force']);
        expect(call.args.join(' ')).not.toContain('S3cr3t');
        expect(call.input).toBe(`${PASSWORD}\n`);
    });

    it('lets Remmina ask for the password', async () => {
        const system = fakeDeps('linux', ['remmina']);
        await launchNativeRdp(target(), system.deps);
        expect(system.starts[0].args).toEqual(['-c', 'rdp://CORP%5Cadmin@win.example.com:3390']);

        await launchNativeRdp(target({ host: 'fe80::1%eth0' }), system.deps);
        expect(system.starts[1].args).toEqual(['-c', 'rdp://CORP%5Cadmin@[fe80::1%25eth0]:3390']);
    });

    it('falls back to xdg-open with a .rdp file', async () => {
        const system = fakeDeps('linux', ['xdg-open']);
        expect(await launchNativeRdp(target(), system.deps)).toEqual({ client: 'rdp-file' });
        expect(system.starts[0]).toMatchObject({ file: '/bin/xdg-open', args: ['/tmp/Win_Box.rdp'] });
    });

    it('says clearly when no client is installed', async () => {
        const err = await failure(launchNativeRdp(target(), fakeDeps('linux', []).deps));
        expect(err).toMatchObject({ code: 'RDP_UNSUPPORTED', status: 501 });
        expect(err.message).toMatch(/No Remote Desktop client was found on this computer \(linux\)/);
    });
});

describe('target validation', () => {
    it.each([
        ['win_srv01.corp.local', '/v:win_srv01.corp.local:3390'],
        ['WIN_SRV01', '/v:WIN_SRV01:3390'],
        ['fe80::1%12', '/v:[fe80::1%12]:3390'],
        ['fe80::1%eth0', '/v:[fe80::1%eth0]:3390'],
        ['10.0.0.5', '/v:10.0.0.5:3390'],
    ])('accepts %s', async (host, expected) => {
        const system = fakeDeps('win32', ['mstsc']);
        await launchNativeRdp(target({ host, password: undefined }), system.deps);
        expect(system.starts[0].args).toEqual([expected]);
    });

    it.each([
        ['host with spaces', { host: 'win box' }],
        ['option-like host', { host: '-evil' }],
        ['slash-option host', { host: '/admin' }],
        ['empty IPv6 zone', { host: 'fe80::1%' }],
        ['zone with spaces', { host: 'fe80::1%eth 0' }],
        ['host with quotes', { host: 'a"b' }],
        ['port out of range', { port: 70000 }],
        ['line break in the user name', { username: 'admin\r\nfull address:s:evil' }],
        ['quote in the domain', { domain: 'CORP"' }],
    ])('refuses a %s before running anything', async (_label, overrides) => {
        const system = fakeDeps('win32', ['mstsc', 'cmdkey']);
        const err = await failure(launchNativeRdp(target(overrides), system.deps));
        expect(err).toMatchObject({ code: 'RDP_INVALID_TARGET', status: 400 });
        expect(system.runs).toEqual([]);
        expect(system.starts).toEqual([]);
    });
});

describe('buildRdpFile', () => {
    it('describes the connection and asks for credentials', () => {
        expect(buildRdpFile(target({ domain: undefined }))).toBe([
            'full address:s:win.example.com:3390',
            'username:s:admin',
            'prompt for credentials:i:1',
            'screen mode id:i:2',
            'session bpp:i:32',
            'redirectclipboard:i:1',
            'autoreconnection enabled:i:1',
            'authentication level:i:2',
        ].join('\r\n') + '\r\n');
    });
});
