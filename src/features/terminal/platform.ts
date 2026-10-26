// The desktop app (Electron) or a plain browser tab (self-hosted web mode).
// Browsers keep some shortcuts for themselves and never pass them to the
// page: Ctrl+Shift+T reopens a closed browser tab, Ctrl+Shift+W closes the
// window. The terminal tab shortcuts therefore exist in the desktop app only.
export { isDesktopApp } from '@/lib/platform';

export const NEW_TERMINAL_TAB_SHORTCUT = 'Mod+Shift+T';
export const CLOSE_TERMINAL_TAB_SHORTCUT = 'Mod+Shift+W';
