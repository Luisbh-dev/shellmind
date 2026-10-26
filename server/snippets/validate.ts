import { SNIPPET_LIMITS, type SnippetErrorReason } from "../../shared/snippets";
import { AppError } from "../errors";

// A snippet body checked and normalized: trimmed name and description,
// de-duplicated tags. The command is kept as typed (indentation and blank
// lines matter in scripts); only trailing whitespace is dropped.
export type ValidSnippet = {
    name: string;
    command: string;
    description: string | null;
    tags: string[];
    server_id: number | null;
};

// Problems a user can cause from the editor carry a reason (details.reason,
// details.max) the UI translates; the rest are malformed requests.
export function invalidSnippet(message: string, reason?: SnippetErrorReason, max?: number): AppError {
    return new AppError("INVALID_SNIPPET", message, 400, reason ? { reason, ...(max === undefined ? {} : { max }) } : undefined);
}

function optionalText(value: unknown, field: "name" | "description", max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalidSnippet(`${field} must be a string`);
    const text = value.trim();
    if (text.length > max) throw invalidSnippet(`${field} is longer than ${max} characters`, `${field}TooLong`, max);
    return text || null;
}

export function normalizeTags(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw invalidSnippet("tags must be an array of strings");
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") throw invalidSnippet("tags must be an array of strings");
        const tag = item.trim().replace(/\s+/g, " ");
        if (!tag) continue;
        if (tag.length > SNIPPET_LIMITS.tag) throw invalidSnippet(`a tag is longer than ${SNIPPET_LIMITS.tag} characters`, "tagTooLong", SNIPPET_LIMITS.tag);
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
    }
    if (tags.length > SNIPPET_LIMITS.tags) throw invalidSnippet(`at most ${SNIPPET_LIMITS.tags} tags are allowed`, "tooManyTags", SNIPPET_LIMITS.tags);
    return tags;
}

export function parseSnippetInput(body: Record<string, unknown>): ValidSnippet {
    const name = optionalText(body.name, "name", SNIPPET_LIMITS.name);
    if (!name) throw invalidSnippet("name is required", "nameRequired");

    if (typeof body.command !== "string") throw invalidSnippet("command is required", "commandRequired");
    const command = body.command.replace(/\r\n?/g, "\n").trimEnd();
    if (!command.trim()) throw invalidSnippet("command is required", "commandRequired");
    if (command.length > SNIPPET_LIMITS.command) {
        throw invalidSnippet(`command is longer than ${SNIPPET_LIMITS.command} characters`, "commandTooLong", SNIPPET_LIMITS.command);
    }

    let serverId: number | null = null;
    if (body.server_id !== undefined && body.server_id !== null) {
        if (typeof body.server_id !== "number" || !Number.isSafeInteger(body.server_id) || body.server_id <= 0) {
            throw invalidSnippet("server_id must be a saved server id or null");
        }
        serverId = body.server_id;
    }

    return {
        name,
        command,
        description: optionalText(body.description, "description", SNIPPET_LIMITS.description),
        tags: normalizeTags(body.tags),
        server_id: serverId
    };
}
