import { useRef } from 'react';
import { Ban, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { useFieldContext } from '@/components/ui';
import { rovingIndex } from '@/components/ui/focus';
import { SERVER_COLORS, isServerColor, swatchClass, type ServerColor } from './colors';

// The accent color of a server, as a radio group of swatches ("none" first).
export function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: ServerColor | null) => void }) {
    const t = useT();
    const field = useFieldContext();
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const choices: Array<ServerColor | null> = [null, ...SERVER_COLORS];
    const current = isServerColor(value) ? value : null;
    const currentIndex = choices.indexOf(current);

    const onKeyDown = (event: React.KeyboardEvent) => {
        const next = rovingIndex(event.key, currentIndex, choices.length, 'horizontal');
        if (next === null) return;
        event.preventDefault();
        onChange(choices[next]);
        refs.current[next]?.focus();
    };

    return (
        <div role="radiogroup" aria-labelledby={field?.labelId} className="flex min-h-[38px] flex-wrap items-center gap-1.5">
            {choices.map((color, index) => {
                const checked = color === current;
                const label = color ? t(`organization.colors.${color}`) : t('organization.colors.none');
                return (
                    <button
                        key={color ?? 'none'}
                        ref={(element) => { refs.current[index] = element; }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-label={label}
                        title={label}
                        tabIndex={checked ? 0 : -1}
                        onClick={() => onChange(color)}
                        onKeyDown={onKeyDown}
                        className={cn(
                            'flex h-6 w-6 items-center justify-center rounded-full border transition focus-ring',
                            color ? cn(swatchClass(color), 'border-transparent') : 'border-white/15 bg-white/[0.03] text-zinc-400',
                            checked && 'ring-2 ring-white/70 ring-offset-2 ring-offset-ink-800'
                        )}
                    >
                        {color === null
                            ? <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                            : checked && <Check className="h-3.5 w-3.5 text-on-brand" aria-hidden="true" />}
                    </button>
                );
            })}
        </div>
    );
}
