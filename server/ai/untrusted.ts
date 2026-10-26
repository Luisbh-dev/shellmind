import { randomBytes } from "crypto";
import { trimTrailingNewlines } from "../../shared/text";

// Untrusted text (terminal and command output, OS banners) is handed to the
// model inside delimited blocks whose id is random per request, so the data
// itself cannot forge the end of its block. The system prompt names the id.

export function newDataId(): string {
    return randomBytes(6).toString("hex");
}

export type DataKind = "terminal-output" | "command-output" | "terminal-issues" | "environment" | "evidence";

export function dataBlock(kind: DataKind, content: string, id: string): string {
    const body = trimTrailingNewlines(content.replace(/\r\n?/g, "\n"));
    return `<<<DATA kind="${kind}" id="${id}">>>\n${body}\n<<<END DATA id="${id}">>>`;
}

// How clipMiddle shortens a text to `max` characters: it keeps the first
// `head` and the last `tail` of them.
export function clipShares(max: number): { head: number; tail: number } {
    const head = Math.floor(max * 0.3);
    return { head, tail: max - head };
}

export function joinClipped(head: string, omitted: number, tail: string): string {
    return `${head}\n[... ${omitted} characters omitted ...]\n${tail}`;
}

// Keeps the head and the tail of an oversized text (errors tend to be at the
// end, the command echo at the start).
export function clipMiddle(text: string, max: number): { text: string; clipped: boolean } {
    if (text.length <= max) return { text, clipped: false };
    const { head, tail } = clipShares(max);
    return { text: joinClipped(text.slice(0, head), text.length - max, text.slice(-tail)), clipped: true };
}

// The last `maxLines` lines, at most `maxChars` characters.
export function tailText(text: string, maxLines: number, maxChars: number): string {
    return text.split("\n").slice(-maxLines).join("\n").slice(-maxChars);
}
