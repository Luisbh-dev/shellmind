import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { MULTIEXEC_LIMITS } from '@shared/multiexec';
import type { ServerSummary, Snippet } from '@shared/types';
import { Input, SegmentedControl, Select, Spinner, Textarea } from '@/components/ui';
import { useT } from '@/i18n';
import { CommandPreview, FieldGroup, FormField, loadLastValues, NO_MARKS, VariablesForm } from '@/features/snippets/public';
import type { ComposerDerived, ComposerState } from './composerState';
import { StrategyFields } from './StrategyFields';
import { TargetPicker } from './TargetPicker';

interface ComposerProps {
    state: ComposerState;
    onChange: (state: ComposerState) => void;
    derived: ComposerDerived;
    // SSH-capable servers (null while loading).
    servers: ServerSummary[] | null;
    loadError: string | null;
    snippets: Snippet[];
    serverName: (serverId: number) => string;
    attempted: boolean;
}

export function Composer({ state, onChange, derived, servers, loadError, snippets, serverName, attempted }: ComposerProps) {
    const t = useT();
    const id = useId();
    const set = <K extends keyof ComposerState>(key: K, value: ComposerState[K]) => onChange({ ...state, [key]: value });
    const timeoutInvalid = (attempted && derived.timeoutSec === null) || undefined;

    // Snippets for every server, and those scoped to a selected one (a
    // scoped snippet only runs on its own server, as in the terminal).
    const snippetChoices = snippets.filter((item) => item.server_id === null || state.selected.has(item.server_id) || item.id === derived.snippet?.id);

    const chooseSnippet = (value: string) => onChange({ ...state, snippetId: value, values: loadLastValues(Number(value)), marks: NO_MARKS });

    return (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col">
                {loadError ? (
                    <p role="alert" className="text-sm text-rose-200">{t('multiexec.loadFailed', { error: loadError })}</p>
                ) : servers === null ? (
                    <div className="flex flex-1 items-center justify-center text-zinc-400"><Spinner /><span className="sr-only">{t('multiexec.loading')}</span></div>
                ) : (
                    <TargetPicker servers={servers} selected={state.selected} onChange={(selected) => set('selected', selected)} />
                )}
            </div>

            <div className="min-h-0 space-y-4 overflow-y-auto pr-1 scrollbar-thin">
                {state.rerunOf && (
                    <p className="rounded-lg border border-brand-500/30 bg-brand-500/[0.07] px-3 py-2 text-xs text-brand-200">{t('multiexec.compose.rerunNote')}</p>
                )}
                {state.maskedHistory && (
                    <p role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-200">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('multiexec.compose.maskedHistory')}
                    </p>
                )}

                <SegmentedControl
                    aria-label={t('multiexec.compose.source')}
                    value={state.source}
                    onChange={(source) => set('source', source)}
                    className="w-fit [&_button]:whitespace-nowrap"
                    options={[
                        { value: 'command', label: t('multiexec.compose.command') },
                        { value: 'snippet', label: t('multiexec.compose.snippet') }
                    ]}
                />

                {state.source === 'command' ? (
                    <FormField
                        id={`${id}-command`}
                        label={t('multiexec.compose.commandLabel')}
                        hintId={`${id}-command-hint`}
                        hint={state.commandSnippet ? t('multiexec.compose.fromSnippet', { name: state.commandSnippet.name }) : t('multiexec.compose.commandHint')}
                    >
                        <Textarea
                            id={`${id}-command`}
                            value={state.command}
                            onChange={(event) => onChange({ ...state, command: event.target.value, commandSnippet: null, maskedHistory: false })}
                            rows={6}
                            maxLength={MULTIEXEC_LIMITS.maxCommandLength}
                            spellCheck={false}
                            autoComplete="off"
                            aria-describedby={`${id}-command-hint`}
                            aria-invalid={(attempted && !state.command.trim()) || undefined}
                            data-view-focus
                            className="resize-y font-mono text-xs leading-relaxed"
                            placeholder="uptime && df -h /"
                        />
                    </FormField>
                ) : (
                    <FieldGroup labelId={`${id}-snippet`} label={t('multiexec.compose.snippetLabel')}>
                        <Select
                            value={state.snippetId}
                            onChange={chooseSnippet}
                            placeholder={snippetChoices.length ? t('multiexec.compose.chooseSnippet') : t('multiexec.compose.noSnippets')}
                            options={snippetChoices.map((item) => {
                                const firstLine = item.command.split('\n')[0];
                                return {
                                    value: String(item.id),
                                    label: item.name,
                                    description: item.server_id === null
                                        ? firstLine
                                        : `${t('snippets.scope.onlyOn', { server: serverName(item.server_id) })} · ${firstLine}`
                                };
                            })}
                        />
                    </FieldGroup>
                )}

                {derived.variables.length > 0 && (
                    <>
                        <VariablesForm
                            key={derived.template}
                            variables={derived.variables}
                            values={state.values}
                            onChange={(values) => set('values', values)}
                            showMissing={attempted}
                            marks={state.marks}
                            onMarksChange={(marks) => set('marks', marks)}
                        />
                        <CommandPreview
                            label={t('snippets.detail.preview')}
                            command={derived.display}
                            note={derived.hidesValues ? t('multiexec.compose.secretsHidden') : null}
                        />
                    </>
                )}
                {state.source === 'snippet' && derived.snippet && derived.variables.length === 0 && (
                    <CommandPreview label={t('snippets.detail.command')} command={derived.command} />
                )}

                <FormField id={`${id}-timeout`} label={t('multiexec.compose.timeout')} hint={t('multiexec.compose.timeoutHint')} hintId={`${id}-timeout-hint`} className="max-w-xs">
                    <Input
                        id={`${id}-timeout`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MULTIEXEC_LIMITS.maxTimeoutSec}
                        value={state.timeout}
                        onChange={(event) => set('timeout', event.target.value)}
                        aria-invalid={timeoutInvalid}
                        aria-describedby={`${id}-timeout-hint`}
                    />
                </FormField>

                <StrategyFields
                    form={state.strategy}
                    onChange={(strategy) => set('strategy', strategy)}
                    check={derived.strategyCheck}
                    targets={derived.targets.length}
                    showProblems={attempted}
                />

                {attempted && derived.problems.length > 0 && (
                    <ul role="alert" className="space-y-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                        {derived.problems.map((problem) => <li key={problem}>{problem}</li>)}
                    </ul>
                )}
            </div>
        </div>
    );
}
