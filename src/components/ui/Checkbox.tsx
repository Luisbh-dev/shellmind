import { useId } from "react";
import { cn } from "@/lib/cn";

interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: React.ReactNode;
    description?: React.ReactNode;
    disabled?: boolean;
    className?: string;
    id?: string;
}

/** Native checkbox (keyboard and screen readers for free) with a label and an optional description. */
export function Checkbox({ checked, onChange, label, description, disabled, className, id }: CheckboxProps) {
    const generated = useId();
    const inputId = id ?? generated;
    const descriptionId = description ? `${inputId}-description` : undefined;
    return (
        <div className={cn("flex items-start gap-2.5", disabled && "opacity-50", className)}>
            <input
                id={inputId}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                aria-describedby={descriptionId}
                onChange={(event) => onChange(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded accent-brand-500 focus-ring disabled:cursor-not-allowed"
            />
            <div className="min-w-0">
                <label htmlFor={inputId} className="cursor-pointer text-sm text-zinc-200">{label}</label>
                {description && <p id={descriptionId} className="text-xs text-zinc-400">{description}</p>}
            </div>
        </div>
    );
}
