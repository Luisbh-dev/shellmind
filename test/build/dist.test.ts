import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dropEmptySigningVariables, macSigning, parseArgs, SIGNING_VARIABLES } from '../../scripts/dist.mjs';

// scripts/dist.mjs (`npm run dist`) and the installer settings in package.json
// that the release workflow attaches as they are named.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
type Target = string | { target: string; arch?: string[] };
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    build: Record<string, Record<string, unknown> | null | string | string[]> & {
        win: { target: Target | Target[] };
        mac: { target: Target[]; artifactName: string; identity?: unknown };
        linux: { target: Target[]; maintainer?: string };
        nsis: { artifactName: string };
        appImage: { artifactName: string };
        deb: { artifactName: string; depends: string[] };
    };
};
const targetNames = (targets: Target | Target[]) => [targets].flat().map((target) => (typeof target === 'string' ? target : target.target));

describe('installers', () => {
    it('builds the NSIS installer, the AppImage and deb, and the dmg and zip', () => {
        expect(targetNames(pkg.build.win.target)).toEqual(['nsis']);
        expect(targetNames(pkg.build.linux.target)).toEqual(['AppImage', 'deb']);
        expect(targetNames(pkg.build.mac.target)).toEqual(['dmg', 'zip']);
    });

    it('leaves the architecture to the machine that packages (its native modules)', () => {
        // An arch list in the config would build every listed arch from the
        // same node_modules, whatever --arch asks for.
        for (const targets of [pkg.build.win.target, pkg.build.linux.target, pkg.build.mac.target]) {
            for (const target of [targets].flat()) expect(typeof target).toBe('string');
        }
    });

    it('names every package with the version and the architecture', () => {
        for (const pattern of [pkg.build.nsis.artifactName, pkg.build.appImage.artifactName, pkg.build.deb.artifactName, pkg.build.mac.artifactName]) {
            expect(pattern).toContain('${version}');
            expect(pattern).toContain('${arch}');
            expect(pattern).not.toMatch(/\s/);
        }
        // Two Mac architectures upload to one release: their names must differ.
        expect(pkg.build.mac.artifactName).toBe('${productName}-${version}-${arch}.${ext}');
    });

    it('makes the deb depend on every library Electron loads, not only electron-builder\'s defaults', () => {
        // Without libgbm1 and libasound2 the app did not start on a minimal
        // Debian 12 or Ubuntu 22.04 ("libgbm.so.1: cannot open shared object
        // file"); Ubuntu 24.04 renamed the latter libasound2t64.
        expect(pkg.build.deb.depends).toEqual(expect.arrayContaining(['libgtk-3-0', 'libnss3', 'libsecret-1-0', 'libgbm1', 'libasound2t64 | libasound2']));
    });

    it('has the deb maintainer electron-builder requires and no auto-update feed', () => {
        expect(pkg.build.linux.maintainer).toMatch(/^.+ <[^@\s]+@[^@\s]+>$/);
        // There is no updater in the app: no app-update.yml or latest.yml.
        expect(pkg.build.publish).toBeNull();
    });

    it('leaves the Mac signing identity to scripts/dist.mjs', () => {
        expect(pkg.build.mac).not.toHaveProperty('identity');
        expect(pkg.scripts.dist).toBe('npm run build && node scripts/dist.mjs');
        expect(pkg.scripts['dist:linux']).toBe('node scripts/dist-linux-docker.mjs');
    });
});

describe('npm run dist options', () => {
    const windows = { platform: 'win32', arch: 'x64' };
    const appleSilicon = { platform: 'darwin', arch: 'arm64' };

    it('packages this machine by default', () => {
        expect(parseArgs([], windows)).toEqual({ platform: 'win', arch: 'x64', out: null, dir: false });
        expect(parseArgs(['--mac', '--arch', 'arm64', '--out', 'out', '--dir'], appleSilicon)).toEqual({ platform: 'mac', arch: 'arm64', out: 'out', dir: true });
        expect(parseArgs(['--arm64'], appleSilicon).arch).toBe('arm64');
    });

    it('refuses another platform or architecture than the native modules were built for', () => {
        expect(() => parseArgs(['--linux'], windows)).toThrow(/npm run dist:linux/);
        expect(() => parseArgs(['--mac', '--arch', 'x64'], appleSilicon)).toThrow(/\(darwin-arm64\) cannot package darwin-x64/);
        expect(() => parseArgs(['--arch', 'ia32'], windows)).toThrow(/Unsupported architecture/);
    });

    it('rejects unknown options and missing values', () => {
        expect(() => parseArgs(['--publish', 'always'], windows)).toThrow(/Unknown option --publish/);
        expect(() => parseArgs(['--out'], windows)).toThrow(/--out needs a value/);
        expect(() => parseArgs(['--win', '--mac'], windows)).toThrow(/one platform at a time/);
    });
});

describe('macOS signing', () => {
    const none = () => false;

    it('signs ad hoc without a Developer ID, so that Apple Silicon starts the app', () => {
        expect(macSigning({}, none)).toEqual({ mode: 'ad-hoc', mac: { identity: '-', hardenedRuntime: false, notarize: false } });
        // CI turns keychain discovery off: the keychain is not even asked.
        expect(macSigning({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, () => { throw new Error('asked the keychain'); }).mode).toBe('ad-hoc');
    });

    it('uses a Developer ID from the secrets or the keychain, with the hardened runtime notarization needs', () => {
        expect(macSigning({ CSC_LINK: 'base64' }, none)).toEqual({ mode: 'developer-id', mac: { hardenedRuntime: true } });
        expect(macSigning({ CSC_NAME: 'Developer ID Application: Someone' }, none).mode).toBe('developer-id');
        expect(macSigning({}, () => true).mode).toBe('developer-id');
        expect(macSigning({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, () => true).mode).toBe('ad-hoc');
    });

    it('reads a secret that is not set (an empty variable in GitHub Actions) as absent', () => {
        const env: Record<string, string | undefined> = { CSC_LINK: '', CSC_KEY_PASSWORD: ' ', APPLE_ID: 'me@example.com', PATH: '' };
        dropEmptySigningVariables(env);
        expect(env).toEqual({ APPLE_ID: 'me@example.com', PATH: '' });
        expect(macSigning(env, none).mode).toBe('ad-hoc');
        expect(SIGNING_VARIABLES).toEqual(expect.arrayContaining(['WIN_CSC_LINK', 'APPLE_API_KEY', 'APPLE_TEAM_ID']));
    });
});
