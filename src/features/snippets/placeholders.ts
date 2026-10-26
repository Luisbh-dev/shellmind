// The {{placeholder}} syntax lives in shared/placeholders.ts: the multi-exec
// backend fills templates in with the same rules.
export {
    fillPlaceholders,
    isSecretVariable,
    isSensitiveVariable,
    maskPlaceholders,
    maskSecretValues,
    missingVariables,
    parsePlaceholders,
    resolveValue,
    secretValues,
    secretVariableNames,
    unmarkedVariableNames,
    type SnippetVariable,
    type VariableValues
} from '@shared/placeholders';

// The user's choices about secrets, as the forms keep them: variables marked
// as secret besides the declared and secret-looking ones, and secret-looking
// ones that are not (SecretChoices of shared/placeholders.ts).
export type SecretMarks = { marked: string[]; unmarked: string[] };

export const NO_MARKS: SecretMarks = { marked: [], unmarked: [] };
