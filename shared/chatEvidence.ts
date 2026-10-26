// Validation of what a diagnosis carries (shared/chat.ts): the attachment a
// client names and the evidence it sends back. Structure only: the backend
// checks names against the server's platform before it builds a command.
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

import {
    CHAT_EVIDENCE_SECTION_IDS,
    MAX_EVIDENCE_SECTION_CHARS,
    MAX_EVIDENCE_SECTIONS,
    MAX_LOG_EXCERPT_CHARS,
    type ChatAttachment,
    type ChatEvidence,
    type ChatEvidenceAccess,
    type ChatEvidenceSection,
    type ChatEvidenceSectionId
} from "./chat";
import { isValidContainerRef, type LogSource } from "./ops";
import { normalizePosixPath, normalizeWindowsPath } from "./disk";
import { isValidK8sContainer, isValidK8sContext, isValidK8sName, isValidK8sNamespace } from "./k8s";

const MAX_NAME_CHARS = 256;
const MAX_PATH_CHARS = 1024;
const MAX_TITLE_CHARS = 200;
const MAX_SOURCE_CHARS = 600;
const MAX_SIGNATURE_CHARS = 200;
export const MAX_USER_CHARS = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

// eslint-disable-next-line no-control-regex -- control characters are what it rejects
const CONTROL = /[\0-\x1f\x7f]/;

function cleanName(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text && text.length <= max && !CONTROL.test(text) ? text : null;
}

function parseLogSource(value: unknown): LogSource | null {
    if (!isRecord(value)) return null;
    switch (value.kind) {
        case "journal": {
            if (value.unit === undefined || value.unit === null || value.unit === "") return { kind: "journal" };
            const unit = cleanName(value.unit, MAX_NAME_CHARS);
            return unit ? { kind: "journal", unit } : null;
        }
        case "file": {
            const path = cleanName(value.path, MAX_PATH_CHARS);
            return path ? { kind: "file", path } : null;
        }
        case "container": {
            const container = cleanName(value.container, MAX_NAME_CHARS);
            return container && isValidContainerRef(container) ? { kind: "container", container } : null;
        }
        default:
            return null;
    }
}

// The selected lines keep their end when they are too long: the latest lines
// tend to hold the failure.
export function clipExcerpt(text: string): string {
    const normalized = text.replace(/\r\n?/g, "\n");
    if (normalized.length <= MAX_LOG_EXCERPT_CHARS) return normalized;
    const tail = normalized.slice(-MAX_LOG_EXCERPT_CHARS);
    const newline = tail.indexOf("\n");
    return newline >= 0 && newline < 200 ? tail.slice(newline + 1) : tail;
}

// The fingerprint of selected log lines (ChatAttachment "logs" `selection`).
const SELECTION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// Logs attachments about lines the user selected (sent as `excerpt`, or
// named by `selection` in evidence).
export function isLogSelection(attachment: ChatAttachment): boolean {
    return attachment.kind === "logs" && Boolean(attachment.excerpt || attachment.selection);
}

// A well-formed attachment with only its known fields, or null.
export function parseChatAttachment(value: unknown): ChatAttachment | null {
    if (!isRecord(value)) return null;
    switch (value.kind) {
        case "service": {
            const name = cleanName(value.name, MAX_NAME_CHARS);
            return name ? { kind: "service", name } : null;
        }
        case "container": {
            const container = cleanName(value.container, MAX_NAME_CHARS);
            if (!container || !isValidContainerRef(container)) return null;
            const engine = value.engine === "docker" || value.engine === "podman" ? value.engine : undefined;
            return engine ? { kind: "container", container, engine } : { kind: "container", container };
        }
        case "logs": {
            const source = parseLogSource(value.source);
            if (!source) return null;
            if (value.excerpt !== undefined && value.excerpt !== null) {
                if (typeof value.excerpt !== "string") return null;
                const excerpt = clipExcerpt(value.excerpt);
                if (excerpt.trim()) return { kind: "logs", source, excerpt };
            }
            if (value.selection === undefined || value.selection === null) return { kind: "logs", source };
            if (typeof value.selection !== "string" || !SELECTION_PATTERN.test(value.selection)) return null;
            return { kind: "logs", source, selection: value.selection };
        }
        case "status":
            return { kind: "status" };
        case "triage":
            return { kind: "triage" };
        // W8-T4: a mount point or a drive, as an absolute path.
        case "disk": {
            const mount = typeof value.mount === "string" ? normalizePosixPath(value.mount) ?? normalizeWindowsPath(value.mount) : null;
            return mount ? { kind: "disk", mount } : null;
        }
        // W8-T2 Kubernetes
        case "pod": {
            const { context, namespace, pod, container } = value;
            if (typeof context !== "string" || !isValidK8sContext(context)) return null;
            if (typeof namespace !== "string" || !isValidK8sNamespace(namespace)) return null;
            if (typeof pod !== "string" || !isValidK8sName(pod)) return null;
            if (container === undefined || container === null || container === "") return { kind: "pod", context, namespace, pod };
            return typeof container === "string" && isValidK8sContainer(container) ? { kind: "pod", context, namespace, pod, container } : null;
        }
        default:
            return null;
    }
}

// The same string for the same attachment (whatever the key order).
export function attachmentKey(attachment: ChatAttachment): string {
    switch (attachment.kind) {
        case "service":
            return JSON.stringify(["service", attachment.name]);
        case "container":
            return JSON.stringify(["container", attachment.container]);
        case "logs": {
            const { source } = attachment;
            const target = source.kind === "journal" ? source.unit ?? "" : source.kind === "file" ? source.path : source.container;
            return JSON.stringify(["logs", source.kind, target, attachment.excerpt ?? null, attachment.selection ?? null]);
        }
        case "status":
        case "triage":
            return JSON.stringify([attachment.kind]);
        // W8-T4
        case "disk":
            return JSON.stringify(["disk", attachment.mount]);
        // W8-T2 Kubernetes
        case "pod":
            return JSON.stringify(["pod", attachment.context, attachment.namespace, attachment.pod, attachment.container ?? null]);
    }
}

const SECTION_IDS = new Set<string>(CHAT_EVIDENCE_SECTION_IDS);

function parseSection(value: unknown): ChatEvidenceSection | null {
    if (!isRecord(value)) return null;
    const { id, title, source, text } = value;
    if (typeof id !== "string" || !SECTION_IDS.has(id)) return null;
    if (typeof title !== "string" || title.length > MAX_TITLE_CHARS) return null;
    if (typeof text !== "string" || text.length > MAX_EVIDENCE_SECTION_CHARS) return null;
    if (source !== undefined && (typeof source !== "string" || source.length > MAX_SOURCE_CHARS)) return null;
    const section: ChatEvidenceSection = { id: id as ChatEvidenceSectionId, title, text };
    if (typeof source === "string") section.source = source;
    if (value.truncated === true) section.truncated = true;
    if (value.failed === true) section.failed = true;
    if (typeof value.readAt === "number" && Number.isFinite(value.readAt) && value.readAt > 0) section.readAt = value.readAt;
    return section;
}

export function parseEvidenceSections(value: unknown): ChatEvidenceSection[] | null {
    if (!Array.isArray(value) || value.length > MAX_EVIDENCE_SECTIONS) return null;
    const sections: ChatEvidenceSection[] = [];
    for (const raw of value as unknown[]) {
        const section = parseSection(raw);
        if (!section) return null;
        sections.push(section);
    }
    return sections;
}

// Evidence as the backend produced it (only its known fields), or null when
// anything is malformed or over the limits. Its attachment never carries
// selected lines as text (see ChatAttachment "logs"): an `excerpt` is dropped.
export function parseChatEvidence(value: unknown): ChatEvidence | null {
    if (!isRecord(value)) return null;
    const { serverId, collectedAt, signature } = value;
    if (typeof serverId !== "number" || !Number.isSafeInteger(serverId) || serverId <= 0) return null;
    if (typeof collectedAt !== "number" || !Number.isFinite(collectedAt) || collectedAt <= 0) return null;
    if (typeof signature !== "string" || !signature || signature.length > MAX_SIGNATURE_CHARS) return null;
    const parsed = parseChatAttachment(value.attachment);
    const sections = parseEvidenceSections(value.sections);
    if (!parsed || !sections) return null;
    const attachment: ChatAttachment = parsed.kind === "logs" && parsed.excerpt !== undefined ? { kind: "logs", source: parsed.source } : parsed;
    if (value.access === undefined) return { serverId, attachment, collectedAt, sections, signature };
    const access = parseAccess(value.access);
    return access ? { serverId, attachment, collectedAt, sections, access, signature } : null;
}

function parseAccess(value: unknown): ChatEvidenceAccess | null {
    if (!isRecord(value)) return null;
    const { platform, admin, sudo } = value;
    const user = cleanName(value.user, MAX_USER_CHARS);
    if ((platform !== "linux" && platform !== "windows") || !user) return null;
    if ((admin !== null && typeof admin !== "boolean") || typeof sudo !== "boolean") return null;
    return { platform, user, admin, sudo };
}

// What the evidence of a diagnosis would be collected from again (it
// expired): its attachment, or for selected lines, the lines as they were
// sent (the evidence keeps only their redacted text).
export function recollectAttachment(evidence: Pick<ChatEvidence, "attachment" | "sections">): ChatAttachment {
    const { attachment } = evidence;
    if (attachment.kind !== "logs" || !attachment.selection) return attachment;
    const excerpt = evidence.sections.find((section) => section.id === "excerpt")?.text;
    return excerpt ? { kind: "logs", source: attachment.source, excerpt: clipExcerpt(excerpt) } : { kind: "logs", source: attachment.source };
}

// Characters of text the evidence holds.
export function evidenceChars(evidence: Pick<ChatEvidence, "sections">): number {
    return evidence.sections.reduce((sum, section) => sum + section.text.length, 0);
}
