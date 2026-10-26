import { useId, useState } from 'react';
import { Activity, AlertTriangle, Box, ChevronDown, ChevronRight, Cog, HardDrive, Paperclip, RefreshCw, ScrollText, ShipWheel, Stethoscope, UserRound, X, type LucideIcon } from 'lucide-react';
import type { ChatAttachmentKind, ChatEvidence, ChatEvidenceAccess } from '@shared/chat';
import { Badge, Spinner } from '@/components/ui';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { PendingAttachment } from '../hooks/useAttachment';
import { attachmentLabel, describeEvidenceFailure, evidenceBytes, sectionBytes, sectionTitle } from '../lib/evidence';

// The evidence of a diagnosis on screen, exactly as the model gets it: in
// the message box while it is attached (with what is still being collected,
// or why it could not be), and under the question once it was sent. Every
// part opens to its full text; nothing is rendered as Markdown.

const KIND_ICONS: Record<ChatAttachmentKind, LucideIcon> = {
    service: Cog,
    container: Box,
    logs: ScrollText,
    status: Activity,
    triage: Stethoscope,
    // W8-T4
    disk: HardDrive,
    // W8-T2 Kubernetes
    pod: ShipWheel
};

export function EvidenceSections({ evidence, className }: { evidence: ChatEvidence; className?: string }) {
    const t = useT();
    const language = useLanguage();
    return (
        <ul className={cn('space-y-1.5', className)} aria-label={t('chat.evidence.partsLabel')}>
            {evidence.sections.map((section, index) => (
                <li key={`${section.id}-${index}`}>
                    <details className="group/section rounded-lg border border-white/[0.07] bg-ink-950/50">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-white/[0.03] focus-ring [&::-webkit-details-marker]:hidden">
                            <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-zinc-500 transition-transform group-open/section:rotate-90" />
                            <span className="min-w-0 flex-1 truncate font-medium text-zinc-200" title={section.title}>{sectionTitle(t, section)}</span>
                            {section.failed && <Badge tone="warning">{t('chat.evidence.failed')}</Badge>}
                            {section.id === 'connection' && <Badge tone="warning">{t('chat.evidence.unreachable')}</Badge>}
                            {section.readAt !== undefined && <Badge>{t('chat.evidence.readAt', { time: formatDateTime(section.readAt, language) })}</Badge>}
                            {section.truncated && !section.failed && <Badge>{t('chat.evidence.shortened')}</Badge>}
                            <span className="shrink-0 tabular-nums text-zinc-500">{formatBytes(sectionBytes(section), language, { fixed: true })}</span>
                        </summary>
                        <div className="border-t border-white/[0.06]">
                            {section.source && (
                                <p className="truncate px-2.5 pt-1.5 font-mono text-[10.5px] text-zinc-500" title={section.source}>
                                    <span className="sr-only">{t('chat.evidence.source')}: </span>{section.source}
                                </p>
                            )}
                            <pre className="max-h-56 overflow-auto whitespace-pre-wrap px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-300 scrollbar-thin [overflow-wrap:anywhere]">
                                {section.text}
                            </pre>
                        </div>
                    </details>
                </li>
            ))}
        </ul>
    );
}

function rightsText(t: TranslateFn, access: ChatEvidenceAccess): string {
    if (access.platform === 'windows') {
        return t(access.admin === true ? 'chat.evidence.access.admin' : access.admin === false ? 'chat.evidence.access.notAdmin' : 'chat.evidence.access.unknown');
    }
    if (access.admin === true) return t('chat.evidence.access.root');
    if (access.sudo) return t('chat.evidence.access.sudo');
    return t(access.admin === false ? 'chat.evidence.access.noSudo' : 'chat.evidence.access.unknown');
}

// Who the commands of a fix would run as (the model is told too).
function AccessNote({ access }: { access: ChatEvidenceAccess }) {
    const t = useT();
    return (
        <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-zinc-400">
            <UserRound aria-hidden="true" className="h-3 w-3 shrink-0 text-zinc-500" />
            <span className="min-w-0">{t('chat.evidence.access.label', { user: access.user, rights: rightsText(t, access) })}</span>
        </p>
    );
}

function summary(t: TranslateFn, language: string, evidence: ChatEvidence): string {
    const parts = evidence.sections.length;
    return t(parts === 1 ? 'chat.evidence.summaryOne' : 'chat.evidence.summary', {
        count: parts,
        size: formatBytes(evidenceBytes(evidence), language, { fixed: true })
    });
}

type AttachmentCardProps = {
    pending: PendingAttachment;
    serverName: string;
    onRemove: () => void;
    onRetry: () => void;
};

// The attachment in the message box.
export function AttachmentCard({ pending, serverName, onRemove, onRetry }: AttachmentCardProps) {
    const t = useT();
    const language = useLanguage();
    const [open, setOpen] = useState(false);
    const listId = useId();
    const Icon = KIND_ICONS[pending.attachment.kind];
    const label = attachmentLabel(t, pending.attachment);
    const failure = pending.status === 'error' ? describeEvidenceFailure(t, pending.error) : null;

    return (
        <section
            aria-label={t('chat.evidence.attachmentLabel', { name: label })}
            aria-busy={pending.status === 'collecting' || undefined}
            className={cn(
                'mb-2 rounded-xl border px-2.5 py-2',
                pending.status === 'error' ? 'border-rose-500/30 bg-rose-500/[0.06]' : 'border-brand-500/25 bg-brand-500/[0.06]'
            )}
        >
            <div className="flex items-start gap-2">
                <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md', pending.status === 'error' ? 'bg-rose-500/15 text-rose-300' : 'bg-brand-500/15 text-brand-300')}>
                    {pending.status === 'error' ? <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" /> : <Icon aria-hidden="true" className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-zinc-100" title={label}>{label}</p>
                    {/* The chat's live region announces the changes (collecting, collected, failed). */}
                    <p className="text-[11px] leading-snug text-zinc-400">
                        {pending.status === 'collecting' && (
                            <span className="inline-flex items-center gap-1.5">
                                <Spinner className="h-3 w-3 text-brand-300" />
                                {t('chat.evidence.collecting', { name: serverName })}
                            </span>
                        )}
                        {pending.status === 'ready' && `${summary(t, language, pending.evidence)} · ${t('chat.evidence.readyHint')}`}
                        {failure && <span className="text-rose-200">{t('chat.evidence.collectFailed')} {failure.title}</span>}
                    </p>
                    {failure && failure.details.length > 0 && (
                        // The server's own messages, as they came.
                        <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-rose-200/75">
                            {failure.details.map((detail, index) => (
                                <li key={index} className="max-h-16 overflow-hidden break-words [overflow-wrap:anywhere]">{detail}</li>
                            ))}
                        </ul>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    {pending.status === 'ready' && (
                        <button
                            type="button"
                            onClick={() => setOpen((value) => !value)}
                            aria-expanded={open}
                            aria-controls={listId}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-brand-200 transition hover:bg-brand-500/15 focus-ring"
                        >
                            {open ? t('chat.evidence.hide') : t('chat.evidence.review')}
                            <ChevronDown aria-hidden="true" className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
                        </button>
                    )}
                    {pending.status === 'error' && (
                        <button type="button" onClick={onRetry} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-rose-100 transition hover:bg-rose-500/20 focus-ring">
                            <RefreshCw aria-hidden="true" className="h-3 w-3" /> {t('chat.evidence.retry')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onRemove}
                        aria-label={t('chat.evidence.remove')}
                        title={t('chat.evidence.remove')}
                        className="rounded-md p-1 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 focus-ring"
                    >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            {pending.status === 'ready' && open && (
                <div id={listId} className="mt-2 max-h-[min(40vh,20rem)] overflow-y-auto pr-0.5 scrollbar-thin">
                    {pending.evidence.access && <AccessNote access={pending.evidence.access} />}
                    <EvidenceSections evidence={pending.evidence} />
                </div>
            )}
        </section>
    );
}

// What was sent with a question, under its bubble.
export function SentEvidence({ evidence }: { evidence: ChatEvidence }) {
    const t = useT();
    const language = useLanguage();
    const label = attachmentLabel(t, evidence.attachment);
    return (
        <details className="group/evidence w-full rounded-xl border border-brand-500/20 bg-brand-500/[0.05]">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-[12px] text-zinc-300 hover:bg-brand-500/[0.06] focus-ring [&::-webkit-details-marker]:hidden">
                <Paperclip aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-brand-300" />
                <span className="min-w-0 flex-1 truncate">
                    <span className="sr-only">{t('chat.evidence.sentLabel')}: </span>
                    <span className="font-medium text-zinc-100">{label}</span>
                    <span className="text-zinc-400"> · {summary(t, language, evidence)}</span>
                </span>
                <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-zinc-500 transition-transform group-open/evidence:rotate-180" />
            </summary>
            <div className="border-t border-brand-500/15 p-2">
                <p className="mb-1.5 px-0.5 text-[11px] text-zinc-500">{t('chat.evidence.sentHint', { time: formatDateTime(evidence.collectedAt, language) })}</p>
                {evidence.access && <AccessNote access={evidence.access} />}
                <EvidenceSections evidence={evidence} />
            </div>
        </details>
    );
}
