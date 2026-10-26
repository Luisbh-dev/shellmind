import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pastedSshConfig, readUserSshConfig, resolveSshConfig } from './sshConfig';

const SAVED = [
    { id: 7, name: 'prod-db', ip: '10.0.0.9', type: 'linux' as const, port: null, ssh_port: null, username: 'postgres' },
    { id: 8, name: 'gateway', ip: 'gw.example.com', type: 'linux' as const, port: 2200, ssh_port: null, username: 'ops' },
    { id: 9, name: 'files', ip: '10.0.0.9', type: 'ftp' as const, port: null, ssh_port: null, username: 'postgres' },
];

const resolve = (text: string, saved = SAVED) => resolveSshConfig(pastedSshConfig(text), saved, 'me');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-sshcfg-'));
afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

describe('resolving Host aliases', () => {
    it('applies options like OpenSSH: first value wins, Host * defaults last', () => {
        const preview = resolve([
            'User fallback-user',
            'Host web web-alias',
            '    HostName 192.168.1.10',
            '    Port 2222',
            '    IdentityFile ~/.ssh/web_ed25519',
            'Host *.internal',
            '    User internal',
            'Host *',
            '    User star',
            '    Port 22',
        ].join('\n'));

        expect(preview.source).toBeNull();
        expect(preview.entries.map((entry) => entry.alias)).toEqual(['web', 'web-alias']);
        expect(preview.entries[0]).toMatchObject({
            alias: 'web', host: '192.168.1.10', port: 2222, user: 'fallback-user',
            identityFile: '~/.ssh/web_ed25519', proxyJump: null, duplicateOf: null, warnings: [],
        });
    });

    it('skips wildcard and negated patterns and falls back to the alias as host', () => {
        const preview = resolve('Host bastion !nope *.corp ?x\n  User admin\n');
        expect(preview.entries).toHaveLength(1);
        expect(preview.entries[0]).toMatchObject({ alias: 'bastion', host: 'bastion', port: null, user: 'admin' });
    });

    it('uses the local user name when no User is set, and says so', () => {
        const [entry] = resolve('Host box\n  HostName 10.1.1.1\n').entries;
        expect(entry.user).toBe('me');
        expect(entry.warnings).toEqual([{ code: 'user-default', detail: 'me' }]);
    });

    it('stores the default port as null and flags invalid ports', () => {
        const entries = resolve('Host a\n  User u\n  Port 22\nHost b\n  User u\n  Port 99999\n').entries;
        expect(entries[0].port).toBeNull();
        expect(entries[1]).toMatchObject({ port: null, warnings: [{ code: 'invalid-port', detail: '99999' }] });
    });

    it('expands the %-tokens that make sense and keeps the first IdentityFile', () => {
        const [entry] = resolve([
            'Host app',
            '  HostName %h.example.com',
            '  User deploy',
            '  IdentityFile %d/.ssh/%r@%h',
            '  IdentityFile ~/.ssh/other',
            '  IdentityFile ~/.ssh/%C',
        ].join('\n')).entries;
        expect(entry.host).toBe('app.example.com');
        expect(entry.identityFile).toBe('~/.ssh/deploy@app.example.com');
        expect(entry.warnings).toEqual([{ code: 'identity-multiple', detail: '%d/.ssh/%r@%h' }]);
    });

    it('maps ProxyJump to an alias of the file or a saved server', () => {
        const entries = resolve([
            'Host bastion',
            '  HostName 203.0.113.5',
            '  User jump',
            'Host inner',
            '  HostName 10.0.0.20',
            '  User root',
            '  ProxyJump jump@bastion:22',
            'Host via-saved',
            '  User root',
            '  ProxyJump gateway',
            'Host chained',
            '  User root',
            '  ProxyJump gw.example.com,bastion',
            'Host lost',
            '  User root',
            '  ProxyJump nowhere.example.com',
            'Host direct',
            '  User root',
            '  ProxyJump none',
            '  ProxyCommand ssh -W %h:%p other',
        ].join('\n')).entries;
        const byAlias = Object.fromEntries(entries.map((entry) => [entry.alias, entry]));

        expect(byAlias.inner).toMatchObject({ proxyJump: 'bastion', proxyJumpSavedId: null, warnings: [] });
        expect(byAlias['via-saved']).toMatchObject({ proxyJump: 'gateway', proxyJumpSavedId: 8, warnings: [] });
        expect(byAlias.chained).toMatchObject({
            proxyJump: 'bastion',
            warnings: [{ code: 'proxy-jump-chain', detail: 'gw.example.com,bastion' }],
        });
        expect(byAlias.lost).toMatchObject({
            proxyJump: 'nowhere.example.com',
            proxyJumpSavedId: null,
            warnings: [{ code: 'proxy-jump-unknown', detail: 'nowhere.example.com' }],
        });
        expect(byAlias.direct).toMatchObject({ proxyJump: null, warnings: [{ code: 'proxy-command' }] });
    });

    it('jumps through the saved copy of a jump alias that is already saved, found by address and not by name', () => {
        const saved = [
            ...SAVED,
            // Shares the alias as its name but is another machine.
            { id: 10, name: 'bastion', ip: '198.51.100.10', type: 'linux' as const, port: null, ssh_port: null, username: 'admin' },
            { id: 11, name: 'edge', ip: '203.0.113.5', type: 'linux' as const, port: null, ssh_port: null, username: 'jump' },
        ];
        const entries = resolve([
            'Host bastion', '  HostName 203.0.113.5', '  User jump',
            'Host inner', '  HostName 10.0.0.20', '  User root', '  ProxyJump bastion',
            'Host fresh-jump', '  HostName 10.0.0.30', '  User root',
            'Host behind-fresh', '  HostName 10.0.0.31', '  User root', '  ProxyJump fresh-jump',
        ].join('\n'), saved).entries;
        const byAlias = Object.fromEntries(entries.map((entry) => [entry.alias, entry]));

        expect(byAlias.bastion.duplicateOf).toEqual({ id: 11, name: 'edge' });
        expect(byAlias.inner).toMatchObject({ proxyJump: 'bastion', proxyJumpSavedId: 11, warnings: [] });
        // A jump alias that will be imported is linked when it is created.
        expect(byAlias['behind-fresh']).toMatchObject({ proxyJump: 'fresh-jump', proxyJumpSavedId: null });
    });

    it('marks hosts that are already saved (same host, port and user over SSH)', () => {
        const entries = resolve([
            'Host db', '  HostName 10.0.0.9', '  User postgres',
            'Host db-other-user', '  HostName 10.0.0.9', '  User root',
            'Host gw', '  HostName GW.example.com', '  User ops', '  Port 2200',
        ].join('\n')).entries;
        expect(entries.map((entry) => entry.duplicateOf)).toEqual([
            { id: 7, name: 'prod-db' },
            null,
            { id: 8, name: 'gateway' },
        ]);
    });

    it('ignores Match blocks and never runs their exec criteria', () => {
        const marker = path.join(tmpHome, 'exec-ran');
        const preview = resolve([
            `Match exec "node -e \\"require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', '')\\""`,
            '  User matched',
            'Host plain',
            '  User u',
        ].join('\n'));
        expect(preview.warnings).toEqual([{ code: 'match-ignored' }]);
        expect(preview.entries).toMatchObject([{ alias: 'plain', user: 'u' }]);
        expect(fs.existsSync(marker)).toBe(false);
    });
});

describe('reading the config file', () => {
    const sshDir = path.join(tmpHome, '.ssh');

    it('reports a missing ~/.ssh/config', () => {
        expect(() => readUserSshConfig(path.join(tmpHome, 'nobody'))).toThrow(expect.objectContaining({ code: 'SSH_CONFIG_NOT_FOUND', status: 404 }));
    });

    it('inlines Include files from ~/.ssh and refuses the ones outside it', () => {
        fs.mkdirSync(path.join(sshDir, 'config.d'), { recursive: true });
        fs.writeFileSync(path.join(sshDir, 'config'), [
            'Include config.d/*.conf ~/.ssh/extra "../outside" /etc/ssh/ssh_config',
            'Host main',
            '  User main',
            '  Include nested',
        ].join('\n'));
        fs.writeFileSync(path.join(sshDir, 'config.d', 'b.conf'), 'Host from-b\n  User b\n');
        fs.writeFileSync(path.join(sshDir, 'config.d', 'a.conf'), 'Host from-a\n  User a\n');
        fs.writeFileSync(path.join(sshDir, 'config.d', 'ignored.txt'), 'Host not-included\n');
        fs.writeFileSync(path.join(sshDir, 'extra'), 'Host from-extra\n  User x\n  Include extra\n');
        fs.writeFileSync(path.join(sshDir, 'nested'), '  Port 2201\n');
        fs.writeFileSync(path.join(tmpHome, 'outside'), 'Host secret-outside\n');

        const source = readUserSshConfig(tmpHome);
        expect(source.source).toBe(path.join(sshDir, 'config'));
        expect(source.warnings).toEqual([
            { code: 'include-unresolved', detail: '../outside' },
            { code: 'include-unresolved', detail: '/etc/ssh/ssh_config' },
        ]);

        const preview = resolveSshConfig(source, [], 'me');
        expect(preview.entries.map((entry) => [entry.alias, entry.user, entry.port])).toEqual([
            ['from-a', 'a', null],
            ['from-b', 'b', null],
            ['from-extra', 'x', null],
            ['main', 'main', 2201],
        ]);
    });

    it('cannot include anything from pasted text', () => {
        const source = pastedSshConfig('Include ~/.ssh/config.d/*\nHost a\n  User u\n');
        expect(source.warnings).toEqual([{ code: 'include-in-text', detail: '~/.ssh/config.d/*' }]);
        expect(resolveSshConfig(source, [], 'me').entries.map((entry) => entry.alias)).toEqual(['a']);
        expect(pastedSshConfig('  include =  "a b"  \nIncludes x\n').warnings).toEqual([{ code: 'include-in-text', detail: '"a b"' }]);
    });

    it('reads lines with long runs of spaces in linear time', () => {
        const spaces = ' '.repeat(150_000);
        const started = performance.now();
        const source = pastedSshConfig(`include a${spaces}b\nHost x${spaces}\n  User u${spaces}x\n`);
        resolveSshConfig(source, [], 'me');
        // The old pattern needed seconds for a fraction of this.
        expect(performance.now() - started).toBeLessThan(1000);
        expect(source.warnings).toEqual([{ code: 'include-in-text', detail: `a${spaces}b` }]);
    });
});
