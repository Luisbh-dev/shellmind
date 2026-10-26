import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@shared/files';
import {
    breadcrumbs, entryKey, fileKind, formatBytes, formatDate, formatPermissions, nameProblem, opensInEditor, prepareEntries,
    resolveInputPath, uniqueName
} from './listing';

const file = (name: string, size = 10, mtime = 100): FileEntry => ({ name, isDir: false, isLink: false, size, mtime, permissions: 0o644 });
const dir = (name: string): FileEntry => ({ name, isDir: true, isLink: false, size: 0, mtime: 50, permissions: 0o755 });

describe('paths', () => {
    it('splits a path into breadcrumbs', () => {
        expect(breadcrumbs('/srv/app')).toEqual([{ name: 'srv', path: '/srv' }, { name: 'app', path: '/srv/app' }]);
        expect(breadcrumbs('/')).toEqual([]);
    });

    it('resolves what is typed in the path bar', () => {
        expect(resolveInputPath('/etc/nginx/', '/home/u', '/home/u')).toBe('/etc/nginx');
        expect(resolveInputPath('logs', '/var', '/home/u')).toBe('/var/logs');
        expect(resolveInputPath('../tmp', '/var/log', '/home/u')).toBe('/var/tmp');
        expect(resolveInputPath('~', '/var', '/home/u')).toBe('/home/u');
        expect(resolveInputPath('~/.ssh', '/var', '/home/u')).toBe('/home/u/.ssh');
        expect(resolveInputPath('   ', '/var', '/home/u')).toBe('/var');
    });
});

describe('names', () => {
    it('validates new names', () => {
        const taken = new Set(['a.txt']);
        expect(nameProblem('', taken)).toBe('empty');
        expect(nameProblem('a/b', taken)).toBe('slash');
        expect(nameProblem('..', taken)).toBe('dots');
        expect(nameProblem('x'.repeat(256), taken)).toBe('tooLong');
        // The server counts UTF-8 bytes (NAME_MAX), so the dialog does too.
        expect(nameProblem('é'.repeat(128), taken)).toBe('tooLong');
        expect(nameProblem('é'.repeat(127), taken)).toBeNull();
        expect(nameProblem('a.txt', taken)).toBe('exists');
        expect(nameProblem('b.txt', taken)).toBeNull();
        // S3 limits the key (folder path and name), not each name.
        expect(nameProblem('é'.repeat(200), taken, 's3', '/photos')).toBeNull();
        expect(nameProblem('é'.repeat(200), taken, 'ftp', '/photos')).toBe('tooLong');
        expect(nameProblem('x'.repeat(1000), taken, 's3', `/${'d'.repeat(40)}`)).toBe('keyTooLong');
        expect(nameProblem('a.txt', taken, 's3')).toBe('exists');
    });

    it('finds a free name for "keep both"', () => {
        expect(uniqueName('report.pdf', new Set(['report.pdf', 'report (1).pdf']))).toBe('report (2).pdf');
        expect(uniqueName('Makefile', new Set(['Makefile']))).toBe('Makefile (1)');
        expect(uniqueName('.env', new Set(['.env']))).toBe('.env (1)');
        expect(uniqueName('free.txt', new Set())).toBe('free.txt');
    });

    it('keys entries by kind and name (an S3 object and a prefix may share a name)', () => {
        expect(entryKey(file('x'))).toBe('f:x');
        expect(entryKey(dir('x'))).toBe('d:x');
        expect(entryKey(file('x'))).not.toBe(entryKey(dir('x')));
    });
});

describe('prepareEntries', () => {
    const entries = [file('b10.log', 5, 300), dir('zeta'), file('B2.log', 50, 100), file('.hidden', 1, 200), dir('alpha')];
    const options = { sort: { key: 'name' as const, direction: 'asc' as const }, filter: '', showHidden: true, language: 'en' as const };

    it('keeps folders first and sorts names naturally', () => {
        expect(prepareEntries(entries, options).map((e) => e.name)).toEqual(['alpha', 'zeta', '.hidden', 'B2.log', 'b10.log']);
    });

    it('sorts by size or date in either direction', () => {
        expect(prepareEntries(entries, { ...options, sort: { key: 'size', direction: 'desc' } }).map((e) => e.name))
            .toEqual(['alpha', 'zeta', 'B2.log', 'b10.log', '.hidden']);
        expect(prepareEntries(entries, { ...options, sort: { key: 'mtime', direction: 'asc' } }).map((e) => e.name))
            .toEqual(['alpha', 'zeta', 'B2.log', '.hidden', 'b10.log']);
    });

    it('filters case-insensitively and hides dot files', () => {
        expect(prepareEntries(entries, { ...options, filter: 'LOG' }).map((e) => e.name)).toEqual(['B2.log', 'b10.log']);
        expect(prepareEntries(entries, { ...options, showHidden: false }).map((e) => e.name)).not.toContain('.hidden');
    });

    it('handles 10,000 entries fast', () => {
        const many = Array.from({ length: 10_000 }, (_, i) => file(`file-${(i * 7919) % 10_000}.txt`));
        const started = performance.now();
        const sorted = prepareEntries(many, options);
        expect(performance.now() - started).toBeLessThan(500);
        expect(sorted[0].name).toBe('file-0.txt');
        expect(sorted[9_999].name).toBe('file-9999.txt');
    });
});

describe('display', () => {
    it('formats sizes, dates and modes', () => {
        expect(formatBytes(0, 'en')).toBe('0 B');
        expect(formatBytes(1536, 'en')).toBe('1.5 KB');
        expect(formatBytes(3 * 1024 ** 3, 'es')).toBe('3 GB');
        expect(formatBytes(1536, 'es')).toBe('1,5 KB');
        expect(formatDate(0, 'en')).toBe('—');
        expect(formatDate(1_700_000_000, 'en')).toMatch(/2023/);
        expect(formatPermissions(0o100755)).toBe('755');
        expect(formatPermissions(0)).toBe('—');
    });

    it('tells which files open in the editor', () => {
        expect(fileKind(dir('x'))).toBe('folder');
        expect(fileKind(file('a.tar.gz'))).toBe('archive');
        expect(opensInEditor(file('nginx.conf'), 2048)).toBe(true);
        expect(opensInEditor(file('Dockerfile'), 2048)).toBe(true);
        expect(opensInEditor(file('photo.png'), 2048)).toBe(false);
        expect(opensInEditor(file('app.bin'), 2048)).toBe(false);
        expect(opensInEditor(file('big.log', 4096), 2048)).toBe(false);
        expect(opensInEditor(dir('etc'), 2048)).toBe(false);
    });
});
