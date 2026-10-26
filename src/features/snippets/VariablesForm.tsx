import { useId } from 'react';
import { Lock, Unlock } from 'lucide-react';
import { IconButton, Input, PasswordInput } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { isSecretVariable, NO_MARKS, type SecretMarks, type SnippetVariable, type VariableValues } from './placeholders';

interface VariablesFormProps {
    variables: SnippetVariable[];
    values: VariableValues;
    onChange: (values: VariableValues) => void;
    // Mark empty required variables (after a run was attempted).
    showMissing?: boolean;
    // Variables the user marked as secret, and secret-looking ones the user
    // unmarked (a declared `{{name:secret}}` always is one); without
    // onMarksChange nothing can be changed.
    marks?: SecretMarks;
    onMarksChange?: (marks: SecretMarks) => void;
}

const without = (list: readonly string[], name: string) => list.filter((item) => item !== name);

// One input per {{variable}}; an empty input takes the default. Secret
// variables get a masked input: their value runs, and is replaced by its
// {{placeholder}} wherever the command is recorded.
export function VariablesForm({ variables, values, onChange, showMissing = false, marks = NO_MARKS, onMarksChange }: VariablesFormProps) {
    const t = useT();
    const baseId = useId();
    if (variables.length === 0) return null;

    const toggleSecret = (variable: SnippetVariable, secret: boolean) => {
        if (!onMarksChange) return;
        const marked = without(marks.marked, variable.name);
        const unmarked = without(marks.unmarked, variable.name);
        if (secret && !variable.secret) marked.push(variable.name);
        if (!secret && variable.secret) unmarked.push(variable.name);
        onMarksChange({ marked, unmarked });
    };

    return (
        <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('snippets.variables.title')}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {variables.map((variable) => {
                    const inputId = `${baseId}-${variable.name}`;
                    const required = variable.defaultValue === null;
                    const missing = showMissing && required && !values[variable.name];
                    const secret = isSecretVariable(variable, marks);
                    const hintId = `${inputId}-hint`;
                    const inputProps = {
                        id: inputId,
                        value: values[variable.name] ?? '',
                        onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...values, [variable.name]: event.target.value }),
                        placeholder: required ? t('snippets.variables.required') : variable.defaultValue || t('snippets.variables.empty'),
                        'aria-required': required,
                        'aria-invalid': missing || undefined,
                        'aria-describedby': hintId,
                        className: 'font-mono text-xs',
                        spellCheck: false,
                        autoComplete: 'off'
                    } as const;
                    return (
                        <div key={variable.name} className="space-y-1">
                            <div className="flex min-h-6 items-center gap-1.5">
                                <label htmlFor={inputId} className="block min-w-0 truncate font-mono text-xs text-brand-300">
                                    {variable.name}
                                    {required && <span className="ml-1 text-rose-300" aria-hidden="true">*</span>}
                                </label>
                                {(variable.declaredSecret || (secret && !onMarksChange)) && (
                                    <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-200">
                                        <Lock className="h-2.5 w-2.5" aria-hidden="true" />{t('snippets.variables.secret')}
                                    </span>
                                )}
                                {!variable.declaredSecret && onMarksChange && (
                                    <IconButton
                                        size="sm"
                                        label={t('snippets.variables.markSecret', { name: variable.name })}
                                        aria-pressed={secret}
                                        onClick={() => toggleSecret(variable, !secret)}
                                        className={cn('ml-auto h-6 w-6', secret && 'text-amber-300')}
                                    >
                                        {secret ? <Lock className="h-3 w-3" aria-hidden="true" /> : <Unlock className="h-3 w-3" aria-hidden="true" />}
                                    </IconButton>
                                )}
                            </div>
                            {secret ? <PasswordInput {...inputProps} /> : <Input {...inputProps} />}
                            <p id={hintId} className={missing ? 'text-[11px] text-rose-300' : 'text-[11px] text-zinc-500'}>
                                {missing
                                    ? t('snippets.variables.missing')
                                    : required
                                        ? t('snippets.variables.requiredHint')
                                        : t('snippets.variables.defaultHint', { value: variable.defaultValue || t('snippets.variables.empty') })}
                                {secret && <span className="block">{t('snippets.variables.secretHint')}</span>}
                            </p>
                        </div>
                    );
                })}
            </div>
        </fieldset>
    );
}

// The command as it will be sent (secret values shown as their {{placeholder}}).
export function CommandPreview({ command, label, note }: { command: string; label: string; note?: string | null }) {
    const id = useId();
    const noteId = useId();
    return (
        <div className="space-y-1.5">
            <div id={id} className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{label}</div>
            <pre
                aria-labelledby={id}
                aria-describedby={note ? noteId : undefined}
                className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-ink-900/80 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 scrollbar-thin"
            >
                {command}
            </pre>
            {note && (
                <p id={noteId} className="flex items-start gap-1.5 text-[11px] text-zinc-400">
                    <Lock className="mt-px h-3 w-3 shrink-0 text-amber-300" aria-hidden="true" />{note}
                </p>
            )}
        </div>
    );
}
