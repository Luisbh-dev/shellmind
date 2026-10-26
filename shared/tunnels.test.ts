import { describe, expect, it } from 'vitest';
import {
    describeTunnel,
    formatHostPort,
    isLoopbackHost,
    isValidBindHost,
    isValidPort,
    isValidRemoteHost,
    isWildcardHost,
    presetForPort,
    suggestedLocalPort,
    supportsTunnels,
    TUNNEL_PRESETS,
    tunnelConnectAddress,
    tunnelUrl,
} from './tunnels';

const tunnel = (local_host: string, local_port: number, remote_port: number, remote_host = '127.0.0.1') =>
    ({ local_host, local_port, remote_host, remote_port });

describe('tunnel helpers', () => {
    it('offers the common services with their default ports', () => {
        expect(TUNNEL_PRESETS.map((preset) => [preset.id, preset.remotePort])).toEqual([
            ['postgresql', 5432], ['mysql', 3306], ['redis', 6379], ['mongodb', 27017], ['http', 80],
            ['https', 443], ['kubernetes', 6443], ['rdp', 3389], ['custom', null],
        ]);
        expect(presetForPort(3306)?.name).toBe('MySQL / MariaDB');
        expect(presetForPort(1234)).toBeUndefined();
    });

    it('suggests a local port that does not clash with a local instance of the service', () => {
        expect(suggestedLocalPort(5432)).toBe(15432);
        expect(suggestedLocalPort(80)).toBe(10080);
        expect(suggestedLocalPort(60000)).toBe(60000);
    });

    it('validates ports', () => {
        expect([1, 22, 65535].every(isValidPort)).toBe(true);
        expect([0, 65536, 1.5, -1, '22', NaN, null].some(isValidPort)).toBe(false);
    });

    it('tells loopback and wildcard listen addresses apart', () => {
        for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', ' LOCALHOST ']) {
            expect(isLoopbackHost(host), host).toBe(true);
        }
        for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'fe80::1', '128.0.0.1']) {
            expect(isLoopbackHost(host), host).toBe(false);
        }
        expect(isWildcardHost('0.0.0.0')).toBe(true);
        expect(isWildcardHost('[::]')).toBe(true);
        expect(isWildcardHost('127.0.0.1')).toBe(false);
    });

    it('validates listen addresses and remote hosts', () => {
        for (const host of ['127.0.0.1', 'localhost', ' LOCALHOST ', '0.0.0.0', '[::1]', '::', '10.0.0.255']) {
            expect(isValidBindHost(host), host).toBe(true);
        }
        for (const host of ['999.1.1.1', '1.2.3', 'my-laptop', 'example.com', '1::2::3', '']) {
            expect(isValidBindHost(host), host).toBe(false);
        }
        for (const host of ['127.0.0.1', 'db.internal', '[fd00::5]', 'fe80::1%eth0', 'a'.repeat(253)]) {
            expect(isValidRemoteHost(host), host).toBe(true);
        }
        for (const host of ['', 'bad host', 'a[b', 'x;rm', 'a'.repeat(254)]) {
            expect(isValidRemoteHost(host), host).toBe(false);
        }
    });

    it('offers tunnels for SSH servers only', () => {
        expect(['linux', 'windows'].every(supportsTunnels)).toBe(true);
        expect(['ftp', 's3', 'local', 'other'].some(supportsTunnels)).toBe(false);
    });

    it('formats addresses, bracketing IPv6', () => {
        expect(formatHostPort('127.0.0.1', 5432)).toBe('127.0.0.1:5432');
        expect(formatHostPort('::1', 5432)).toBe('[::1]:5432');
        expect(formatHostPort('[fd00::5]', 80)).toBe('[fd00::5]:80');
        expect(describeTunnel(tunnel('127.0.0.1', 15432, 5432, 'db.internal'))).toBe('127.0.0.1:15432 -> db.internal:5432');
    });

    it('connects to wildcard listeners over loopback', () => {
        expect(tunnelConnectAddress(tunnel('0.0.0.0', 8080, 80))).toBe('127.0.0.1:8080');
        expect(tunnelConnectAddress(tunnel('::', 8080, 80))).toBe('[::1]:8080');
        expect(tunnelConnectAddress(tunnel('192.168.1.10', 8080, 80))).toBe('192.168.1.10:8080');
    });

    it('builds a browser URL only for web services', () => {
        expect(tunnelUrl(tunnel('127.0.0.1', 10080, 80))).toBe('http://127.0.0.1:10080/');
        expect(tunnelUrl(tunnel('0.0.0.0', 10443, 443))).toBe('https://127.0.0.1:10443/');
        expect(tunnelUrl(tunnel('::1', 18443, 8443))).toBe('https://[::1]:18443/');
        expect(tunnelUrl(tunnel('127.0.0.1', 13000, 3000))).toBe('http://127.0.0.1:13000/');
        expect(tunnelUrl(tunnel('127.0.0.1', 15432, 5432))).toBeNull();
        expect(tunnelUrl(tunnel('127.0.0.1', 16443, 6443))).toBeNull();
    });
});
