import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { ClipboardPaste, Command, Fullscreen, Keyboard, Maximize2, Minimize, Minimize2, MousePointerClick, Power, Route } from 'lucide-react';
import { Badge, IconButton, Kbd, Menu, StatusDot } from '@/components/ui';
import { useT } from '@/i18n';
import { Trans } from '@/i18n/Trans';
import { cn } from '@/lib/cn';
import type { ClipboardState, DesktopSize } from './connection';
import { formatKeys, RELEASE_SHORTCUT, SPECIAL_KEYS } from './keys';

export interface RdpToolbarHandle {
    focus: () => void;
}

type Props = {
    desktop: DesktopSize;
    // A narrow panel: the hints shrink to their icons; a very narrow one
    // keeps only the icons (the size and the keyboard state as tooltips).
    compact: boolean;
    narrow: boolean;
    via: string | null;
    clipboard: ClipboardState;
    keyboardCaptured: boolean;
    fit: boolean;
    fullscreen: boolean;
    onCtrlAltDel: () => void;
    onKeys: (codes: readonly string[]) => void;
    onSendClipboard: () => void;
    onToggleFit: () => void;
    onToggleFullscreen: () => void;
    onDisconnect: () => void;
    // Escape: back to the remote desktop.
    onLeave: () => void;
};

// The controls of a live session. A toolbar in the ARIA sense: one Tab stop,
// arrow keys, Home and End move between the buttons, Escape returns to the
// remote desktop.
export const RdpToolbar = forwardRef<RdpToolbarHandle, Props>(function RdpToolbar(props, ref) {
    const t = useT();
    const rootRef = useRef<HTMLDivElement>(null);
    const buttons = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    useImperativeHandle(ref, () => ({ focus: () => buttons()[0]?.focus() }), []);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
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

    const keyItems = SPECIAL_KEYS.map((key) => ({
        id: key.id,
        label: t(key.labelKey),
        hint: formatKeys(t, key.hint),
        onSelect: () => props.onKeys(key.codes)
    }));

    const releaseShortcut = formatKeys(t, RELEASE_SHORTCUT);
    const size = t('rdp.session.size', { width: props.desktop.width, height: props.desktop.height });
    const keyboardHint = props.keyboardCaptured
        ? `${t('rdp.session.keyboardRemote')} · ${t('rdp.session.keyboardRelease', { shortcut: releaseShortcut })}`
        : t('rdp.session.keyboardLocal');

    return (
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-white/5 bg-ink-850/80 px-3 text-xs">
            <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                <StatusDot state="connected" />
                <span className="font-medium text-zinc-200" title={props.narrow ? size : undefined}>{t('rdp.session.connected')}</span>
                {!props.narrow && <span className="tabular-nums text-zinc-500">{size}</span>}
                {props.via && !props.compact && (
                    <Badge tone="neutral">
                        <Route className="mr-0.5 inline h-3 w-3" aria-hidden="true" />{t('rdp.via', { jump: props.via })}
                    </Badge>
                )}
            </div>
            <div className="flex min-w-0 flex-1 justify-center overflow-hidden">
                <span
                    role="status"
                    title={keyboardHint}
                    className={cn(
                        'inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5',
                        props.keyboardCaptured ? 'border-brand-500/30 bg-brand-500/10 text-brand-200' : 'border-transparent text-zinc-500'
                    )}
                >
                    {props.keyboardCaptured
                        ? <Keyboard className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        : <MousePointerClick className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                    {props.compact ? (
                        <>
                            <span className="sr-only">{keyboardHint}</span>
                            {props.keyboardCaptured && !props.narrow && <span aria-hidden="true"><Kbd className="border-brand-500/30 text-brand-100">{releaseShortcut}</Kbd></span>}
                        </>
                    ) : props.keyboardCaptured ? (
                        <span className="min-w-0 truncate">
                            {t('rdp.session.keyboardRemote')}{' · '}
                            <Trans k="rdp.session.keyboardRelease" values={{ shortcut: <Kbd className="border-brand-500/30 text-brand-100">{releaseShortcut}</Kbd> }} />
                        </span>
                    ) : (
                        <span className="min-w-0 truncate">{keyboardHint}</span>
                    )}
                </span>
            </div>
            <div ref={rootRef} role="toolbar" aria-label={t('rdp.session.toolbar')} onKeyDown={onKeyDown} className="flex shrink-0 items-center gap-1">
                <IconButton variant="ghost" label={t('rdp.session.ctrlAltDel')} onClick={props.onCtrlAltDel}>
                    <Keyboard className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <Menu
                    items={keyItems}
                    label={t('rdp.session.keys')}
                    triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-all duration-150 hover:bg-white/[0.06] hover:text-zinc-100 focus-ring"
                >
                    <Command className="h-4 w-4" aria-hidden="true" />
                </Menu>
                <IconButton
                    variant="ghost"
                    label={t('rdp.session.sendClipboard')}
                    disabledReason={props.clipboard === 'on' ? undefined : t(props.clipboard === 'off' ? 'rdp.session.clipboardOff' : 'rdp.session.clipboardUnavailable')}
                    onClick={props.onSendClipboard}
                >
                    <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
                <IconButton variant="ghost" active={props.fit} label={t(props.fit ? 'rdp.session.scaleActual' : 'rdp.session.scaleFit')} onClick={props.onToggleFit}>
                    {props.fit ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
                </IconButton>
                <IconButton variant="ghost" label={t(props.fullscreen ? 'rdp.session.exitFullscreen' : 'rdp.session.fullscreen')} onClick={props.onToggleFullscreen}>
                    {props.fullscreen ? <Minimize className="h-4 w-4" aria-hidden="true" /> : <Fullscreen className="h-4 w-4" aria-hidden="true" />}
                </IconButton>
                <IconButton variant="ghost" label={t('rdp.session.disconnect')} onClick={props.onDisconnect} className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200">
                    <Power className="h-4 w-4" aria-hidden="true" />
                </IconButton>
            </div>
        </div>
    );
});
