import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { Book, Bot, ClipboardPaste, Copy, Eraser, History, Search, TextSelect } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { useT } from '@/i18n';

export type TerminalPanelKind = 'search' | 'history' | 'hints';

export type ToolbarShortcuts = { copy: string; paste: string; search: string };

export interface SessionToolbarHandle {
    focus: () => void;
}

type Props = {
    panel: TerminalPanelKind | null;
    hasHints: boolean;
    shortcuts: ToolbarShortcuts;
    onPaste: () => void;
    onCopySelection: () => void;
    onCopyOutput: () => void;
    onAskAi: () => void;
    onClear: () => void;
    onTogglePanel: (panel: TerminalPanelKind) => void;
    // Escape: back to the terminal the toolbar was reached from.
    onLeave: () => void;
};

// The tools of the focused terminal tab. A toolbar in the ARIA sense: arrow
// keys, Home and End move between the buttons; Alt+F10 in the terminal jumps
// here and Escape goes back.
export const SessionToolbar = forwardRef<SessionToolbarHandle, Props>(function SessionToolbar(props, ref) {
    const t = useT();
    const rootRef = useRef<HTMLDivElement>(null);
    const { panel, shortcuts } = props;

    const buttons = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    useImperativeHandle(ref, () => ({ focus: () => buttons()[0]?.focus() }), []);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            props.onLeave();
            return;
        }
        const list = buttons();
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        const target = event.key === 'ArrowRight' ? list[(index + 1) % list.length]
            : event.key === 'ArrowLeft' ? list[(index - 1 + list.length) % list.length]
            : event.key === 'Home' ? list[0]
            : event.key === 'End' ? list[list.length - 1]
            : undefined;
        if (!target) return;
        event.preventDefault();
        target.focus();
    };

    const label = (key: string, shortcut?: string) => (shortcut ? `${t(key)} (${shortcut})` : t(key));

    return (
        <div ref={rootRef} role="toolbar" aria-label={t('terminal.toolbar.label')} onKeyDown={onKeyDown} className="flex shrink-0 items-center gap-1">
            <IconButton size="sm" label={label('terminal.toolbar.paste', shortcuts.paste)} onClick={props.onPaste}>
                <ClipboardPaste className="h-4 w-4" />
            </IconButton>
            <IconButton size="sm" label={label('terminal.toolbar.copySelection', shortcuts.copy)} onClick={props.onCopySelection}>
                <Copy className="h-4 w-4" />
            </IconButton>
            <IconButton size="sm" label={label('terminal.toolbar.copyOutput')} onClick={props.onCopyOutput}>
                <TextSelect className="h-4 w-4" />
            </IconButton>
            <IconButton size="sm" label={label('terminal.toolbar.askAi')} onClick={props.onAskAi}>
                <Bot className="h-4 w-4" />
            </IconButton>
            <IconButton size="sm" label={label('terminal.toolbar.clear')} onClick={props.onClear}>
                <Eraser className="h-4 w-4" />
            </IconButton>
            <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />
            <IconButton
                size="sm"
                active={panel === 'search'}
                aria-pressed={panel === 'search'}
                label={label('terminal.toolbar.search', shortcuts.search)}
                onClick={() => props.onTogglePanel('search')}
            >
                <Search className="h-4 w-4" />
            </IconButton>
            <IconButton
                size="sm"
                active={panel === 'history'}
                aria-pressed={panel === 'history'}
                label={label('terminal.toolbar.history')}
                onClick={() => props.onTogglePanel('history')}
            >
                <History className="h-4 w-4" />
            </IconButton>
            {props.hasHints && (
                <IconButton
                    size="sm"
                    active={panel === 'hints'}
                    aria-pressed={panel === 'hints'}
                    label={label('terminal.toolbar.hints')}
                    onClick={() => props.onTogglePanel('hints')}
                >
                    <Book className="h-4 w-4" />
                </IconButton>
            )}
        </div>
    );
});
