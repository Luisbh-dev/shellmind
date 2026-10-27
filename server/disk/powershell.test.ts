import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { runLocalPowerShell } from '../../test/helpers/localPowerShell';
import { PROCESS_TEST_TIMEOUT_MS } from '../../test/setup/timeouts';
import { psQuote } from '../ops/remote';
import { deleteOlderScript, parseWindowsCleanups, updateCacheRunScript, windowsCleanupScript } from './cleanups/windows';
import { parseWindowsLargeFiles, windowsLargeFilesScript } from './largeFiles';
import { WINDOWS_MOUNTS_SCRIPT, parseWindowsMounts } from './mounts';
import { parseWindowsUsage, windowsUsageScript } from './usage';

// The disk toolkit's PowerShell, run for real by the local powershell.exe
// (Windows only) exactly as the backend delivers it (on stdin), against a
// scratch folder tree: sizes, the time budget, junctions not followed, and
// the deletion of old files.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const WINDOWS = process.platform === 'win32';

async function runPowerShell(script: string, skip: TestContext['skip']): Promise<string> {
    return (await runLocalPowerShell(script, skip)).stdout;
}

let root = '';
const MiB = 1024 * 1024;

function file(relative: string, bytes: number, ageDays = 0) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(bytes));
    if (ageDays) {
        const when = new Date(Date.now() - ageDays * 86_400_000);
        fs.utimesSync(target, when, when);
    }
}

describe.skipIf(!WINDOWS)('the disk toolkit\'s PowerShell on this machine', () => {
    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "shellmind disk it's-"));
        file('big\\archive.bin', 3 * MiB);
        file('big\\nested\\deep\\video.bin', 2 * MiB);
        file('small\\note.txt', 1000);
        file('top.log', 4096);
        file('old\\stale-1.tmp', 5000, 30);
        file('old\\stale-2.tmp', 7000, 30);
        file('old\\fresh.tmp', 3000);
        // A junction back to the tree: followed, it would count "big" twice (or loop).
        fs.symlinkSync(path.join(root, 'big'), path.join(root, 'link-to-big'), 'junction');
    });

    afterAll(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('measures one level of a folder, largest first, without following junctions', async ({ skip }) => {
        const listing = parseWindowsUsage(root, await runPowerShell(windowsUsageScript(root, 30), skip));
        expect(listing.entries.map((entry) => [entry.name, entry.bytes, entry.kind, entry.otherFs ?? false])).toEqual([
            ['big', 5 * MiB, 'dir', false],
            ['old', 15000, 'dir', false],
            ['top.log', 4096, 'file', false],
            ['small', 1000, 'dir', false],
            ['link-to-big', 0, 'dir', true],
        ]);
        expect(listing).toMatchObject({ totalBytes: 5 * MiB + 15000 + 4096 + 1000, timedOut: false, denied: 0 });
    });

    it('stops at the time budget and says so', async ({ skip }) => {
        const listing = parseWindowsUsage(root, await runPowerShell(windowsUsageScript(root, 0.001), skip));
        expect(listing.timedOut).toBe(true);
        expect(listing.totalBytes).toBeNull();
    });

    it('finds the largest files below a folder', async ({ skip }) => {
        const result = parseWindowsLargeFiles(await runPowerShell(windowsLargeFilesScript(root, 1), skip));
        expect(result.files.map((found) => [path.basename(found.path), found.bytes])).toEqual([['archive.bin', 3 * MiB], ['video.bin', 2 * MiB]]);
        expect(result.timedOut).toBe(false);
    });

    it('reads the fixed drives', async ({ skip }) => {
        const drives = parseWindowsMounts(await runPowerShell(WINDOWS_MOUNTS_SCRIPT, skip));
        expect(drives.map((drive) => drive.mount)).toContain(`${process.env.SystemDrive ?? 'C:'}\\`);
        expect(drives[0].totalBytes).toBeGreaterThan(drives[0].freeBytes);
    });

    it('measures the Windows cleanups without changing anything', async ({ skip }) => {
        const previews = parseWindowsCleanups(await runPowerShell(windowsCleanupScript(7), skip), true, [`${process.env.SystemDrive ?? 'C:'}\\`], { days: 7 });
        expect(previews.map((preview) => preview.id)).toEqual(['win-temp', 'win-update-cache', 'win-recycle-bin', 'win-component-store']);
        expect(previews.every((preview) => preview.bytes === null || preview.bytes >= 0)).toBe(true);
    });

    // A scratch "SoftwareDistribution" and a service name that does not exist:
    // nothing on this machine is stopped.
    it('empties a download folder renamed aside, and what an earlier run left aside', async ({ skip }) => {
        file('SoftwareDistribution\\Download\\a1\\update.cab', 4096);
        file('SoftwareDistribution\\Download\\b2.psf', 2048);
        file('SoftwareDistribution\\Download.shellmind-20200101000000\\left.cab', 1024);
        file('SoftwareDistribution\\DataStore\\DataStore.edb', 512);
        const folder = path.join(root, 'SoftwareDistribution');
        const output = await runPowerShell(updateCacheRunScript(psQuote(folder), ['ShellMindTestNoSuchService']), skip);
        expect(output.trim()).toBe('The Windows Update download cache was emptied (0 items could not be removed).');
        expect(fs.readdirSync(folder)).toEqual(['DataStore']);
    });

    it('deletes only the files older than the age chosen', async ({ skip }) => {
        const output = await runPowerShell(deleteOlderScript(`$t=@(${psQuote(path.join(root, 'old'))})`, 7), skip);
        expect(output.trim()).toBe('2 files removed, 0 in use or protected');
        expect(fs.readdirSync(path.join(root, 'old'))).toEqual(['fresh.tmp']);
    });
});
