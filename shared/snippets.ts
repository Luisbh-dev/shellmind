// Snippets library (runbook steps). The Snippet row type lives in types.ts.

export const SNIPPET_LIMITS = {
    name: 120,
    command: 10_000,
    description: 1000,
    tag: 32,
    tags: 16,
    // Snippets in one POST /api/snippets/import.
    import: 200
} as const;

// Body of POST /api/snippets and PUT /api/snippets/:id (PUT replaces every
// field). server_id null (or absent) makes the snippet available everywhere.
export type SnippetInput = {
    name: string;
    command: string;
    description?: string | null;
    tags?: string[];
    server_id?: number | null;
};

// details.reason of an INVALID_SNIPPET error the user can fix in the editor
// (details.max holds the limit of the *TooLong / tooManyTags reasons).
export type SnippetErrorReason =
    | "nameRequired"
    | "nameTooLong"
    | "commandRequired"
    | "commandTooLong"
    | "descriptionTooLong"
    | "tagTooLong"
    | "tooManyTags"
    | "serverNotFound";

// POST /api/snippets/import answer: snippets identical to one already saved
// (same name, command and scope) are skipped.
export type SnippetImportResult = {
    created: number;
    skipped: number;
};
