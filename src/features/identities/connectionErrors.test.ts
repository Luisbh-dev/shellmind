import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '@/i18n';
import { describeConnectionError } from '@/lib/connectionErrors';

// W7-S2: the connection codes identities add read in the user's language in
// terminals and in the install / rotate progress.

afterEach(() => setLanguage('system'));

describe('identity connection errors', () => {
    it('are translated, with the agent\'s reason kept', () => {
        setLanguage('es');
        expect(describeConnectionError({ code: 'AGENT_FAILED', message: 'Auth failed', details: { reason: 'Pageant is not running' } }, t))
            .toBe('El servidor no ha aceptado el inicio de sesión y no se ha podido usar el agente SSH (Pageant is not running).');
        expect(describeConnectionError({ code: 'AGENT_UNAVAILABLE', message: 'no agent' }, t)).toMatch(/^Este servidor entra con el agente SSH/);
        expect(describeConnectionError({ code: 'IDENTITY', message: 'gone' }, t)).toBe('La identidad con la que entraba este servidor ya no existe. Edita la conexión y elige otra.');
        setLanguage('en');
        expect(describeConnectionError({ code: 'IDENTITY', message: 'gone' }, t)).toBe('The identity this server signed in with no longer exists. Edit the connection and choose another one.');
    });
});
