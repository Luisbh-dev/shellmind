import type { ChatAttachment, ChatEvidence, ChatEvidenceAccess } from "../../../shared/chat";
import { isLogSelection } from "../../../shared/chatEvidence";
import { redactSecrets } from "../redact";
import { clipMiddle, dataBlock } from "../untrusted";
import { describeLogSource } from "./logs";

// How a diagnosis reaches the model: one untrusted data block per part of
// the evidence (named by ShellMind, filled from the server), then the
// instruction, then the user's own question, if they wrote one.

const quote = (name: string) => name.replace(/["\r\n]/g, " ").slice(0, 120);

// What is being diagnosed, in the instruction's words.
export function describeTarget(attachment: ChatAttachment): string {
    switch (attachment.kind) {
        case "service": return `the service "${quote(attachment.name)}"`;
        case "container": return `the container "${quote(attachment.container)}"`;
        case "logs": return isLogSelection(attachment) ? `the log lines the user selected from ${quote(describeLogSource(attachment.source))}` : `the logs of ${quote(describeLogSource(attachment.source))}`;
        case "status": return "this server's status";
        case "triage": return "this server";
        // W8-T4
        case "disk": return `why the filesystem "${quote(attachment.mount)}" is full (or filling up)`;
        // W8-T2 Kubernetes
        case "pod": return `the Kubernetes pod "${quote(attachment.namespace)}/${quote(attachment.pod)}" (kubeconfig context "${quote(attachment.context)}")`;
    }
}

// W8-T4: what a disk diagnosis should point to, and what it must not suggest.
const DISK_RULE = "Name what takes the space, largest first, with its size from the evidence. Prefer the known cleanups listed in the evidence (journal vacuum, package caches, rotated logs, temporary files, container prunes), or releasing a deleted file still held open (restart its service or truncate it through /proc/<pid>/fd/<fd>), over deleting files. Never suggest rm -rf on a directory whose purpose you do not know, and say plainly when data (databases, backups, user files) has to be moved or archived rather than deleted.";

// W8-T2: where the commands of a pod's fix run, and how they name the pod.
function podInstruction(attachment: Extract<ChatAttachment, { kind: "pod" }>): string {
    const context = quote(attachment.context);
    const namespace = quote(attachment.namespace);
    return `The commands of a fix are kubectl commands, run where ShellMind runs kubectl for this server: always pass --context ${context} and -n ${namespace}. Prefer changing what owns the pod (its Deployment, StatefulSet, DaemonSet or Job) over the pod itself, which its controller replaces.`;
}

// The evidence as data blocks. `maxChars` caps the whole (a diagnosis of the
// past, in the history, gets a small share).
export function evidenceBlocks(evidence: Pick<ChatEvidence, "sections" | "collectedAt">, dataId: string, maxChars?: number): string[] {
    const perSection = maxChars ? Math.max(300, Math.floor(maxChars / Math.max(1, evidence.sections.length))) : undefined;
    const collected = new Date(evidence.collectedAt).toISOString().replace(/\.\d+Z$/, "Z");
    return evidence.sections.map((section) => {
        const heading = `${section.title}${section.source ? ` (${section.source})` : ""}, collected ${collected}${section.truncated ? ", shortened to fit" : ""}${section.failed ? ", could not be read" : ""}:`;
        // Redacted once more: evidence from the history comes from the client.
        const text = redactSecrets(section.text);
        const body = perSection ? clipMiddle(text, perSection).text : text;
        return dataBlock("evidence", `${heading}\n${body}`, dataId);
    });
}

const LANGUAGE = "Write the whole answer, headings included, in the language of the user message below (without one, in the language the user used earlier in the conversation).";

const LANGUAGE_NAMES: Record<string, string> = { en: "English", es: "Spanish" };

// What the conversation says about the language of the answer: whether the
// user wrote an earlier message, and the one below.
export type DiagnoseConversation = { earlierUserMessage?: boolean; userMessage?: boolean };

// The language of the answer. Without an earlier message of the user to go
// by, the UI language is named: left to "the language of the user message",
// a model drifts to that of the evidence (a Spanish answer to an English
// triage of a server whose logs are in Spanish).
function languageRule(language: string | undefined, conversation: DiagnoseConversation): string {
    const name = LANGUAGE_NAMES[language ?? ""];
    if (!name || conversation.earlierUserMessage) return LANGUAGE;
    const rule = `Write the whole answer, headings included, in ${name}, the language of the user's interface`;
    return conversation.userMessage ? `${rule} (if the user message below is written in another language, in that one).` : `${rule}.`;
}

// The sections are described by their role, and their headings are given
// in the UI's language: models keep a literal heading of another language
// (an English one in a Spanish answer, a Spanish one in an English answer).
const HEADINGS: Record<string, { diagnose: [string, string, string]; triage: [string, string] }> = {
    en: { diagnose: ["Cause", "Evidence", "Fix"], triage: ["Findings", "Next steps"] },
    es: { diagnose: ["Causa", "Evidencias", "Solución"], triage: ["Hallazgos", "Próximos pasos"] }
};

const headingList = (names: string[]) => names.map((name) => `"### ${name}"`).join(", ");

function diagnoseFormat(names: [string, string, string], language: string): string {
    return [
        `${language} Organize it under these three headings, always all three, in this order: ${headingList(names)} (translated, if you answer in another language).`,
        `1. ${names[0]}: the most likely cause in one or two sentences. When the evidence is not conclusive, rank the likely causes (most likely first) and say what would tell them apart.`,
        `2. ${names[1]}: the specific lines that show it, quoted briefly (inline code or a short text block), and what each means. Quote only what is in the evidence; never invent lines.`,
        `3. ${names[2]}: the safest fix; state its impact first, then give it as one runnable code block. When the cause is uncertain, give the read-only checks that confirm it instead. Prefer reversible changes to destructive ones.`,
        "If the evidence shows nothing wrong, say so plainly and suggest what to check next instead of a fix."
    ].join("\n");
}

function triageFormat(names: [string, string], language: string): string {
    return [
        `${language} Organize it under these two headings, in this order: ${headingList(names)} (translated, if you answer in another language).`,
        `1. ${names[0]}: only the real problems, most urgent first, as a list. For each one: its severity (critical or warning), what is wrong, and the evidence line that shows it, quoted briefly. Healthy checks are not findings: after the list, one short line names what looked fine. If nothing is wrong, say so in one line instead of a list.`,
        `2. ${names[1]}: for the most urgent problem, the safest fix or the read-only check that confirms it, as one runnable code block, with its impact stated first. Then one line for each other problem with what to do about it.`
    ].join("\n");
}

// Who the commands of a fix run as, and what follows for them.
export function accessInstruction(access: ChatEvidenceAccess): string {
    const user = `"${quote(access.user)}"`;
    const needsMore = "Prefer what this user can run. When a fix needs more rights, say so plainly before its block";
    if (access.platform === "windows") {
        if (access.admin === true) return `The commands of a fix run in the user's terminal as ${user}, an administrator.`;
        if (access.admin === false) return `The commands of a fix run in the user's terminal as ${user}, which is not an administrator: commands that need elevation fail in that session. ${needsMore}: an administrator has to run it.`;
        return `The commands of a fix run in the user's terminal as ${user}; whether it is an administrator is not known.`;
    }
    if (access.admin === true) return `The commands of a fix run in the user's terminal as ${user}, which is root: no sudo is needed.`;
    if (access.sudo) return `The commands of a fix run in the user's terminal as ${user}, which is not root but may use sudo without a password: prefix the commands that need root with sudo.`;
    if (access.admin === false) {
        return `The commands of a fix run in the user's terminal as ${user}, which is not root and may not use sudo without a password. ${needsMore}, and write the commands that need root with sudo: they work only if this user may use sudo (the terminal asks for its password); otherwise an administrator has to run them.`;
    }
    return `The commands of a fix run in the user's terminal as ${user}; whether it is root is not known.`;
}

const UNREACHABLE = "ShellMind could not connect to the server (see the connection block above): explain the likely reasons from that error (the address, the network or a firewall, the SSH service, the credentials, the host key) and give the checks that tell them apart. Nothing can run on the server now: say where each command runs (the user's own computer, the server's console, another host).";

// W7 integration: the fleet board's stored reading of a server it cannot reach.
const FLEET_READING = "The fleet health reading block is what the server looked like before it stopped answering, not now: use it only as background (a full disk, memory pressure or a pending reboot can explain an outage), and say how old it is when you rely on it.";

// `language`: the UI language ("en", "es"; others get the English headings).
// `evidence`: who a fix would run as, and whether the server was reached.
// `conversation`: what the language of the answer goes by.
export function diagnoseInstruction(
    attachment: ChatAttachment,
    language?: string,
    evidence?: Pick<ChatEvidence, "access" | "sections">,
    conversation: DiagnoseConversation = {}
): string {
    const triage = attachment.kind === "triage";
    const headings = HEADINGS[language ?? ""] ?? HEADINGS.en;
    const rule = languageRule(language, conversation);
    const unreachable = evidence?.sections.some((section) => section.id === "connection") === true;
    const fleetReading = evidence?.sections.some((section) => section.id === "fleet") === true;
    return [
        `ShellMind request: ${triage ? "triage" : "diagnose"} ${describeTarget(attachment)} with the evidence ShellMind collected from the server, in the evidence data blocks above (read-only commands; parts may be shortened, and secrets are masked as [REDACTED]).`,
        "Nothing you write runs by itself: the user reads your answer and runs a command block with one click if they agree.",
        ...(evidence?.access ? [accessInstruction(evidence.access)] : []),
        ...(attachment.kind === "pod" ? [podInstruction(attachment)] : []),
        ...(unreachable ? [UNREACHABLE] : []),
        ...(fleetReading ? [FLEET_READING] : []),
        ...(attachment.kind === "disk" ? [DISK_RULE] : []),
        triage ? triageFormat(headings.triage, rule) : diagnoseFormat(headings.diagnose, rule)
    ].join("\n");
}
