import { describe, expect, it } from 'vitest';
import { buildRdpFileContent } from './rdp';

describe('buildRdpFileContent', () => {
    it('describes the connection, brackets IPv6 and never holds a password', () => {
        const content = buildRdpFileContent({ host: 'fe80::1', port: 3390, username: 'admin', domain: 'CORP' });
        expect(content.split('\r\n').slice(0, 3)).toEqual(['full address:s:[fe80::1]:3390', 'username:s:CORP\\admin', 'prompt for credentials:i:1']);
        expect(content).not.toMatch(/password/i);
    });

    it('leaves the user name out when there is none', () => {
        expect(buildRdpFileContent({ host: 'win', port: 3389 })).not.toContain('username:');
    });

    it('keeps line breaks in values from adding settings', () => {
        const content = buildRdpFileContent({ host: 'win', port: 3389, username: 'admin\r\nalternate shell:s:calc.exe' });
        expect(content.split('\r\n').filter((line) => line.startsWith('alternate shell'))).toEqual([]);
    });
});
