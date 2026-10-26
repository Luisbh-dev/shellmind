import { create } from 'zustand';

// Terminal preferences of this device (localStorage). Screen reader mode
// makes xterm keep an accessible copy of its rows and announce new output in
// a live region, so NVDA, JAWS, Narrator or VoiceOver can read the terminal;
// it costs some rendering speed, hence off by default. Every open terminal
// follows the setting live.

export const SCREEN_READER_STORAGE_KEY = 'shellmind.terminal.screenReaderMode';

type TerminalPrefs = {
    screenReaderMode: boolean;
    setScreenReaderMode: (enabled: boolean) => void;
};

function storage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

function readScreenReaderMode(): boolean {
    try {
        return storage()?.getItem(SCREEN_READER_STORAGE_KEY) === 'on';
    } catch {
        return false;
    }
}

export const useTerminalPrefs = create<TerminalPrefs>()((set) => ({
    screenReaderMode: readScreenReaderMode(),
    setScreenReaderMode: (enabled) => {
        try {
            if (enabled) storage()?.setItem(SCREEN_READER_STORAGE_KEY, 'on');
            else storage()?.removeItem(SCREEN_READER_STORAGE_KEY);
        } catch {
            // Not remembered on this device; it still applies until reload.
        }
        set({ screenReaderMode: enabled });
    }
}));

if (typeof window !== 'undefined') {
    // Another window of the app changed it.
    window.addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== SCREEN_READER_STORAGE_KEY) return;
        useTerminalPrefs.setState({ screenReaderMode: readScreenReaderMode() });
    });
}
