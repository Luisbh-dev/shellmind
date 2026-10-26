import { describe, expect, it } from 'vitest';
import { patchMarker } from '@shared/patch';
import { translate } from '@/i18n/catalog';
import { localizePatchError, localizePatchRuns, localizePatchText, patchDuration } from './output';

// The marker lines of a patch run (server/patch/scripts.ts and step.ts) in
// the user's language; the package manager's own output stays as it is.

const en = (key: string, params?: Record<string, string | number>) => translate('en', key, params);
const es = (key: string, params?: Record<string, string | number>) => translate('es', key, params);

describe('patch run output', () => {
    it('words every line ShellMind writes, in English and Spanish', () => {
        const output = [
            '[shellmind] manager=apt',
            '+ sudo -n apt-get install --only-upgrade libc6',
            'Setting up libc6:amd64 (2.36-9+deb12u14) ...',
            '[shellmind] reboot-required=yes',
            '[shellmind] reboot=start',
            '[shellmind] reboot=waiting',
            '[shellmind] reboot=still-waiting after=150',
            patchMarker('reboot', 'back', { after: 42, up: 9, state: 'running', failed: 1 }),
            '[shellmind] security-updates=none',
            '[shellmind] some-future-event=1',
            ''
        ].join('\n');
        expect(localizePatchText(output, en)).toBe([
            '[shellmind] Package manager: apt.',
            '+ sudo -n apt-get install --only-upgrade libc6',
            'Setting up libc6:amd64 (2.36-9+deb12u14) ...',
            '[shellmind] A reboot is required.',
            '[shellmind] Rebooting the server.',
            '[shellmind] Waiting for SSH to come back…',
            '[shellmind] Still waiting for SSH (2 min 30 s)…',
            '[shellmind] Back after 42 s · up 9 s · system running · 1 failed unit',
            '[shellmind] No security updates are pending.',
            // Unknown to this version: shown as it came.
            '[shellmind] some-future-event=1',
            ''
        ].join('\n'));
        expect(localizePatchText('[shellmind] error=no-security manager=apk\n', es)).toBe('[shellmind] apk no indica qué actualizaciones corrigen problemas de seguridad: instala todas las actualizaciones.\n');
        expect(localizePatchText('[shellmind] reboot-check=failed-units before=0 after=2', es)).toBe('[shellmind] Tras el reinicio fallan más unidades de systemd que antes (0 antes, 2 ahora).');
        expect(localizePatchText('nothing of ours', en)).toBe('nothing of ours');
    });

    it('words why a server failed, keeping the server’s own message', () => {
        expect(localizePatchError(patchMarker('reboot-failed', 'timeout', { wait: 600 }, 'connect ECONNREFUSED\n10.0.0.2:22'), en))
            .toBe('The server did not answer SSH within 10 min of the reboot. Last attempt: connect ECONNREFUSED 10.0.0.2:22');
        expect(localizePatchError('[shellmind] reboot-failed=connection | Auth failed: the saved credentials were rejected.', es))
            .toBe('Tras el reinicio no se ha podido conectar con el servidor: Auth failed: the saved credentials were rejected.');
        expect(localizePatchError('[shellmind] reboot-failed=same-boot after=300', en)).toBe('The server did not reboot: 5 min after the reboot command it still runs the same boot.');
        expect(localizePatchError('connect ECONNREFUSED', en)).toBe('connect ECONNREFUSED');
        expect(localizePatchError(null, en)).toBeNull();
    });

    it('words a job’s servers once per language', () => {
        const run = { stdout: '[shellmind] reboot-required=no\n', stderr: '[shellmind] error=privilege\n', error: null };
        const [first] = localizePatchRuns([run], en);
        expect(first).toEqual({ stdout: '[shellmind] No reboot is required.\n', stderr: '[shellmind] This needs root or sudo without a password (sudo -n), and this user has neither: ShellMind never types a password.\n', error: null });
        expect(localizePatchRuns([run], en)[0]).toBe(first);
        expect(localizePatchRuns([run], es)[0].stdout).toBe('[shellmind] No hace falta reiniciar.\n');
    });

    it('says durations as people do', () => {
        expect([5, 119, 120, 150, 600].map((seconds) => patchDuration(en, seconds))).toEqual(['5 s', '119 s', '2 min', '2 min 30 s', '10 min']);
    });
});
