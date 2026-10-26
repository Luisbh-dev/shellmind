import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '@/i18n';
import { containerStatusText, formatEngineSizes } from './format';

// UX-13: Docker and Podman print their status lines and sizes in English;
// the containers views show them in the UI language.

afterEach(() => setLanguage('en'));

describe('container status lines', () => {
    it('reads the engines\' forms in English as they print them', () => {
        setLanguage('en');
        expect(containerStatusText('Up 9 minutes', t, 'en')).toBe('Up 9 minutes');
        expect(containerStatusText('Up About an hour (healthy)', t, 'en')).toBe('Up 1 hour · healthy');
        expect(containerStatusText('Exited (137) 3 days ago', t, 'en')).toBe('Exited (137) 3 days ago');
        expect(containerStatusText('Created', t, 'en')).toBe('Created');
    });

    it('says them in Spanish', async () => {
        setLanguage('es');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(containerStatusText('Up 9 minutes', t, 'es')).toBe('Lleva 9 minutos');
        expect(containerStatusText('Up 2 hours (unhealthy)', t, 'es')).toBe('Lleva 2 horas · con fallos');
        expect(containerStatusText('Up Less than a second', t, 'es')).toBe('Lleva 1 segundo');
        expect(containerStatusText('Exited (0) 3 days ago', t, 'es')).toBe('Salió con código 0 hace 3 días');
        expect(containerStatusText('Restarting (1) 5 seconds ago', t, 'es')).toBe('Reiniciándose (código 1) hace 5 segundos');
        expect(containerStatusText('Created', t, 'es')).toBe('Creado');
        // Another form is shown as the engine says it.
        expect(containerStatusText('Removal In Progress', t, 'es')).toBeNull();
        expect(containerStatusText('Up for a while', t, 'es')).toBeNull();
    });
});

describe('engine sizes', () => {
    it('writes the numbers in the UI language, in the engine\'s own units', () => {
        expect(formatEngineSizes('1.53kB / 126B', 'es')).toBe('1,53 kB / 126 B');
        expect(formatEngineSizes('12.5MiB / 1.94GiB', 'en')).toBe('12.5 MiB / 1.94 GiB');
        expect(formatEngineSizes('0B / 0B', 'en')).toBe('0 B / 0 B');
        // Anything else is left as it is.
        expect(formatEngineSizes('--', 'es')).toBe('--');
        expect(formatEngineSizes('', 'es')).toBe('');
        expect(formatEngineSizes(undefined, 'es')).toBeUndefined();
    });
});
