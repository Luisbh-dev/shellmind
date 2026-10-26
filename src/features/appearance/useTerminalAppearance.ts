import { useMemo } from 'react';
import { useAppearancePrefs, useResolvedTheme } from './store';
import { terminalAppearance, type TerminalAppearance } from './terminalThemes';

// The terminal look of the current preferences; every xterm follows it live.
export function useTerminalAppearance(): TerminalAppearance {
    const prefs = useAppearancePrefs();
    const theme = useResolvedTheme();
    return useMemo(() => terminalAppearance(prefs, theme), [prefs, theme]);
}
