import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Settings } from 'lucide-react';
import { setLanguage } from '@/i18n';
import { CommandPalette } from './CommandPalette';
import type { PaletteItem } from './items';

const ITEMS: PaletteItem[] = [{ id: 'cmd-settings', section: 'commands', label: 'Ajustes', icon: Settings, shortcut: 'Ctrl+,', run: vi.fn() }];

afterEach(() => setLanguage('system'));

describe('CommandPalette', () => {
    // UX-08: the key hints follow the UI language, like every other shortcut.
    it('names the keys of its hints in the UI language', () => {
        setLanguage('es');
        render(<CommandPalette open onClose={vi.fn()} items={ITEMS} />);
        const dialog = screen.getByRole('dialog', { name: 'Paleta de comandos' });
        const keys = [...dialog.querySelectorAll('kbd')].map((kbd) => kbd.textContent);
        expect(keys).toEqual(['Esc', 'Ctrl+,', '↑', '↓', 'Intro', 'Esc']);
        expect(within(dialog).queryByText('Enter')).toBeNull();
    });
});
