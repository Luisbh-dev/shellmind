import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLanguage, t } from '@/i18n';
import { APP_VERSION } from '@/lib/version';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { useTerminalPrefs } from '@/features/terminal/preferences';
import { buildShortcutGroups } from '@/features/palette/shortcutList';
import SettingsModal from './SettingsModal';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const STATUS = {
    providers: { gemini: { configured: false, source: 'none' }, minimax: { configured: true, source: 'none' } },
    features: { minimaxProxy: { enabled: true, baseUrl: 'https://ia.shellmind.app', allowClientKey: true, usesProxyAuth: true, localKeyConfigured: false, localKeySource: 'none' } },
};

let statusResponse: () => Response;

beforeEach(() => {
    setLanguage('en');
    statusResponse = () => json(STATUS);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/api/config/status')) return statusResponse();
        if (url.endsWith('/api/health')) return json({ ok: true, version: '9.9.9' });
        return json({});
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

function setup(section?: 'general' | 'appearance' | 'ai' | 'data' | 'about', title = 'Settings') {
    const user = userEvent.setup();
    const { unmount } = render(
        <ToastProvider>
            <ConfirmProvider>
                <SettingsModal
                    isOpen
                    initialSection={section}
                    onClose={() => undefined}
                    shortcutGroups={buildShortcutGroups(t, [], false)}
                    onServersImported={() => undefined}
                    onOpenSshImport={() => undefined}
                />
            </ConfirmProvider>
        </ToastProvider>
    );
    return { user, unmount, dialog: screen.getByRole('dialog', { name: title }) };
}

describe('SettingsModal', () => {
    it('is organised in sections reachable as tabs', async () => {
        const { user, dialog } = setup();
        const tabs = within(dialog).getByRole('tablist', { name: 'Settings sections' });
        expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['General', 'Appearance', 'AI', 'Keychain', 'Data', 'About']);
        expect(within(dialog).getByRole('combobox', { name: /Language/ })).toBeInTheDocument();
        const general = within(dialog).getByRole('region', { name: 'General' });
        expect(within(general).getByText('Command palette')).toBeInTheDocument();
        expect(within(general).getByText('Ctrl+K')).toBeInTheDocument();
        expect(within(dialog).getByRole('region', { name: 'Terminal' })).toHaveTextContent('Search the outputCtrl+Shift+F');

        // The version of this build (package.json), and the backend's when it differs.
        await user.click(within(tabs).getByRole('tab', { name: 'About' }));
        expect(within(dialog).getByText(`Version ${APP_VERSION}`)).toBeInTheDocument();
        expect(await within(dialog).findByText('Backend version 9.9.9')).toBeInTheDocument();
        // UX-14: what 1.0 is, as the README says it.
        expect(within(dialog).getByText('The self-hosted workspace for sysadmins and DevOps: SSH terminals, files, operations, fleet health, Remote Desktop and an AI assistant.')).toBeInTheDocument();
    });

    it('discloses that MiniMax goes through the ShellMind proxy and links the legal notice instead of naming hosts', async () => {
        const { dialog } = setup('ai');
        const link = await within(dialog).findByRole('link', { name: 'legal notice' });
        expect(link).toHaveAttribute('href', 'https://shellmind.app/legal.html#ai-data');
        expect(link).toHaveAttribute('target', '_blank');
        const disclosure = link.closest('p');
        expect(disclosure).toHaveTextContent('MiniMax requests go through the ShellMind proxy before reaching MiniMax, as described in the legal notice.');
        expect(disclosure).not.toHaveTextContent('ia.shellmind.app');
        expect(within(dialog).getByLabelText('Gemini API key')).toBeInTheDocument();
    });

    it('says when the user\'s key goes straight to MiniMax, without naming hosts', async () => {
        const minimaxProxy = { ...STATUS.features.minimaxProxy, baseUrl: '' };
        statusResponse = () => json({ ...STATUS, features: { minimaxProxy: { ...minimaxProxy, route: 'proxy' } } });
        const first = setup('ai');
        const proxied = (await within(first.dialog).findByRole('link', { name: 'legal notice' })).closest('p');
        expect(proxied).toHaveTextContent('Add your own MiniMax key to send requests straight to MiniMax instead.');
        first.unmount();

        statusResponse = () => json({
            providers: { ...STATUS.providers, minimax: { configured: true, source: 'db' } },
            features: {
                minimaxProxy: {
                    ...minimaxProxy, route: 'direct', apiBaseUrl: 'https://api.minimax.io/anthropic', localKeyConfigured: true, localKeySource: 'db',
                },
            },
        });
        const second = setup('ai');
        expect(await within(second.dialog).findByText(
            'With your own key, MiniMax requests go straight from the ShellMind backend to MiniMax; the ShellMind proxy is not used.'
        )).toBeInTheDocument();
        expect(within(second.dialog).getByText('Configured (Database)')).toBeInTheDocument();
    });

    it('says the backend could not be asked instead of "Not configured", and retries', async () => {
        statusResponse = () => json({ error: 'database is locked' }, 500);
        const { user, dialog } = setup('ai');

        const alert = await within(dialog).findByRole('alert');
        expect(alert).toHaveTextContent('Could not check the AI configuration');
        expect(alert).toHaveTextContent('database is locked');
        expect(within(dialog).queryByText('Not configured')).toBeNull();

        statusResponse = () => json(STATUS);
        await user.click(within(alert).getByRole('button', { name: 'Try again' }));
        expect(await within(dialog).findByText('Not configured')).toBeInTheDocument();
    });

    it('turns on the screen reader mode of the terminals', async () => {
        const { user, dialog } = setup('appearance');
        const toggle = within(dialog).getByRole('checkbox', { name: 'Screen reader support in the terminal' });
        expect(toggle).not.toBeChecked();
        expect(toggle).toHaveAccessibleDescription(/NVDA, JAWS or VoiceOver/);

        await user.click(toggle);
        // The terminals' own preference (every open terminal follows it), remembered on this device.
        expect(useTerminalPrefs.getState().screenReaderMode).toBe(true);
        expect(localStorage.getItem('shellmind.terminal.screenReaderMode')).toBe('on');
        expect(toggle).toBeChecked();
        await user.click(toggle);
        expect(useTerminalPrefs.getState().screenReaderMode).toBe(false);
        expect(localStorage.getItem('shellmind.terminal.screenReaderMode')).toBeNull();
    });

    it('explains how credentials are stored', () => {
        const { dialog } = setup('data');
        expect(within(dialog).getByText('Credentials are encrypted at rest')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Export configuration' })).toBeInTheDocument();
    });

    it('is translated', async () => {
        act(() => setLanguage('es'));
        const { dialog } = setup('data', 'Ajustes');
        expect(within(dialog).getByText('Las credenciales se guardan cifradas')).toBeInTheDocument();
        expect(within(dialog).getByRole('tab', { name: 'Datos', selected: true })).toBeInTheDocument();
    });
});
