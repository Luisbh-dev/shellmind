import { parseEvidenceSections } from "../../shared/chatEvidence";
import { MAX_HISTORY_TURNS, MAX_HISTORY_TURN_CHARS } from "../../shared/models";
import type { ChatTurn } from "../../shared/types";
import { evidenceBlocks } from "./diagnose/prompt";
import { redactClipped } from "./redact";
import { dataBlock } from "./untrusted";

type RawHistoryItem = { role?: unknown; content?: unknown; kind?: unknown; command?: unknown; partial?: unknown; evidence?: unknown };

// The evidence sent with an earlier diagnosis, shortened: the answer that
// followed already quotes what mattered.
function earlierEvidence(raw: unknown, dataId: string): string | null {
    if (!raw || typeof raw !== "object") return null;
    const { sections, collectedAt } = raw as { sections?: unknown; collectedAt?: unknown };
    const parsed = parseEvidenceSections(sections);
    if (!parsed?.length || typeof collectedAt !== "number" || !Number.isFinite(collectedAt)) return null;
    return `Evidence ShellMind collected for an earlier diagnosis:\n${evidenceBlocks({ sections: parsed, collectedAt }, dataId, MAX_HISTORY_TURN_CHARS).join("\n\n")}`;
}

// Appended to an answer the user stopped or that was cut off, so the model
// does not build on it as if it were complete.
export const PARTIAL_ANSWER_NOTE = "[This answer was interrupted before it was complete.]";

// The output of a command Auto-Run executed, as the model sees it: data,
// never instructions.
export function commandOutputBlock(command: string, output: string, dataId: string, maxChars: number): string {
    const clipped = redactClipped(output, maxChars).text;
    return dataBlock("command-output", `$ ${command.trim()}\n${clipped || "(no output)"}`, dataId);
}

function commandOutputTurn(command: string, output: string, dataId: string): string {
    return `ShellMind request: output of the command that ran automatically.\n${commandOutputBlock(command, output, dataId, MAX_HISTORY_TURN_CHARS)}`;
}

// Whether the user wrote any message of the history (the output of a command
// that ran automatically is ShellMind's): the language they write in is known.
export function hasUserMessage(raw: unknown): boolean {
    return Array.isArray(raw) && raw.some((entry: unknown) => {
        const item = (entry && typeof entry === "object" ? entry : {}) as RawHistoryItem;
        return item.role === "user" && item.kind !== "command-output" && typeof item.content === "string" && item.content.trim() !== "";
    });
}

// Normalizes the conversation history sent by the frontend into a transcript
// the providers accept: valid roles only, consecutive same-role turns merged,
// oversized turns truncated, and the transcript always starting with "user".
// Command-output turns become delimited data blocks tagged with `dataId`.
export function sanitizeChatHistory(raw: unknown, dataId: string): ChatTurn[] {
    if (!Array.isArray(raw)) return [];

    const turns: ChatTurn[] = [];
    for (const entry of raw as unknown[]) {
        const item = (entry && typeof entry === "object" ? entry : {}) as RawHistoryItem;
        const role = item.role === "assistant" || item.role === "user" ? item.role : null;
        const content = typeof item.content === "string" ? item.content.trim() : "";
        if (!role || !content) continue;

        let text: string;
        if (item.kind === "command-output" && role === "user") {
            text = commandOutputTurn(typeof item.command === "string" ? item.command : "", content, dataId);
        } else {
            text = content.length > MAX_HISTORY_TURN_CHARS
                ? `${content.slice(0, MAX_HISTORY_TURN_CHARS)}\n[...truncated]`
                : content;
            if (item.partial === true && role === "assistant") text += `\n\n${PARTIAL_ANSWER_NOTE}`;
            const evidence = role === "user" ? earlierEvidence(item.evidence, dataId) : null;
            if (evidence) text = `${evidence}\n\nUser message:\n${text}`;
        }

        const last = turns[turns.length - 1];
        if (last && last.role === role) {
            last.content += `\n\n${text}`;
        } else {
            turns.push({ role, content: text });
        }
    }

    const recent = turns.slice(-MAX_HISTORY_TURNS);
    while (recent.length && recent[0].role === "assistant") recent.shift();
    return recent;
}
