// Terminal colour schemes (xterm themes). "auto" picks ShellMind dark or
// light after the app theme; the ShellMind ones draw the cursor in the
// accent colour. Solarized keeps its accents as the bright colours (xterm
// draws bold text in them) instead of the classic grey base tones.
import type { ITheme } from '@xterm/xterm';
import {
    ACCENT_COLORS, resolveTerminalTheme, type Accent, type AppearancePrefs, type ConcreteTerminalThemeId, type CursorStyle,
    type ResolvedTheme
} from './model';

export type TerminalScheme = {
    id: ConcreteTerminalThemeId;
    // Display name (brand names are not translated).
    name: string;
    kind: ResolvedTheme;
    theme: Required<Pick<ITheme,
        'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground' |
        'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
        'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
    >>;
};

export const TERMINAL_SCHEMES: Record<ConcreteTerminalThemeId, TerminalScheme> = {
    'shellmind-dark': {
        id: 'shellmind-dark',
        name: 'ShellMind Dark',
        kind: 'dark',
        theme: {
            background: '#0b0d11', foreground: '#e6e8ec', cursor: '#2dd4cb', cursorAccent: '#0b0d11', selectionBackground: 'rgba(45, 212, 203, 0.3)',
            black: '#1d2129', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d8',
            brightBlack: '#5c6370', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa'
        }
    },
    'shellmind-light': {
        id: 'shellmind-light',
        name: 'ShellMind Light',
        kind: 'light',
        theme: {
            background: '#ffffff', foreground: '#1f2328', cursor: '#0e7472', cursorAccent: '#ffffff', selectionBackground: 'rgba(14, 116, 114, 0.2)',
            black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0550ae', magenta: '#8250df', cyan: '#0e7490', white: '#6e7781',
            brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#0969da', brightMagenta: '#a475f9', brightCyan: '#155e75', brightWhite: '#8c959f'
        }
    },
    dracula: {
        id: 'dracula',
        name: 'Dracula',
        kind: 'dark',
        theme: {
            background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: 'rgba(68, 71, 90, 0.9)',
            black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
            brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff'
        }
    },
    'one-dark': {
        id: 'one-dark',
        name: 'One Dark',
        kind: 'dark',
        theme: {
            background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: 'rgba(62, 68, 81, 0.95)',
            black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
            brightBlack: '#5c6370', brightRed: '#ff7b86', brightGreen: '#b1e18b', brightYellow: '#efb074', brightBlue: '#67cdff', brightMagenta: '#e48bff', brightCyan: '#63d4e0', brightWhite: '#ffffff'
        }
    },
    'solarized-dark': {
        id: 'solarized-dark',
        name: 'Solarized Dark',
        kind: 'dark',
        theme: {
            background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: 'rgba(147, 161, 161, 0.25)',
            black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
            brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#fdf6e3'
        }
    },
    'solarized-light': {
        id: 'solarized-light',
        name: 'Solarized Light',
        kind: 'light',
        theme: {
            background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: 'rgba(88, 110, 117, 0.2)',
            black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
            brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#eee8d5'
        }
    },
    nord: {
        id: 'nord',
        name: 'Nord',
        kind: 'dark',
        theme: {
            background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: 'rgba(67, 76, 94, 0.9)',
            black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
            brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
        }
    }
};

function hexToRgba(hex: string, alpha: number): string {
    const value = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const isShellMindScheme = (id: ConcreteTerminalThemeId) => id === 'shellmind-dark' || id === 'shellmind-light';

// The scheme with the accent applied (ShellMind schemes only).
export function terminalScheme(id: ConcreteTerminalThemeId, accent: Accent): TerminalScheme {
    const scheme = TERMINAL_SCHEMES[id];
    if (!isShellMindScheme(id)) return scheme;
    const color = ACCENT_COLORS[accent][scheme.kind];
    return {
        ...scheme,
        theme: { ...scheme.theme, cursor: color, selectionBackground: hexToRgba(color, scheme.kind === 'dark' ? 0.3 : 0.2) }
    };
}

export type TerminalAppearance = {
    scheme: TerminalScheme;
    fontSize: number;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    minimumContrastRatio: number;
};

// The ShellMind schemes keep all text readable: xterm lifts a foreground
// below WCAG AA (4.5:1, half that for dim text) against its background while
// drawing, such as the light scheme's bright white (bold text too), the dark
// one's bright black, or a program's own 256-colour picks. The classic
// schemes keep their authors' colours.
const SHELLMIND_MIN_CONTRAST = 4.5;

export function terminalAppearance(prefs: AppearancePrefs, theme: ResolvedTheme): TerminalAppearance {
    const id = resolveTerminalTheme(prefs.terminalTheme, theme);
    return {
        scheme: terminalScheme(id, prefs.accent),
        fontSize: prefs.terminalFontSize,
        cursorStyle: prefs.cursorStyle,
        cursorBlink: prefs.cursorBlink,
        minimumContrastRatio: isShellMindScheme(id) ? SHELLMIND_MIN_CONTRAST : 1
    };
}

// Search highlights and failed-command markers drawn over the output.
export type TerminalOverlayColors = {
    search: {
        matchBackground: string;
        matchBorder: string;
        matchOverviewRuler: string;
        activeMatchBackground: string;
        activeMatchBorder: string;
        activeMatchColorOverviewRuler: string;
    };
    error: { background: string; foreground: string; ruler: string; edge: string };
};

const OVERLAYS: Record<ResolvedTheme, TerminalOverlayColors> = {
    dark: {
        search: {
            matchBackground: '#22314a', matchBorder: '#60a5fa', matchOverviewRuler: '#60a5fa',
            activeMatchBackground: '#1d4ed8', activeMatchBorder: '#93c5fd', activeMatchColorOverviewRuler: '#93c5fd'
        },
        error: { background: '#3b1a1e', foreground: '#fecaca', ruler: '#ef4444', edge: '#f87171' }
    },
    light: {
        search: {
            matchBackground: '#dbeafe', matchBorder: '#3b82f6', matchOverviewRuler: '#3b82f6',
            activeMatchBackground: '#93c5fd', activeMatchBorder: '#1d4ed8', activeMatchColorOverviewRuler: '#1d4ed8'
        },
        error: { background: '#fee2e2', foreground: '#991b1b', ruler: '#dc2626', edge: '#dc2626' }
    }
};

export function terminalOverlayColors(kind: ResolvedTheme): TerminalOverlayColors {
    return OVERLAYS[kind];
}
