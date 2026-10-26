import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { classifyTerminalLine, CommandOutputTracker } from '@/lib/terminalIssues';
import { terminalOverlayColors, type TerminalOverlayColors } from '@/features/appearance/terminalThemes';

// Marks error lines in the terminal (red background, overview ruler, a "!"
// button that asks the AI about that very line). It reads the rendered rows
// rather than the raw output, so prompts and escape sequences are seen as
// the user sees them; full-screen programs are left alone.

type Highlight = { marker: IMarker; text: string; decoration?: IDecoration; button?: HTMLButtonElement };

type MarkerColors = TerminalOverlayColors['error'];

const DEFAULT_COLORS = terminalOverlayColors('dark').error;

const SCAN_DELAY_MS = 150;
// Rows looked at per pass: a huge output is only checked near its end.
const MAX_ROWS_PER_SCAN = 300;
const MAX_HIGHLIGHTS = 14;

// Decorations live in xterm's own DOM layer, outside the app's styles. The
// button sits at the right end of the row, where it hides the least text.
const BUTTON_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'absolute',
    right: '6px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '18px',
    height: '18px',
    padding: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid rgba(248, 113, 113, 0.45)',
    borderRadius: '9999px',
    background: 'rgba(127, 29, 29, 0.95)',
    color: '#fecaca',
    fontSize: '11px',
    lineHeight: '1',
    cursor: 'pointer'
};

export class ErrorMarkers {
    private highlights: Highlight[] = [];
    private scannedTo: IMarker | undefined;
    private readonly tracker = new CommandOutputTracker();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    // The screen was erased since the last pass (`clear`, Ctrl+L).
    private erased = false;
    private readonly eraseHandler: IDisposable;

    constructor(
        private readonly term: Terminal,
        private readonly options: {
            label: () => string;
            onFix: (line: string) => void;
            // Highlight colours for the terminal's colour scheme (see recolor()).
            colors?: () => MarkerColors;
        }
    ) {
        // ESC [ 2 J / ESC [ 3 J: xterm empties the rows but keeps their
        // markers. Returning false lets xterm handle the sequence as usual.
        this.eraseHandler = term.parser.registerCsiHandler({ final: 'J' }, (params) => {
            if ((params[0] === 2 || params[0] === 3) && term.buffer.active.type === 'normal') this.erased = true;
            return false;
        });
    }

    // Output arrived: look at the new rows soon.
    schedule(): void {
        if (this.timer || this.disposed) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.scan();
        }, SCAN_DELAY_MS);
    }

    // The user ran `command`: the output of listing and search commands is
    // not checked. The rows above the cursor came before it, so they are
    // checked first (a `clear` may wipe them before the next pass).
    noteCommand(command: string): void {
        this.scan();
        this.tracker.startCommand(command);
    }

    // The colour scheme changed: the highlights are drawn again in its colours
    // (xterm bakes a decoration's colours in when it is registered).
    recolor(): void {
        for (const highlight of this.highlights) {
            highlight.button?.remove();
            highlight.button = undefined;
            highlight.decoration?.dispose();
            highlight.decoration = undefined;
            this.decorate(highlight);
        }
    }

    clear(): void {
        for (const highlight of this.highlights) this.disposeHighlight(highlight);
        this.highlights = [];
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.eraseHandler.dispose();
        this.clear();
        this.scannedTo?.dispose();
    }

    private scan(): void {
        if (this.disposed) return;
        const buffer = this.term.buffer.active;
        if (buffer.type !== 'normal') return;
        const cursorRow = buffer.baseY + buffer.cursorY;
        let resume = this.scannedTo && !this.scannedTo.isDisposed && this.scannedTo.line >= 0 ? this.scannedTo.line : 0;
        if (this.erased || resume > cursorRow) {
            // The screen was erased or redrawn above the cursor: the markers
            // of its rows no longer match what they show. It is read again.
            this.erased = false;
            resume = buffer.baseY;
            for (const highlight of [...this.highlights]) {
                if (highlight.marker.line >= resume) this.disposeHighlight(highlight);
            }
        }
        const from = Math.max(resume, cursorRow - MAX_ROWS_PER_SCAN);

        // The cursor row is still being written; it is checked next time.
        for (let row = from; row < cursorRow; row++) {
            const line = buffer.getLine(row);
            if (!line || line.isWrapped) continue;
            let text = line.translateToString(true);
            for (let next = row + 1; next < cursorRow && buffer.getLine(next)?.isWrapped; next++) {
                text += buffer.getLine(next)?.translateToString(true) ?? '';
            }
            if (this.tracker.accepts(text) && classifyTerminalLine(text) === 'error') this.mark(row - cursorRow, text);
        }
        this.scannedTo?.dispose();
        this.scannedTo = this.term.registerMarker(0);
    }

    private mark(offset: number, text: string): void {
        const marker = this.term.registerMarker(offset);
        if (!marker) return;
        const highlight: Highlight = { marker, text };
        if (!this.decorate(highlight)) {
            marker.dispose();
            return;
        }
        this.highlights.push(highlight);
        marker.onDispose(() => {
            highlight.decoration?.dispose();
            this.highlights = this.highlights.filter((item) => item !== highlight);
        });

        while (this.highlights.length > MAX_HIGHLIGHTS) {
            const oldest = this.highlights.shift();
            if (oldest) this.disposeHighlight(oldest);
        }
    }

    // The row's background, ruler mark and "!" button, in the current colours.
    private decorate(highlight: Highlight): boolean {
        const colors = this.options.colors?.() ?? DEFAULT_COLORS;
        const decoration = this.term.registerDecoration({
            marker: highlight.marker,
            anchor: 'left',
            x: 0,
            width: Math.max(this.term.cols, 1),
            height: 1,
            backgroundColor: colors.background,
            foregroundColor: colors.foreground,
            layer: 'bottom',
            overviewRulerOptions: { color: colors.ruler, position: 'right' }
        });
        if (!decoration) return false;
        highlight.decoration = decoration;

        decoration.onRender((element) => {
            element.style.boxShadow = `inset 3px 0 0 ${colors.edge}`;
            // xterm places the element itself (position: absolute, at the
            // marker's row); the button is positioned inside it.
            element.style.pointerEvents = 'auto';
            if (highlight.button) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = '!';
            button.title = this.options.label();
            button.setAttribute('aria-label', this.options.label());
            Object.assign(button.style, BUTTON_STYLE);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.options.onFix(highlight.text);
            });
            element.appendChild(button);
            highlight.button = button;
        });
        return true;
    }

    private disposeHighlight(highlight: Highlight): void {
        highlight.button?.remove();
        highlight.decoration?.dispose();
        highlight.marker.dispose();
    }
}
