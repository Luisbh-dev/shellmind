import { describe, expect, it } from 'vitest';
import { attachmentKey, parseChatAttachment } from '../../../shared/chatEvidence';
import type { CleanupPreview, DiskMount } from '../../../shared/disk';
import { bytesText, formatCleanups, formatMounts } from './disk';
import { describeTarget, diagnoseInstruction } from './prompt';

// W8-T4: "why is this disk full?" as an attachment of the AI chat.

const mount = (name: string, extra: Partial<DiskMount> = {}): DiskMount => ({
    mount: name, device: '/dev/sda1', fsType: 'ext4', totalBytes: 10 * 1024 ** 3, usedBytes: 9.5 * 1024 ** 3, freeBytes: 0.5 * 1024 ** 3, usagePercent: 95,
    inodes: { total: 1000, used: 990, free: 10, usagePercent: 99 }, readOnly: false, ...extra,
});

describe('the disk attachment', () => {
    it('names a filesystem by an absolute path, and only that', () => {
        expect(parseChatAttachment({ kind: 'disk', mount: '/var/' })).toEqual({ kind: 'disk', mount: '/var' });
        expect(parseChatAttachment({ kind: 'disk', mount: 'c:\\' })).toEqual({ kind: 'disk', mount: 'C:\\' });
        expect(parseChatAttachment({ kind: 'disk', mount: 'var' })).toBeNull();
        expect(parseChatAttachment({ kind: 'disk', mount: '/var/../etc' })).toBeNull();
        expect(parseChatAttachment({ kind: 'disk' })).toBeNull();
        expect(attachmentKey({ kind: 'disk', mount: '/var' })).toBe('["disk","/var"]');
    });

    it('is diagnosed as a full filesystem, with the cleanups preferred to deleting files', () => {
        expect(describeTarget({ kind: 'disk', mount: '/var"\nx' })).toBe('why the filesystem "/var  x" is full (or filling up)');
        const instruction = diagnoseInstruction({ kind: 'disk', mount: '/var' }, 'en');
        expect(instruction).toContain('Never suggest rm -rf on a directory whose purpose you do not know');
        expect(instruction).toContain('### Cause');
        expect(diagnoseInstruction({ kind: 'status' }, 'en')).not.toContain('rm -rf');
    });
});

describe('the evidence text', () => {
    it('words sizes, filesystems and cleanups for the model', () => {
        expect(bytesText(512)).toBe('512 B');
        expect(bytesText(1536 * 1024 ** 2)).toBe('1.5 GB');
        expect(bytesText(null)).toBe('unknown size');
        expect(formatMounts([mount('/'), mount('/var', { readOnly: true, inodes: null })], mount('/var'))).toBe([
            '/ (/dev/sda1, ext4): 95% used, 512.0 MB free of 10.0 GB, inodes 99% used (10 free)',
            '/var (/dev/sda1, ext4, read-only): 95% used, 512.0 MB free of 10.0 GB <- the filesystem asked about',
        ].join('\n'));
        const previews: CleanupPreview[] = [
            { id: 'journal', status: 'ready', bytes: 2 * 1024 ** 3, estimate: 'about', count: 12, items: [], mounts: ['/var'], command: 'journalctl --vacuum-size=200M', params: {}, facts: { usage: 3 * 1024 ** 3 } },
            { id: 'tmp', status: 'unavailable', reason: { code: 'NOT_ELEVATED', message: 'Needs root.' }, bytes: null, estimate: 'about', count: null, items: [], mounts: ['/'], command: 'find /tmp', params: {} },
        ];
        expect(formatCleanups(previews, '/var')).toBe([
            'journal (on /var): would free about 2.0 GB (12 items); the journal takes 3.0 GB. Command: journalctl --vacuum-size=200M',
            'tmp (on /, another filesystem): cannot run (Needs root). Command: find /tmp',
        ].join('\n'));
        expect(formatCleanups([], '/')).toBe('(no known cleanup applies to this server)');
    });
});
