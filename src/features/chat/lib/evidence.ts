import {
    CHAT_ERROR_CODES,
    CHAT_EVIDENCE_SECTION_IDS,
    EVIDENCE_MAX_AGE_MS,
    type ChatAttachment,
    type ChatEvidence,
    type ChatEvidenceResponse,
    type ChatEvidenceSection
} from '@shared/chat';
import { isLogSelection, parseChatEvidence } from '@shared/chatEvidence';
import type { TranslateFn } from '@/i18n';
import { api, ApiError } from '@/lib/api';
import { describeCode } from '@/lib/remoteErrors';
import { attachmentName } from '@/components/AskAiButton';
import { describeK8sError } from '@/features/k8s/errors';

// The evidence of a diagnosis as the chat handles it: collected by the
// backend (POST /api/chat/evidence), shown to the user as it is, and sent
// back unchanged with the question.

export class EvidenceFormatError extends Error {
    constructor() {
        super('The backend returned malformed evidence.');
        this.name = 'EvidenceFormatError';
    }
}

export async function fetchEvidence(serverId: number, attachment: ChatAttachment, signal?: AbortSignal): Promise<ChatEvidence> {
    const data = await api.post<ChatEvidenceResponse>('/api/chat/evidence', { serverId, attachment }, { signal });
    const evidence = parseChatEvidence(data?.evidence);
    if (!evidence) throw new EvidenceFormatError();
    return evidence;
}

// Collected long enough ago that the backend would refuse it.
export function isEvidenceStale(evidence: ChatEvidence, now = Date.now()): boolean {
    return now - evidence.collectedAt > EVIDENCE_MAX_AGE_MS - 60_000;
}

const encoder = new TextEncoder();

// UTF-8 bytes of the text that goes to the model.
export function evidenceBytes(evidence: Pick<ChatEvidence, 'sections'>): number {
    return evidence.sections.reduce((sum, section) => sum + sectionBytes(section), 0);
}

export function sectionBytes(section: ChatEvidenceSection): number {
    return encoder.encode(section.text).length;
}

// "Service nginx.service", "Triage pack"... in the UI language.
export function attachmentLabel(t: TranslateFn, attachment: ChatAttachment): string {
    const name = attachmentName(attachment);
    switch (attachment.kind) {
        case 'logs':
            if (isLogSelection(attachment)) return name ? t('chat.evidence.kinds.selection', { name }) : t('chat.evidence.kinds.journalSelection');
            return name ? t('chat.evidence.kinds.logs', { name }) : t('chat.evidence.kinds.journal');
        case 'service':
        case 'container':
            return t(`chat.evidence.kinds.${attachment.kind}`, { name });
        case 'status':
        case 'triage':
            return t(`chat.evidence.kinds.${attachment.kind}`);
        // W8-T4: the disk toolkit words its attachment and parts in its own area.
        case 'disk':
            return t('disk.ai.attachment', { mount: name });
        // W8-T2 Kubernetes (the k8s area words it)
        case 'pod':
            return t('k8s.ai.attachment', { name, namespace: attachment.namespace });
    }
}

// W8-T2: the parts of a pod's evidence are worded by the k8s area.
const K8S_SECTIONS = new Set<string>(['pod', 'pod-events', 'pod-logs', 'pod-previous-logs']);

export function sectionTitle(t: TranslateFn, section: Pick<ChatEvidenceSection, 'id'>): string {
    if (section.id.startsWith('disk-')) return t(`disk.ai.sections.${section.id}`);
    if (K8S_SECTIONS.has(section.id)) return t(`k8s.ai.sections.${section.id}`);
    return t(`chat.evidence.sections.${section.id}`);
}

export type EvidenceFailure = { title: string; details: string[] };

const SECTION_IDS = new Set<string>(CHAT_EVIDENCE_SECTION_IDS);

// One line per part the backend could not read (EVIDENCE_UNAVAILABLE
// details.sections): its name and why, the headline translated, the
// server's own message kept as it is.
function unreadableParts(t: TranslateFn, details: Record<string, unknown> | null): string[] {
    const parts = Array.isArray(details?.sections) ? (details.sections as unknown[]) : [];
    return parts.slice(0, 12).flatMap((part) => {
        const { id, code, reason } = (part && typeof part === 'object' ? part : {}) as { id?: unknown; code?: unknown; reason?: unknown };
        if (typeof id !== 'string' || !SECTION_IDS.has(id) || typeof reason !== 'string') return [];
        const described = describeCode(typeof code === 'string' ? code : null, reason, t);
        const why = described.detail ? `${described.title} ${described.detail}` : described.title;
        return [`${sectionTitle(t, { id: id as ChatEvidenceSection['id'] })}: ${why}`];
    });
}

// Why the evidence could not be collected, in the UI language.
export function describeEvidenceFailure(t: TranslateFn, error: unknown): EvidenceFailure {
    if (error instanceof EvidenceFormatError) return { title: t('chat.evidence.errors.malformed'), details: [] };
    if (error instanceof ApiError && error.code === 'EVIDENCE_UNAVAILABLE') {
        return { title: t('chat.evidence.errors.unavailable'), details: unreadableParts(t, error.details) };
    }
    if (error instanceof ApiError && error.code === CHAT_ERROR_CODES.invalidRequest) return { title: t('chat.evidence.errors.invalid'), details: [] };
    // W8-T2: kubectl's failures (a pod's evidence: an expired sign-in...) in
    // the Kubernetes tab's words; the rest as before.
    const described = describeK8sError(error, t);
    return { title: described.title, details: described.detail ? [described.detail] : [] };
}
