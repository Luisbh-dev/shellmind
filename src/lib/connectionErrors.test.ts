import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@/i18n';
import { describeConnectionError, plainText } from './connectionErrors';

afterEach(() => setLanguage('system'));

describe('connection errors', () => {
    it('names a known code in the UI language, with its details filled in', () => {
        setLanguage('en');
        expect(describeConnectionError({ code: 'AUTH_FAILED', message: 'All configured authentication methods failed', details: { methods: 'publickey' } }))
            .toBe('The server rejected the saved credentials. It accepts: publickey.');
        expect(describeConnectionError({ code: 'UNKNOWN_CLI_PRESET', message: '"x" is set to the CLI preset "kubctl"…' }))
            .toBe('This connection is set to a CLI preset ShellMind does not know. Edit the connection and choose another one.');
        setLanguage('es');
        expect(describeConnectionError({ code: 'UNKNOWN_CLI_PRESET', message: '…' })).toBe('Esta conexión tiene un tipo de CLI que ShellMind no conoce. Edita la conexión y elige otro.');
    });

    it('shows the backend text of a code it does not know, without control characters', () => {
        setLanguage('en');
        expect(describeConnectionError({ code: 'SOMETHING_NEW', message: 'odd\u001b[2Jfailure' })).toBe('odd [2Jfailure');
        expect(plainText('a\u0007b\nc')).toBe('a b\nc');
    });
});
