// "Ask AI" next to something on a server (a service, a container, logs, the
// status): opens the server's chat with that thing attached. The request
// carries a reference to it, not its data (see ChatAttachment): the chat has
// the backend collect the evidence, shows the user exactly what will be sent
// and diagnoses it when the user sends the question.
import { useId, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import type { ChatAttachment } from '@shared/chat';
import { clipExcerpt, isLogSelection } from '@shared/chatEvidence';
import { Button, IconButton } from '@/components/ui';
import { useT, type TranslateFn } from '@/i18n';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/appStore';

interface AskAiButtonProps {
    serverId: number;
    attachment: ChatAttachment;
    // The question the chat starts from; by default one about the attachment.
    prompt?: string;
    // 'icon' for table rows and toolbars, 'button' for a labelled button.
    variant?: 'icon' | 'button';
    // Accessible name (and the text of the 'button' variant); by default
    // "Ask AI about <name>" ("Ask AI" for the server as a whole).
    label?: string;
    // Unavailable, and why (the button stays focusable to tell).
    disabledReason?: string;
    size?: 'sm' | 'md';
    className?: string;
    // More about what goes with the question: the tooltip, and the button's
    // accessible description.
    hint?: string;
    // Logs: the element showing the log lines. Lines the user selected in it
    // go with the request instead of the source's latest lines.
    excerptFrom?: () => HTMLElement | null;
    // W8-T4: called once the chat has the request (a dialog closes, so the
    // chat behind it shows).
    onAsked?: () => void;
}

// What the attachment is called on screen ("" for the server as a whole).
export function attachmentName(attachment: ChatAttachment): string {
    switch (attachment.kind) {
        case 'service':
            return attachment.name;
        case 'container':
            return attachment.container;
        case 'logs': {
            const { source } = attachment;
            if (source.kind === 'file') return source.path;
            if (source.kind === 'container') return source.container;
            return source.unit ?? '';
        }
        case 'status':
        case 'triage':
            return '';
        // W8-T4 disk toolkit
        case 'disk':
            return attachment.mount;
        // W8-T2 Kubernetes
        case 'pod':
            return attachment.pod;
    }
}

export function defaultAskAiPrompt(t: TranslateFn, attachment: ChatAttachment): string {
    if (isLogSelection(attachment)) return t('common.askAi.prompts.selection');
    // W8-T4: worded in the disk toolkit's own area.
    if (attachment.kind === 'disk') return t('disk.ai.prompt', { mount: attachment.mount });
    // W8-T2 Kubernetes (the k8s area words it)
    if (attachment.kind === 'pod') return t('k8s.ai.prompt', { name: attachment.pod, namespace: attachment.namespace });
    const name = attachmentName(attachment);
    if (attachment.kind === 'logs' && !name) return t('common.askAi.prompts.journal');
    return t(`common.askAi.prompts.${attachment.kind}`, { name });
}

// Marks an element that shows one line of text, like a row of a virtualized
// log view. Browsers join absolutely positioned rows without a line break in
// Selection.toString(), so selectedTextWithin reads marked rows one by one.
export const EXCERPT_LINE_ATTRIBUTE = 'data-excerpt-line';

// The text selected inside `element`, if the selection lies within it: one
// line per marked row it covers (only the selected part of the first and the
// last), or the selection's own text where there are no marked rows.
export function selectedTextWithin(element: HTMLElement | null): string {
    if (!element || typeof window === 'undefined') return '';
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    if (!element.contains(range.commonAncestorContainer)) return '';
    const rows = [...element.querySelectorAll(`[${EXCERPT_LINE_ATTRIBUTE}]`)].filter((row) => range.intersectsNode(row));
    if (!rows.length) return selection.toString();
    const lines = rows.map((row) => {
        const part = document.createRange();
        part.selectNodeContents(row);
        if (row.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
        if (row.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
        return part.toString();
    });
    // A selection that ends at the very start of a row (a triple click) does not take it.
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    while (lines.length && lines[0] === '') lines.shift();
    return lines.join('\n');
}

// Opens the chat of `serverId` on `attachment` (from a button, the command
// palette, a keyboard shortcut...).
export function askAi(t: TranslateFn, serverId: number, attachment: ChatAttachment, prompt?: string): void {
    useAppStore.getState().requestChat({ serverId, kind: 'context', attachment, prompt: prompt ?? defaultAskAiPrompt(t, attachment) });
}

export function AskAiButton({
    serverId, attachment, prompt, variant = 'icon', label, disabledReason, size = 'sm', className, hint, excerptFrom, onAsked
}: AskAiButtonProps) {
    const t = useT();
    const reasonId = useId();
    const name = attachmentName(attachment);
    const accessibleName = label ?? (name ? t('common.askAi.about', { name }) : t('common.askAi.label'));
    const selectable = attachment.kind === 'logs' && excerptFrom !== undefined;
    const description = hint ?? (selectable ? t('common.askAi.selectionHint') : undefined);
    // The tooltip, which is also the accessible description (the name comes
    // from aria-label or the text).
    const tooltip = description ? `${accessibleName}. ${description}` : undefined;
    const unavailable = disabledReason !== undefined;
    // Read on pointer down, before the click can move the selection.
    const pressedExcerpt = useRef<string | null>(null);

    const ask = () => {
        const selected = selectable ? (pressedExcerpt.current ?? selectedTextWithin(excerptFrom())) : '';
        pressedExcerpt.current = null;
        const excerpt = selected.trim() ? clipExcerpt(selected) : '';
        const target: ChatAttachment = attachment.kind === 'logs' && excerpt ? { kind: 'logs', source: attachment.source, excerpt } : attachment;
        askAi(t, serverId, target, excerpt ? undefined : prompt);
        onAsked?.();
    };
    const capture = selectable ? () => { pressedExcerpt.current = selectedTextWithin(excerptFrom()); } : undefined;

    if (variant === 'icon') {
        return (
            <IconButton size={size} variant="ghost" label={accessibleName} tooltip={tooltip} disabledReason={disabledReason} onPointerDown={capture} onClick={ask} className={className}>
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
        );
    }
    return (
        <Button
            type="button"
            size={size}
            variant="subtle"
            aria-label={label ? undefined : accessibleName}
            aria-disabled={unavailable || undefined}
            aria-describedby={unavailable ? reasonId : undefined}
            title={disabledReason ?? tooltip}
            onPointerDown={unavailable ? undefined : capture}
            onClick={unavailable ? undefined : ask}
            className={cn(unavailable && 'cursor-not-allowed opacity-50', className)}
        >
            <Sparkles className="h-3.5 w-3.5 text-brand-300" aria-hidden="true" />
            {label ?? t('common.askAi.label')}
            {unavailable && <span id={reasonId} hidden>{disabledReason}</span>}
        </Button>
    );
}
