import { useRef } from "react";
import { cn } from "@/lib/cn";
import { useFieldContext } from "./Field";
import { rovingIndex } from "./focus";

export interface SegmentOption<V extends string> {
    value: V;
    label: React.ReactNode;
    icon?: React.ReactNode;
    /** Longer text for the tooltip (and the accessible description). */
    hint?: string;
    disabled?: boolean;
}

interface SegmentedControlProps<V extends string> {
    value: V;
    onChange: (value: V) => void;
    options: SegmentOption<V>[];
    /** Accessible name when not inside a labelled Field. */
    "aria-label"?: string;
    /** "cards" shows larger tiles with the icon above the label. */
    variant?: "pills" | "cards";
    className?: string;
}

/**
 * One choice out of a few, as a radio group: one Tab stop, arrow keys move
 * and select, like native radio buttons.
 */
export function SegmentedControl<V extends string>({
    value,
    onChange,
    options,
    "aria-label": ariaLabel,
    variant = "pills",
    className
}: SegmentedControlProps<V>) {
    const field = useFieldContext();
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const enabled = options.filter((option) => !option.disabled);
    const selectedIndex = options.findIndex((option) => option.value === value);

    const onKeyDown = (event: React.KeyboardEvent, index: number) => {
        const position = enabled.indexOf(options[index]);
        const next = rovingIndex(event.key, position, enabled.length);
        if (next === null) return;
        event.preventDefault();
        const option = enabled[next];
        onChange(option.value);
        refs.current[options.indexOf(option)]?.focus();
    };

    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : field?.labelId}
            aria-describedby={field?.describedBy}
            className={cn(
                variant === "pills"
                    ? "flex gap-1 rounded-lg border border-white/10 bg-ink-900/50 p-1"
                    : "grid gap-2",
                className
            )}
            style={variant === "cards" ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
        >
            {options.map((option, index) => {
                const checked = option.value === value;
                // The selected option (or the first one) is the group's Tab stop.
                const tabbable = checked || (selectedIndex === -1 && index === 0);
                return (
                    <button
                        key={option.value}
                        ref={(element) => { refs.current[index] = element; }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={tabbable ? 0 : -1}
                        disabled={option.disabled}
                        title={option.hint}
                        onClick={() => onChange(option.value)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                        className={cn(
                            "focus-ring transition-colors disabled:opacity-40 disabled:pointer-events-none",
                            variant === "pills"
                                ? cn(
                                    // A long translation wraps rather than spilling out of the pill.
                                    "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium",
                                    checked ? "bg-brand-500/15 text-brand-200" : "text-zinc-400 hover:text-zinc-200"
                                )
                                : cn(
                                    "flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border px-1.5 py-3 text-center",
                                    checked
                                        ? "bg-brand-500/10 border-brand-500/50 text-brand-200 ring-1 ring-brand-500/30"
                                        : "bg-white/[0.02] border-white/5 text-zinc-400 hover:border-white/15 hover:text-zinc-200 hover:bg-white/[0.04]"
                                )
                        )}
                    >
                        {option.icon && <span aria-hidden="true">{option.icon}</span>}
                        <span className={cn(variant === "cards" ? "w-full truncate text-xs font-medium" : "min-w-0 break-words text-center leading-tight")}>{option.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
