import { useMemo, useState } from 'react';
import { Copy, CopyPlus, Pencil, Play, Server as ServerIcon, Trash2, Network } from 'lucide-react';
import type { Snippet } from '@shared/types';
import { Button, IconButton } from '@/components/ui';
import { useT } from '@/i18n';
import type { WorkspaceServer } from '@/workspace/types';
import {
    fillPlaceholders,
    maskPlaceholders,
    missingVariables,
    NO_MARKS,
    parsePlaceholders,
    secretVariableNames,
    type SecretMarks,
    type VariableValues
} from './placeholders';
import { hasTerminal } from './scope';
import { loadLastValues } from './storage';
import { CommandPreview, VariablesForm } from './VariablesForm';

// A filled-in snippet: `command` runs, `display` is what may be recorded
// (secret values replaced by their {{placeholder}}), `secret` the names of
// the secret variables, `marks` the user's choices that led to them.
export type SnippetRun = { command: string; display: string; values: VariableValues; secret: string[]; marks: SecretMarks };

export type SnippetRunAction = (run: SnippetRun) => void;

interface SnippetDetailProps {
    snippet: Snippet;
    // The active connection, if any.
    server: WorkspaceServer | null;
    // Name of the server a scoped snippet belongs to.
    scopeName: string | null;
    // False for a snippet scoped to a server multi-exec cannot reach.
    canRunOnMany: boolean;
    onEdit: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onRunInTerminal: SnippetRunAction;
    onRunOnMany: SnippetRunAction;
    onCopy: SnippetRunAction;
}

// Why the snippet cannot be typed into the active terminal, if it cannot.
function terminalBlocker(snippet: Snippet, server: WorkspaceServer | null): 'noServer' | 'noTerminal' | 'otherServer' | null {
    if (!server) return 'noServer';
    if (!hasTerminal(server.type)) return 'noTerminal';
    if (snippet.server_id !== null && snippet.server_id !== server.id) return 'otherServer';
    return null;
}

export function SnippetDetail({ snippet, server, scopeName, canRunOnMany, onEdit, onDuplicate, onDelete, onRunInTerminal, onRunOnMany, onCopy }: SnippetDetailProps) {
    const t = useT();
    const variables = useMemo(() => parsePlaceholders(snippet.command), [snippet.command]);
    const [values, setValues] = useState<VariableValues>(() => loadLastValues(snippet.id));
    const [marks, setMarks] = useState<SecretMarks>(NO_MARKS);
    const [showMissing, setShowMissing] = useState(false);
    const missing = missingVariables(variables, values);
    const secret = useMemo(() => secretVariableNames(snippet.command, marks), [snippet.command, marks]);
    const command = fillPlaceholders(snippet.command, values);
    const display = maskPlaceholders(snippet.command, values, secret);
    const hidesValues = [...secret].some((name) => values[name]);
    const blocker = terminalBlocker(snippet, server);

    const attempt = (action: SnippetRunAction) => {
        if (missing.length) {
            setShowMissing(true);
            return;
        }
        action({ command, display, values, secret: [...secret], marks });
    };

    const blockerText = blocker === 'noServer'
        ? t('snippets.detail.noServer')
        : blocker === 'noTerminal'
            ? t('snippets.detail.noTerminal')
            : blocker === 'otherServer'
                ? t('snippets.detail.otherServer', { server: scopeName ?? `#${snippet.server_id}` })
                : null;

    return (
        <article className="space-y-5" aria-labelledby={`snippet-${snippet.id}-title`}>
            <header className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                    <h3 id={`snippet-${snippet.id}-title`} className="break-words text-base font-semibold text-zinc-100">{snippet.name}</h3>
                    {snippet.description && <p className="text-sm text-zinc-400">{snippet.description}</p>}
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="inline-flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-zinc-300">
                            <ServerIcon className="h-3 w-3" aria-hidden="true" />
                            {snippet.server_id === null ? t('snippets.scope.global') : t('snippets.scope.onlyOn', { server: scopeName ?? `#${snippet.server_id}` })}
                        </span>
                        {snippet.tags.map((tag) => (
                            <span key={tag} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-zinc-300">{tag}</span>
                        ))}
                    </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                    <IconButton label={t('snippets.actions.edit')} onClick={onEdit}><Pencil className="h-4 w-4" aria-hidden="true" /></IconButton>
                    <IconButton label={t('snippets.actions.duplicate')} onClick={onDuplicate}><CopyPlus className="h-4 w-4" aria-hidden="true" /></IconButton>
                    <IconButton label={t('snippets.actions.delete')} onClick={onDelete} className="hover:text-rose-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></IconButton>
                </div>
            </header>

            <CommandPreview label={variables.length ? t('snippets.detail.template') : t('snippets.detail.command')} command={snippet.command} />

            {variables.length > 0 && (
                <>
                    <VariablesForm variables={variables} values={values} onChange={setValues} showMissing={showMissing} marks={marks} onMarksChange={setMarks} />
                    <CommandPreview label={t('snippets.detail.preview')} command={display} note={hidesValues ? t('snippets.detail.secretsHidden') : null} />
                </>
            )}

            <div className="space-y-2 border-t border-white/5 pt-4">
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={() => attempt(onRunInTerminal)}
                        disabled={blocker !== null}
                        aria-describedby={blockerText ? `snippet-${snippet.id}-blocker` : undefined}
                    >
                        <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        {server && blocker !== 'noServer' ? t('snippets.actions.runIn', { server: server.name }) : t('snippets.actions.runInTerminal')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => attempt(onRunOnMany)}
                        disabled={!canRunOnMany}
                        aria-describedby={canRunOnMany ? undefined : `snippet-${snippet.id}-many-blocker`}
                    >
                        <Network className="h-3.5 w-3.5" aria-hidden="true" />
                        {snippet.server_id === null ? t('snippets.actions.runOnMany') : t('snippets.actions.openInMultiExec')}
                    </Button>
                    <Button variant="subtle" size="sm" onClick={() => attempt(onCopy)}>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('snippets.actions.copy')}
                    </Button>
                </div>
                {blockerText && <p id={`snippet-${snippet.id}-blocker`} className="text-xs text-zinc-500">{blockerText}</p>}
                {!canRunOnMany && (
                    <p id={`snippet-${snippet.id}-many-blocker`} className="text-xs text-zinc-500">
                        {t('snippets.detail.noMultiExec', { server: scopeName ?? `#${snippet.server_id}` })}
                    </p>
                )}
                {showMissing && missing.length > 0 && (
                    <p role="alert" className="text-xs text-rose-300">{t('snippets.variables.fillIn', { list: missing.join(', ') })}</p>
                )}
            </div>
        </article>
    );
}
