import {
    MULTIEXEC_LIMITS,
    MULTIEXEC_SERVER_TYPES,
    type MultiExecJobInfo,
    type MultiExecRequest,
    type MultiExecStrategy,
    type MultiExecTarget
} from '@shared/multiexec';
import type { ServerSummary, Snippet } from '@shared/types';
import type { TranslateFn } from '@/i18n';
import {
    fillPlaceholders,
    maskPlaceholders,
    missingVariables,
    NO_MARKS,
    parsePlaceholders,
    secretVariableNames,
    unmarkedVariableNames,
    type SecretMarks,
    type SnippetRef,
    type SnippetRunDraft,
    type SnippetVariable,
    type VariableValues
} from '@/features/snippets/public';
import { DEFAULT_STRATEGY_FORM, formFromStrategy, parseBounded, strategyForRerun, strategyFromForm, type StrategyCheck, type StrategyForm } from './strategy';

// What the composer holds (as typed) and what follows from it: the command
// that runs, the form that is recorded, the problems that keep it from
// running, and the request for the backend.

export type ComposerState = {
    source: 'command' | 'snippet';
    // The command, or a template with {{placeholders}} (filled in from `values`).
    command: string;
    // The snippet a prefilled command came from (kept until it is edited).
    commandSnippet: SnippetRef | null;
    snippetId: string;
    values: VariableValues;
    // The user's choices about which variables are secrets.
    marks: SecretMarks;
    selected: Set<number>;
    timeout: string;
    strategy: StrategyForm;
    // The job this one runs again.
    rerunOf: string | null;
    // The command comes from the history with parts masked: check it first.
    maskedHistory: boolean;
};

export const isSshCapable = (server: { type: ServerSummary['type'] }) => MULTIEXEC_SERVER_TYPES.includes(server.type);

export const toTarget = (server: ServerSummary): MultiExecTarget => ({ serverId: server.id, name: server.name, host: server.ip, type: server.type });

export function emptyComposer(selected: Iterable<number> = []): ComposerState {
    return {
        source: 'command',
        command: '',
        commandSnippet: null,
        snippetId: '',
        values: {},
        marks: NO_MARKS,
        selected: new Set(selected),
        timeout: String(MULTIEXEC_LIMITS.defaultTimeoutSec),
        strategy: DEFAULT_STRATEGY_FORM,
        rerunOf: null,
        maskedHistory: false
    };
}

// A snippet handed over by the library: with values it opens on that
// snippet, filled in as it was.
export function composerFromDraft(draft: SnippetRunDraft, fallback: Iterable<number>): ComposerState {
    const base = emptyComposer(draft.serverIds ?? fallback);
    if (draft.values && draft.snippet?.id != null) {
        return { ...base, source: 'snippet', snippetId: String(draft.snippet.id), values: draft.values, marks: draft.marks ?? NO_MARKS };
    }
    return { ...base, command: draft.command, commandSnippet: draft.snippet };
}

// The composer for running a job again on `serverIds` (a rerun: the servers
// where it did not succeed, with its rollout fitted to them). The request
// this window sent has the secret values; from the history they must be
// typed again, and so must the parts of the command masked there.
export function composerFromJob(info: MultiExecJobInfo, serverIds: Iterable<number>, request: MultiExecRequest | undefined, rerun: boolean): ComposerState {
    const selected = [...serverIds];
    const base = emptyComposer(selected);
    const command = request?.command ?? info.template ?? info.command;
    const marks: SecretMarks = request
        ? { marked: request.secretVariables ?? [], unmarked: request.publicVariables ?? [] }
        : { marked: info.secretVariables, unmarked: info.template ? unmarkedVariableNames(info.template, info.secretVariables) : [] };
    return {
        ...base,
        command,
        commandSnippet: info.snippet,
        values: request?.variables ?? info.variables ?? {},
        marks,
        timeout: String(info.timeoutSec),
        strategy: formFromStrategy(rerun ? strategyForRerun(info.strategy, selected.length) : info.strategy),
        rerunOf: rerun ? info.id : null,
        maskedHistory: !request && (info.template ? info.templateMasked : info.masked)
    };
}

export type ComposerDerived = {
    snippet: Snippet | null;
    snippetRef: SnippetRef | null;
    template: string;
    variables: SnippetVariable[];
    secret: ReadonlySet<string>;
    // What runs, and what is shown and recorded (secret values masked).
    command: string;
    display: string;
    hidesValues: boolean;
    missing: string[];
    targets: ServerSummary[];
    timeoutSec: number | null;
    strategyCheck: StrategyCheck;
    strategy: MultiExecStrategy | null;
    problems: string[];
    // Ready to send (without the danger confirmation), when there are no problems.
    request: MultiExecRequest | null;
};

export function deriveComposer(
    state: ComposerState,
    snippets: readonly Snippet[],
    servers: readonly ServerSummary[],
    serverName: (serverId: number) => string,
    t: TranslateFn
): ComposerDerived {
    const snippet = state.source === 'snippet' ? snippets.find((item) => String(item.id) === state.snippetId) ?? null : null;
    const template = state.source === 'snippet' ? snippet?.command ?? '' : state.command;
    const variables = parsePlaceholders(template);
    const names = new Set(variables.map((variable) => variable.name));
    const values = Object.fromEntries(Object.entries(state.values).filter(([name, value]) => names.has(name) && value !== ''));
    const secret = secretVariableNames(template, state.marks);
    const missing = missingVariables(variables, values);
    const command = variables.length ? fillPlaceholders(template, values) : template;
    const display = variables.length ? maskPlaceholders(template, values, secret) : template;
    const snippetRef: SnippetRef | null = state.source === 'snippet'
        ? (snippet ? { id: snippet.id, name: snippet.name, serverId: snippet.server_id } : null)
        : state.commandSnippet;
    const targets = servers.filter((server) => state.selected.has(server.id));
    const timeoutSec = parseBounded(state.timeout, 1, MULTIEXEC_LIMITS.maxTimeoutSec);
    const strategyCheck = strategyFromForm(state.strategy, targets.length, t);

    const scopeId = snippetRef?.serverId ?? null;
    const scopeProblem = snippetRef && scopeId != null && targets.some((target) => target.id !== scopeId)
        ? t('multiexec.compose.snippetScoped', { name: snippetRef.name, server: serverName(scopeId) })
        : null;

    const problems = [
        targets.length === 0 && t('multiexec.compose.needTargets'),
        targets.length > MULTIEXEC_LIMITS.maxTargets && t('multiexec.compose.tooManyTargets', { max: MULTIEXEC_LIMITS.maxTargets }),
        scopeProblem,
        state.source === 'snippet' && !snippet && t('multiexec.compose.needSnippet'),
        !command.trim() && (state.source === 'command' || snippet) && t('multiexec.compose.needCommand'),
        command.length > MULTIEXEC_LIMITS.maxCommandLength && t('multiexec.compose.commandTooLong', { max: MULTIEXEC_LIMITS.maxCommandLength }),
        missing.length > 0 && t('snippets.variables.fillIn', { list: missing.join(', ') }),
        timeoutSec === null && t('multiexec.compose.badTimeout', { max: MULTIEXEC_LIMITS.maxTimeoutSec }),
        ...strategyCheck.problems
    ].filter((problem): problem is string => Boolean(problem));

    const strategy = strategyCheck.strategy;
    const request: MultiExecRequest | null = problems.length || timeoutSec === null || !strategy ? null : {
        command: template.replace(/\r\n?/g, '\n'),
        ...(variables.length ? {
            variables: values,
            secretVariables: [...secret].filter((name) => state.marks.marked.includes(name)),
            publicVariables: variables.filter((variable) => !secret.has(variable.name) && state.marks.unmarked.includes(variable.name)).map((variable) => variable.name)
        } : {}),
        serverIds: targets.map((target) => target.id),
        timeoutSec,
        strategy,
        snippet: snippetRef && { id: snippetRef.id, name: snippetRef.name },
        ...(state.rerunOf ? { rerunOf: state.rerunOf } : {})
    };

    return {
        snippet,
        snippetRef,
        template,
        variables,
        secret,
        command,
        display,
        hidesValues: [...secret].some((name) => values[name]),
        missing,
        targets,
        timeoutSec,
        strategyCheck,
        strategy,
        problems,
        request
    };
}
