import { afterEach, describe, expect, it } from 'vitest';
import { forgetTerminalSecrets, maskTerminalSecrets, rememberTerminalSecrets } from './terminalSecrets';

afterEach(() => {
    forgetTerminalSecrets(1);
    forgetTerminalSecrets(2);
});

describe('terminal secrets', () => {
    it('masks the values typed into a server terminal, also when a line editor wrapped them', () => {
        rememberTerminalSecrets(1, [{ name: 'password', value: 'TermSecret-4242-xyz' }, { name: 'pin', value: '12' }]);
        expect(maskTerminalSecrets(1, 'echo TermSecret-4242-xyz && echo TermSecret-4242-xyz')).toBe('echo {{password}} && echo {{password}}');
        // Hard-wrapped at the terminal width by the shell's line editor.
        expect(maskTerminalSecrets(1, '$ printf %s TermSecret-4242-xy\nz > /tmp/app.pw')).toBe('$ printf %s {{password}} > /tmp/app.pw');
        expect(maskTerminalSecrets(1, 'Term\r\nSecret-4242-xyz')).toBe('{{password}}');
        // Too short to look for; other servers are not affected.
        expect(maskTerminalSecrets(1, 'pin 12')).toBe('pin 12');
        expect(maskTerminalSecrets(2, 'TermSecret-4242-xyz')).toBe('TermSecret-4242-xyz');
    });

    it('masks a longer value whole, treats the value literally, and forgets them all at once', () => {
        rememberTerminalSecrets(1, [{ name: 'short', value: 'a.b' }]);
        rememberTerminalSecrets(1, [{ name: 'long', value: 'a.b$c(d)' }]);
        expect(maskTerminalSecrets(1, 'x a.b$c(d) a.b axb')).toBe('x {{long}} {{short}} axb');
        forgetTerminalSecrets(1);
        expect(maskTerminalSecrets(1, 'a.b$c(d)')).toBe('a.b$c(d)');
    });
});
