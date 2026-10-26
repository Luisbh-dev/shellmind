import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readWorkflow, setting, steps } from '../helpers/workflow';

// The release workflow (.github/workflows/release.yml): what a pushed version
// tag builds, how each package is checked before it is attached, and that a
// release needs no secret.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const { text: workflow, block } = readWorkflow('release.yml');
const build = block('build', 2);

type Entry = Record<string, string>;
function matrix(): Entry[] {
    const include = build.slice(build.indexOf('        include:\n') + '        include:\n'.length, build.indexOf('\n    steps:'));
    return include.split(/\n(?= {10}- )/).map((entry) => Object.fromEntries(
        entry.split('\n').filter((line) => /^ {10}(- | {2})\w+: /.test(line)).map((line) => {
            const [, key, value] = /^ {10}(?:- | {2})(\w+): (.+)$/.exec(line)!;
            return [key, value.trim()];
        }),
    ));
}
const stepNamed = (job: string, name: string) => steps(job).find((step) => step.name === name)?.text ?? '';
const index = (job: string, name: string) => steps(job).findIndex((step) => step.name === name);

const draft = block('draft', 2);
const publish = block('publish', 2);
// A job's `permissions:` entries, one per line.
function permissions(job: string): string {
    const lines = job.split('\n');
    const rest = lines.slice(lines.indexOf('    permissions:') + 1);
    const end = rest.findIndex((line) => !/^ {6}\S/.test(line));
    return rest.slice(0, end < 0 ? undefined : end).map((line) => line.trim()).join('\n');
}

describe('release workflow', () => {
    it('runs for version tags (and on demand for an existing tag), reading the repository by default', () => {
        expect(workflow).toMatch(/^on:\n {2}push:\n {4}tags: \["v\*"\]\n {2}workflow_dispatch:\n/m);
        expect(block('permissions', 0).trim()).toBe('contents: read');
        expect(setting(block('env', 0), 'TAG')).toBe('${{ inputs.tag || github.ref_name }}');
        expect(setting(block('concurrency', 0), 'cancel-in-progress')).toBe('false');
    });

    // SEC-2: npm ci runs every dependency's install scripts and the builds
    // download Electron and native modules. None of that may hold a token
    // that can replace the release's packages or push to the repository.
    it('gives a write token only to the jobs and steps that call gh', () => {
        expect(permissions(draft)).toBe('contents: write');
        expect(permissions(build)).toBe('contents: read');
        expect(permissions(publish)).toBe('contents: write\nid-token: write\nattestations: write');
        expect(block('env', 0)).not.toContain('GH_TOKEN');
        expect(build).not.toContain('github.token');
        const withToken = [...steps(draft), ...steps(publish)].filter((step) => step.text.includes('GH_TOKEN: ${{ github.token }}'));
        expect(withToken.map((step) => step.name)).toEqual(['Create the draft release when there is none', 'Attach the packages and their checksums']);
        for (const step of withToken) expect(step.text).toMatch(/\n {8}env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n/);
        expect(workflow.match(/github\.token/g)).toHaveLength(2);
    });

    it('keeps no credential in the checkouts and pins every action by commit', () => {
        const checkouts = [...workflow.matchAll(/uses: actions\/checkout@.*\n {8}with:\n((?: {10}.*\n)+)/g)];
        expect(checkouts).toHaveLength(2);
        for (const [, settings] of checkouts) expect(settings).toContain('persist-credentials: false');
        const uses = [...workflow.matchAll(/^ +(?:- )?uses: (\S+)(.*)$/gm)];
        expect(uses.length).toBeGreaterThanOrEqual(6);
        for (const [, action, comment] of uses) {
            expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
            expect(comment).toMatch(/^ # v\d+\.\d+\.\d+$/);
        }
    });

    it('builds Windows x64, Linux x64 and both Mac architectures on their own runners', () => {
        expect(matrix().map(({ name, os, platform, arch }) => ({ name, os, platform, arch }))).toEqual([
            { name: 'Windows x64', os: 'windows-latest', platform: 'win', arch: 'x64' },
            { name: 'Linux x64', os: 'ubuntu-latest', platform: 'linux', arch: 'x64' },
            { name: 'macOS arm64', os: 'macos-14', platform: 'mac', arch: 'arm64' },
            { name: 'macOS x64', os: 'macos-15-intel', platform: 'mac', arch: 'x64' },
        ]);
        expect(matrix().map((entry) => entry.packages)).toEqual(['release/*.exe', 'release/*.AppImage release/*.deb', 'release/*.dmg release/*.zip', 'release/*.dmg release/*.zip']);
        expect(setting(build, 'fail-fast')).toBe('false');
    });

    it('packages Linux in the same Debian 11 container as npm run dist:linux', () => {
        const linux = stepNamed(build, 'Package (Debian 11 container)');
        expect(setting(linux, 'if')).toBe("matrix.platform == 'linux'");
        expect(linux).toContain('run: node scripts/dist-linux-docker.mjs --out release');
        expect(stepNamed(build, 'Package')).toContain('run: node scripts/dist.mjs --${{ matrix.platform }} --arch ${{ matrix.arch }} --out release');
        // The container runs smoke-packaged on both packages itself.
        const container = fs.readFileSync(path.join(repoRoot, 'scripts', 'dist-linux-container.sh'), 'utf8');
        expect(container.indexOf('node scripts/smoke-packaged.mjs "$package"')).toBeGreaterThan(container.indexOf('node scripts/dist.mjs --linux --x64 --out /out'));
    });

    it('smoke-tests every package before handing it over', () => {
        const smoke = stepNamed(build, 'Smoke-test the packages');
        expect(smoke).toContain('node scripts/smoke-packaged.mjs "$package"');
        expect(smoke).toContain('for package in ${{ matrix.packages }}; do');
        const collect = index(build, 'Collect the packages');
        expect(collect).toBeGreaterThan(index(build, 'Smoke-test the packages'));
        expect(collect).toBeGreaterThan(index(build, 'Package (Debian 11 container)'));
        expect(stepNamed(build, 'Collect the packages')).toContain('files=(${{ matrix.packages }})');
        const handOver = stepNamed(build, 'Hand the packages to the publish job');
        expect(handOver).toContain('uses: actions/upload-artifact@');
        expect(handOver).toContain('\n          name: packages-${{ matrix.platform }}-${{ matrix.arch }}\n          path: packages/\n');
        expect(index(build, 'Hand the packages to the publish job')).toBe(steps(build).length - 1);
    });

    it('creates a draft when the tag has no release, and never replaces a published package', () => {
        expect(stepNamed(draft, 'Create the draft release when there is none')).toContain('gh release create "$TAG" --draft --verify-tag');
        expect(stepNamed(draft, 'Check the version')).toContain('if [ "v$version" != "$TAG" ]; then');
        expect(setting(build, 'needs')).toBe('draft');
        expect(setting(publish, 'needs')).toBe('[draft, build]');
        const attach = stepNamed(publish, 'Attach the packages and their checksums');
        expect(attach).toContain('if [ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = "true" ]; then');
        expect(attach.match(/--clobber/g)).toHaveLength(1);
        expect(attach).toContain('gh release upload "$TAG" "${files[@]}" "$RUNNER_TEMP/SHA256SUMS.txt" --clobber');
    });

    it('attests the packages and lists the checksums of the files it built, not of what the release holds', () => {
        expect(stepNamed(publish, 'Download the packages')).toContain('pattern: packages-*');
        const attest = stepNamed(publish, 'Attest the build provenance');
        expect(attest).toContain('uses: actions/attest-build-provenance@');
        expect(setting(attest, 'subject-path')).toBe('packages/*');
        expect(index(publish, 'Attest the build provenance')).toBeLessThan(index(publish, 'Attach the packages and their checksums'));
        const attach = stepNamed(publish, 'Attach the packages and their checksums');
        expect(attach).toContain('sha256sum -- "${files[@]}" > "$RUNNER_TEMP/SHA256SUMS.txt"');
        expect(workflow).not.toContain('gh release download');
    });

    it('needs no secret: signing credentials are optional and reach only their platform', () => {
        const secrets = [...workflow.matchAll(/^ +(\w+): \$\{\{ (.*secrets\..*) \}\}$/gm)];
        expect(secrets.length).toBeGreaterThan(0);
        for (const [, name, expression] of secrets) {
            const platform = name.startsWith('WIN_') ? 'win' : 'mac';
            expect(expression).toBe(`matrix.platform == '${platform}' && secrets.${name} || ''`);
        }
        expect(workflow.match(/secrets\./g)).toHaveLength(secrets.length);
    });

    it('starts the draft with the install notes of an unsigned build', () => {
        const notes = fs.readFileSync(path.join(repoRoot, '.github', 'release-notes.md'), 'utf8');
        expect(notes).toContain('More info → Run anyway');
        expect(notes).toContain('xattr -dr com.apple.quarantine');
        expect(notes).toContain('sha256sum -c SHA256SUMS.txt --ignore-missing');
        expect(notes).toContain('gh attestation verify');
        for (const name of ['ShellMind-Setup-<version>-x64.exe', 'ShellMind-<version>-arm64.dmg', 'ShellMind-<version>-x86_64.AppImage', 'shellmind_<version>_amd64.deb']) {
            expect(notes).toContain(name);
        }
    });
});
