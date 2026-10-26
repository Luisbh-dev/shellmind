import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ServerSummary } from '@shared/types';
import { SNIPPET_LIMITS, type SnippetInput } from '@shared/snippets';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { useT } from '@/i18n';
import { FieldGroup, FormField } from './FormField';
import { parsePlaceholders } from './placeholders';
import { hasTerminal } from './scope';

const GLOBAL_SCOPE = 'global';

// "a, b,, c" -> ["a", "b", "c"] (the backend de-duplicates).
export function parseTagList(text: string): string[] {
    return text.split(',').map((tag) => tag.trim()).filter(Boolean);
}

interface SnippetEditorProps {
    initial: SnippetInput;
    isNew: boolean;
    servers: ServerSummary[];
    saving: boolean;
    error: string | null;
    onSave: (input: SnippetInput) => void;
    onCancel: () => void;
}

export function SnippetEditor({ initial, isNew, servers, saving, error, onSave, onCancel }: SnippetEditorProps) {
    const t = useT();
    const id = useId();
    const [name, setName] = useState(initial.name);
    const [description, setDescription] = useState(initial.description ?? '');
    const [command, setCommand] = useState(initial.command);
    const [tags, setTags] = useState((initial.tags ?? []).join(', '));
    const [scope, setScope] = useState(initial.server_id ? String(initial.server_id) : GLOBAL_SCOPE);
    const [attempted, setAttempted] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        nameRef.current?.focus();
    }, []);

    const variables = useMemo(() => parsePlaceholders(command), [command]);
    const tagList = parseTagList(tags);
    const nameMissing = !name.trim();
    const commandMissing = !command.trim();

    // Servers with a terminal, plus the snippet's own one if it has none (so
    // its current scope still shows).
    const scopeOptions = [
        { value: GLOBAL_SCOPE, label: t('snippets.scope.global'), description: t('snippets.scope.globalHint') },
        ...servers
            .filter((server) => hasTerminal(server.type) || server.id === initial.server_id)
            .map((server) => ({ value: String(server.id), label: server.name, description: `${server.type} · ${server.ip}` }))
    ];

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setAttempted(true);
        if (nameMissing || commandMissing) return;
        onSave({
            name: name.trim(),
            description: description.trim() || null,
            command,
            tags: tagList,
            server_id: scope === GLOBAL_SCOPE ? null : Number(scope)
        });
    };

    return (
        <form onSubmit={submit} className="space-y-4" aria-labelledby={`${id}-title`} noValidate>
            <h3 id={`${id}-title`} className="text-sm font-semibold text-zinc-100">
                {isNew ? t('snippets.editor.newTitle') : t('snippets.editor.editTitle')}
            </h3>

            <FormField
                id={`${id}-name`}
                label={t('snippets.editor.name')}
                hint={attempted && nameMissing ? <span className="text-rose-300">{t('snippets.editor.nameRequired')}</span> : undefined}
                hintId={`${id}-name-error`}
            >
                <Input
                    id={`${id}-name`}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={SNIPPET_LIMITS.name}
                    placeholder={t('snippets.editor.namePlaceholder')}
                    aria-required
                    aria-invalid={(attempted && nameMissing) || undefined}
                    aria-describedby={attempted && nameMissing ? `${id}-name-error` : undefined}
                    ref={nameRef}
                />
            </FormField>

            <FormField id={`${id}-description`} label={t('snippets.editor.description')}>
                <Input
                    id={`${id}-description`}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={SNIPPET_LIMITS.description}
                    placeholder={t('snippets.editor.descriptionPlaceholder')}
                />
            </FormField>

            <FormField
                id={`${id}-command`}
                label={t('snippets.editor.command')}
                hintId={`${id}-command-hint`}
                hint={attempted && commandMissing
                    ? <span className="text-rose-300">{t('snippets.editor.commandRequired')}</span>
                    : t('snippets.editor.commandHint', { example: '{{name}}', exampleDefault: '{{port:22}}', exampleSecret: '{{token:secret}}', escaped: '\\{{name}}' })}
            >
                <Textarea
                    id={`${id}-command`}
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    maxLength={SNIPPET_LIMITS.command}
                    rows={7}
                    spellCheck={false}
                    autoComplete="off"
                    className="resize-y font-mono text-xs leading-relaxed"
                    aria-required
                    aria-invalid={(attempted && commandMissing) || undefined}
                    aria-describedby={`${id}-command-hint ${id}-variables`}
                    placeholder="systemctl status {{service:nginx}}"
                />
            </FormField>
            <p id={`${id}-variables`} className="-mt-2 text-xs text-zinc-400" aria-live="polite">
                {variables.length === 0
                    ? t('snippets.editor.noVariables')
                    : t('snippets.editor.variables', {
                        list: variables.map((variable) => (variable.secret
                            ? t('snippets.editor.secretVariable', { name: variable.name })
                            : variable.defaultValue === null ? variable.name : `${variable.name} = ${variable.defaultValue || '""'}`)).join(', ')
                    })}
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField id={`${id}-tags`} label={t('snippets.editor.tags')} hint={t('snippets.editor.tagsHint')} hintId={`${id}-tags-hint`}>
                    <Input
                        id={`${id}-tags`}
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        placeholder={t('snippets.editor.tagsPlaceholder')}
                        aria-describedby={`${id}-tags-hint`}
                    />
                    {tagList.length > 0 && (
                        <ul className="flex flex-wrap gap-1 pt-1" aria-label={t('snippets.editor.tags')}>
                            {tagList.map((tag, index) => (
                                <li key={`${tag}-${index}`} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">{tag}</li>
                            ))}
                        </ul>
                    )}
                </FormField>
                <FieldGroup labelId={`${id}-scope`} label={t('snippets.editor.scope')}>
                    <Select value={scope} onChange={setScope} options={scopeOptions} />
                </FieldGroup>
            </div>

            {error && (
                <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>
            )}

            <div className="flex justify-end gap-2 border-t border-white/5 pt-4">
                <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
                <Button type="submit" variant="primary" size="sm" loading={saving}>{t('snippets.editor.save')}</Button>
            </div>
        </form>
    );
}
