import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { getLanguage, getLanguagePreference, setLanguage, t, useT } from './index';
import { Trans } from './Trans';

function FilesLabel() {
    const translate = useT();
    return <span>{translate('app.tabs.files')}</span>;
}

afterEach(() => {
    vi.restoreAllMocks();
    setLanguage('system');
});

describe('language state', () => {
    it('re-renders useT() consumers and persists an explicit choice', () => {
        setLanguage('en');
        render(<FilesLabel />);
        expect(screen.getByText('Files')).toBeInTheDocument();

        act(() => setLanguage('es'));

        expect(screen.getByText('Archivos')).toBeInTheDocument();
        expect(t('app.tabs.files')).toBe('Archivos');
        expect(localStorage.getItem('shellmind-language')).toBe('es');
        expect(document.documentElement.lang).toBe('es');
    });

    it('follows navigator.language when set back to the system default', () => {
        setLanguage('en');
        vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-MX');

        setLanguage('system');

        expect(getLanguagePreference()).toBe('system');
        expect(getLanguage()).toBe('es');
        expect(localStorage.getItem('shellmind-language')).toBeNull();
    });
});

describe('a language that is not loaded yet', () => {
    it('keeps showing English until its strings arrive, then switches', async () => {
        localStorage.setItem('shellmind-language', 'es');
        // Fresh modules: nothing preloaded, Spanish saved as the choice.
        vi.resetModules();
        const i18n = await import('./index');
        const catalog = await import('./catalog');
        expect(catalog.isLanguageLoaded('es')).toBe(false);
        expect(i18n.getLanguagePreference()).toBe('es');
        expect(i18n.getLanguage()).toBe('en');
        expect(i18n.t('app.tabs.files')).toBe('Files');

        await i18n.languageReady();
        expect(i18n.getLanguage()).toBe('es');
        expect(i18n.t('app.tabs.files')).toBe('Archivos');
        expect(document.documentElement.lang).toBe('es');
        localStorage.removeItem('shellmind-language');
    });
});

describe('Trans', () => {
    it('fills placeholders with React nodes', () => {
        setLanguage('en');
        const { container } = render(
            <Trans k="sidebar.deleteDialog.message" values={{ name: <strong>db-1</strong> }} />
        );
        expect(container.textContent).toBe('Remove db-1 from your connections?');
        expect(container.querySelector('strong')?.textContent).toBe('db-1');
    });
});
