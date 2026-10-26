// What other features use of the snippets library (multi-exec runs snippets,
// the audit log reuses its form fields). Everything else in this folder is
// internal to the library.
export { snippetsApi } from './api';
export { FieldGroup, FormField } from './FormField';
export { useSnippetHandoff, type SnippetRef, type SnippetRunDraft } from './handoff';
export {
    fillPlaceholders,
    maskPlaceholders,
    maskSecretValues,
    missingVariables,
    NO_MARKS,
    parsePlaceholders,
    secretValues,
    secretVariableNames,
    unmarkedVariableNames,
    type SecretMarks,
    type SnippetVariable,
    type VariableValues
} from './placeholders';
export { loadLastValues, saveLastValues } from './storage';
export { CommandPreview, VariablesForm } from './VariablesForm';
