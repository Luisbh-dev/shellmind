import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isIpLiteral } from '../../shared/tunnels';
import { parseBindHost, parseTunnelInput } from './validate';

// The UI validates listen addresses with the shared isIpLiteral(); the backend
// listens with Node, so both must agree on what an IP address is.
const ADDRESSES = [
    '127.0.0.1', '0.0.0.0', '255.255.255.255', '10.0.0.1', '192.168.1.10', '1.2.3.4',
    '999.1.1.1', '256.0.0.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.04', '1..2.3', ' 1.2.3.4', '1.2.3.4 ', '-1.2.3.4', '',
    '::', '::1', '1::', 'fe80::1', 'fd00::5', '2001:db8::8a2e:370:7334', '2001:0db8:0000:0000:0000:ff00:0042:8329',
    '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', '1::2::3', ':::', ':1::', '1:',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::127.0.0.1', '1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:7:1.2.3.4', '::ffff:999.0.0.1',
    'fe80::1%eth0', 'fe80::1%12', 'g::1', '12345::1', 'localhost', 'example.com',
];

describe('tunnel input validation', () => {
    it('accepts exactly the IP addresses Node accepts (around spaces aside)', () => {
        for (const address of ADDRESSES) {
            expect(isIpLiteral(address), JSON.stringify(address)).toBe(net.isIP(address.trim()) !== 0);
        }
    });

    it('keeps the listen address, mapping localhost to 127.0.0.1', () => {
        expect(parseBindHost(undefined)).toBe('127.0.0.1');
        expect(parseBindHost('localhost')).toBe('127.0.0.1');
        expect(parseBindHost('[::1]')).toBe('::1');
        expect(parseBindHost(' 10.0.0.2 ')).toBe('10.0.0.2');
        expect(() => parseBindHost('999.1.1.1')).toThrow(expect.objectContaining({ code: 'INVALID_TUNNEL', details: { field: 'local_host' } }));
    });

    it('names the invalid field in the error details', () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ local_port: 'x', remote_port: 80 }, 'local_port'],
            [{ local_port: 8080, remote_port: 0 }, 'remote_port'],
            [{ local_port: 8080, remote_port: 80, remote_host: 'a b' }, 'remote_host'],
            [{ local_port: 8080, remote_port: 80, name: 7 }, 'name'],
            [{ local_port: 8080, remote_port: 80, auto_start: 1 }, 'auto_start'],
        ];
        for (const [body, field] of cases) {
            expect(() => parseTunnelInput(body), field).toThrow(expect.objectContaining({ code: 'INVALID_TUNNEL', status: 400, details: { field } }));
        }
    });
});
