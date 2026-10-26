import { useEffect, useRef, useState, type RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TerminalAppearance } from '@/features/appearance/terminalThemes';

export type XtermHandle = {
    term: Terminal;
    search: SearchAddon;
    // Fits the terminal to its container now (no-op while hidden).
    fit: () => void;
};

// Debounce for container resizes: a panel animation or a window drag resizes
// the container every frame, and every refit reflows the scrollback and
// sends a resize (SIGWINCH) to the remote program.
const FIT_DEBOUNCE_MS = 60;
// WebGL contexts lost (GPU reset, sleep, too many contexts) are recreated a
// few times a minute at most; past that the DOM renderer stays.
const WEBGL_RETRY_DELAY_MS = 1000;
const WEBGL_MAX_RETRIES = 3;
const WEBGL_RETRY_WINDOW_MS = 60_000;

const linkPattern = /(?:https?:\/\/|www\.)[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

function openLink(event: MouseEvent, uri: string): void {
    event.preventDefault();
    try {
        const url = new URL(/^www\./i.test(uri) ? `https://${uri}` : uri);
        if (url.protocol === 'http:' || url.protocol === 'https:') window.open(url.toString(), '_blank', 'noopener,noreferrer');
    } catch {
        // Not a URL after all.
    }
}

function createTerminal(appearance: TerminalAppearance, screenReaderMode: boolean): Terminal {
    return new Terminal({
        screenReaderMode,
        cursorBlink: appearance.cursorBlink,
        cursorStyle: appearance.cursorStyle,
        fontSize: appearance.fontSize,
        fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Mono", Consolas, Menlo, monospace',
        fontWeight: 400,
        fontWeightBold: 600,
        lineHeight: 1.25,
        scrollback: 5000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        theme: appearance.scheme.theme,
        minimumContrastRatio: appearance.minimumContrastRatio
    });
}

function isMeasurable(element: HTMLElement): boolean {
    return element.clientWidth > 0 && element.clientHeight > 0;
}

// One xterm instance in `containerRef`, alive as long as the component.
// `visible`: the terminal is on screen; only then it renders with WebGL
// (browsers allow a limited number of WebGL contexts at a time).
// `appearance`: colours, font size and cursor, applied live when they change.
// `screenReaderMode`: xterm's accessible rows and live region (see
// preferences.ts), applied live too.
export function useXterm(
    containerRef: RefObject<HTMLDivElement | null>,
    options: { visible: boolean; appearance: TerminalAppearance; screenReaderMode?: boolean }
): XtermHandle | null {
    const [handle, setHandle] = useState<XtermHandle | null>(null);
    const appearanceRef = useRef(options.appearance);
    const screenReaderRef = useRef(options.screenReaderMode ?? false);
    useEffect(() => {
        appearanceRef.current = options.appearance;
        screenReaderRef.current = options.screenReaderMode ?? false;
    });

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;

        const term = createTerminal(appearanceRef.current, screenReaderRef.current);
        const fitAddon = new FitAddon();
        const search = new SearchAddon({ highlightLimit: 1200 });
        term.loadAddon(fitAddon);
        term.loadAddon(search);
        term.loadAddon(new WebLinksAddon(openLink, { urlRegex: linkPattern }));
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = '11';
        term.open(container);

        const fit = () => {
            if (!isMeasurable(container)) return;
            try {
                fitAddon.fit();
            } catch {
                // Not laid out yet.
            }
        };
        fit();

        let fitTimer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver(() => {
            if (fitTimer) clearTimeout(fitTimer);
            fitTimer = setTimeout(() => {
                fitTimer = null;
                fit();
            }, FIT_DEBOUNCE_MS);
        });
        observer.observe(container);

        setHandle({ term, search, fit });
        return () => {
            observer.disconnect();
            if (fitTimer) clearTimeout(fitTimer);
            setHandle(null);
            term.dispose();
        };
    }, [containerRef]);

    const { appearance } = options;
    useEffect(() => {
        if (!handle) return;
        const { term } = handle;
        term.options.theme = appearance.scheme.theme;
        term.options.minimumContrastRatio = appearance.minimumContrastRatio;
        term.options.cursorStyle = appearance.cursorStyle;
        term.options.cursorBlink = appearance.cursorBlink;
        if (term.options.fontSize !== appearance.fontSize) {
            term.options.fontSize = appearance.fontSize;
            // Another cell size: as many columns and rows as now fit.
            handle.fit();
        }
    }, [handle, appearance]);

    const screenReaderMode = options.screenReaderMode ?? false;
    useEffect(() => {
        if (handle && handle.term.options.screenReaderMode !== screenReaderMode) handle.term.options.screenReaderMode = screenReaderMode;
    }, [handle, screenReaderMode]);

    const { visible } = options;
    useEffect(() => {
        if (!handle || !visible) return undefined;
        const { term } = handle;
        let addon: WebglAddon | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let losses: number[] = [];
        let active = true;

        const attach = () => {
            retryTimer = null;
            if (!active) return;
            try {
                const webgl = new WebglAddon();
                webgl.onContextLoss(() => {
                    // Drop the dead renderer (xterm falls back to the DOM one)
                    // and bring WebGL back shortly.
                    webgl.dispose();
                    if (addon === webgl) addon = null;
                    const now = Date.now();
                    losses = losses.filter((at) => now - at < WEBGL_RETRY_WINDOW_MS);
                    losses.push(now);
                    if (active && losses.length <= WEBGL_MAX_RETRIES) retryTimer = setTimeout(attach, WEBGL_RETRY_DELAY_MS);
                });
                term.loadAddon(webgl);
                addon = webgl;
            } catch {
                // No WebGL here: the DOM renderer it is.
            }
        };
        attach();
        handle.fit();

        return () => {
            active = false;
            if (retryTimer) clearTimeout(retryTimer);
            addon?.dispose();
            addon = null;
        };
    }, [handle, visible]);

    return handle;
}
