import { create } from 'zustand';
import type { SecretMarks, VariableValues } from './placeholders';

// A snippet the library sends to multi-exec ("Run on several servers"). It
// waits here, on the snippets side, until the multi-exec modal takes it as it
// opens: the library hands work over without depending on multi-exec.

// serverId: the server a scoped snippet belongs to (null: every server).
export type SnippetRef = { id: number | null; name: string; serverId?: number | null };

export type SnippetRunDraft = {
    // The command to run; with `values`, the snippet's template they fill in
    // (multi-exec fills it in on the backend, so secret values are never
    // recorded).
    command: string;
    snippet: SnippetRef | null;
    values?: VariableValues;
    // The user's choices about which variables are secrets.
    marks?: SecretMarks;
    serverIds?: number[];
};

type HandoffState = {
    draft: SnippetRunDraft | null;
    prepare: (draft: SnippetRunDraft) => void;
    clearDraft: () => void;
};

export const useSnippetHandoff = create<HandoffState>()((set) => ({
    draft: null,
    prepare: (draft) => set({ draft }),
    clearDraft: () => set({ draft: null })
}));
