import { describe, expect, it } from 'vitest';
import { MAX_EVIDENCE_SECTION_CHARS, MAX_LOG_EXCERPT_CHARS } from './chat';
import { attachmentKey, clipExcerpt, evidenceChars, isLogSelection, parseChatAttachment, parseChatEvidence, recollectAttachment } from './chatEvidence';

describe('parseChatAttachment', () => {
    it('keeps the known fields of each kind', () => {
        expect(parseChatAttachment({ kind: 'service', name: ' nginx.service ', extra: 1 })).toEqual({ kind: 'service', name: 'nginx.service' });
        expect(parseChatAttachment({ kind: 'container', container: 'web-1', engine: 'podman' })).toEqual({ kind: 'container', container: 'web-1', engine: 'podman' });
        expect(parseChatAttachment({ kind: 'container', container: 'web-1', engine: 'lxc' })).toEqual({ kind: 'container', container: 'web-1' });
        expect(parseChatAttachment({ kind: 'logs', source: { kind: 'journal' } })).toEqual({ kind: 'logs', source: { kind: 'journal' } });
        expect(parseChatAttachment({ kind: 'logs', source: { kind: 'journal', unit: 'ssh' } })).toEqual({ kind: 'logs', source: { kind: 'journal', unit: 'ssh' } });
        expect(parseChatAttachment({ kind: 'logs', source: { kind: 'file', path: '/var/log/syslog' }, excerpt: 'a\r\nb' })).toEqual({ kind: 'logs', source: { kind: 'file', path: '/var/log/syslog' }, excerpt: 'a\nb' });
        expect(parseChatAttachment({ kind: 'logs', source: { kind: 'journal' }, selection: 'AbCdEfGhIjKlMnOpQr_-12' })).toEqual({ kind: 'logs', source: { kind: 'journal' }, selection: 'AbCdEfGhIjKlMnOpQr_-12' });
        // The lines themselves win over a fingerprint.
        expect(parseChatAttachment({ kind: 'logs', source: { kind: 'journal' }, excerpt: 'x', selection: 'AbCdEfGhIjKlMnOpQr_-12' })).toEqual({ kind: 'logs', source: { kind: 'journal' }, excerpt: 'x' });
        expect(parseChatAttachment({ kind: 'status', name: 'x' })).toEqual({ kind: 'status' });
        expect(parseChatAttachment({ kind: 'triage' })).toEqual({ kind: 'triage' });
    });

    it('rejects malformed attachments', () => {
        for (const value of [
            null, 'service', [], { kind: 'nope' }, { kind: 'service' }, { kind: 'service', name: '' }, { kind: 'service', name: 'a\nb' },
            { kind: 'service', name: 'x'.repeat(300) }, { kind: 'container', container: '-rf' }, { kind: 'container', container: 'a;b' },
            { kind: 'logs' }, { kind: 'logs', source: { kind: 'file' } }, { kind: 'logs', source: { kind: 'socket', path: '/x' } },
            { kind: 'logs', source: { kind: 'journal' }, excerpt: 42 }, { kind: 'logs', source: { kind: 'journal' }, selection: 'short' },
            { kind: 'logs', source: { kind: 'journal' }, selection: 'has spaces in it, sixteen+' }
        ]) {
            expect(parseChatAttachment(value), JSON.stringify(value)).toBeNull();
        }
    });

    it('keeps the end of an oversized excerpt, from a line start', () => {
        const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
        const clipped = clipExcerpt(lines);
        expect(clipped.length).toBeLessThanOrEqual(MAX_LOG_EXCERPT_CHARS);
        expect(clipped.startsWith('line ')).toBe(true);
        expect(clipped.endsWith('line 1999 xxxxxxxxxx')).toBe(true);
        expect(clipExcerpt(clipped)).toBe(clipped);
    });

    it('gives one key per attachment, whatever the key order', () => {
        expect(attachmentKey({ kind: 'service', name: 'a' })).toBe(attachmentKey(parseChatAttachment({ name: 'a', kind: 'service' })!));
        expect(attachmentKey({ kind: 'logs', source: { kind: 'file', path: '/x' } })).not.toBe(attachmentKey({ kind: 'logs', source: { kind: 'file', path: '/x' }, excerpt: 'y' }));
        expect(attachmentKey({ kind: 'logs', source: { kind: 'file', path: '/x' }, selection: 'AbCdEfGhIjKlMnOpQr_-12' })).not.toBe(attachmentKey({ kind: 'logs', source: { kind: 'file', path: '/x' } }));
        expect(attachmentKey({ kind: 'status' })).not.toBe(attachmentKey({ kind: 'triage' }));
        expect([isLogSelection({ kind: 'logs', source: { kind: 'journal' }, excerpt: 'x' }), isLogSelection({ kind: 'logs', source: { kind: 'journal' }, selection: 'AbCdEfGhIjKlMnOpQr_-12' }), isLogSelection({ kind: 'logs', source: { kind: 'journal' } })]).toEqual([true, true, false]);
    });
});

describe('parseChatEvidence', () => {
    const evidence = {
        serverId: 2,
        attachment: { kind: 'triage' },
        collectedAt: 1_700_000_000_000,
        sections: [{ id: 'disk', title: 'Disk', source: 'df -hP', text: '/ 94%', truncated: true, junk: 'x' }],
        signature: 'v1.abc'
    };

    it('keeps only the known fields', () => {
        expect(parseChatEvidence(evidence)).toEqual({ ...evidence, sections: [{ id: 'disk', title: 'Disk', source: 'df -hP', text: '/ 94%', truncated: true }] });
        expect(evidenceChars(parseChatEvidence(evidence)!)).toBe(5);
    });

    it('never keeps selected lines as text in its attachment', () => {
        const source = { kind: 'container', container: 'web' };
        const withExcerpt = parseChatEvidence({ ...evidence, attachment: { kind: 'logs', source, excerpt: 'key AKIAABCDEFGHIJKLMNOP' }, sections: [{ id: 'excerpt', title: 'Selected', text: 'key [REDACTED]' }] });
        expect(withExcerpt?.attachment).toEqual({ kind: 'logs', source });
        expect(JSON.stringify(withExcerpt)).not.toContain('AKIA');
    });

    it('is collected again from its attachment, or from the redacted lines of a selection', () => {
        const source = { kind: 'file' as const, path: '/var/log/app.log' };
        expect(recollectAttachment({ attachment: { kind: 'status' }, sections: [] })).toEqual({ kind: 'status' });
        const lines = ['a', 'key [REDACTED]'].join('\n');
        expect(recollectAttachment({ attachment: { kind: 'logs', source, selection: 'AbCdEfGhIjKlMnOpQr_-12' }, sections: [{ id: 'excerpt', title: 'Selected', text: lines }] }))
            .toEqual({ kind: 'logs', source, excerpt: lines });
        expect(recollectAttachment({ attachment: { kind: 'logs', source, selection: 'AbCdEfGhIjKlMnOpQr_-12' }, sections: [] })).toEqual({ kind: 'logs', source });
    });

    it('rejects malformed or oversized evidence', () => {
        const bad = (change: Record<string, unknown>) => parseChatEvidence({ ...evidence, ...change });
        expect(bad({ serverId: 0 })).toBeNull();
        expect(bad({ collectedAt: 'now' })).toBeNull();
        expect(bad({ signature: '' })).toBeNull();
        expect(bad({ attachment: { kind: 'x' } })).toBeNull();
        expect(bad({ sections: 'x' })).toBeNull();
        expect(bad({ sections: [{ id: 'secrets', title: 't', text: 'x' }] })).toBeNull();
        expect(bad({ sections: [{ id: 'disk', title: 't', text: 'x'.repeat(MAX_EVIDENCE_SECTION_CHARS + 1) }] })).toBeNull();
        expect(bad({ sections: Array.from({ length: 13 }, () => ({ id: 'disk', title: 't', text: 'x' })) })).toBeNull();
    });
});
