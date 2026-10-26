import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const LABEL = 'block text-xs font-semibold uppercase tracking-wider text-zinc-400';

// A label tied to its control (htmlFor) with an optional hint.
export function FormField({ id, label, hint, hintId, children, className }: {
    id: string;
    label: ReactNode;
    hint?: ReactNode;
    hintId?: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn('space-y-1.5', className)}>
            <label htmlFor={id} className={LABEL}>{label}</label>
            {children}
            {hint && <p id={hintId} className="text-xs text-zinc-500">{hint}</p>}
        </div>
    );
}

// For controls that are not form elements (the themed Select): the label
// names a group around them.
export function FieldGroup({ labelId, label, children, className }: {
    labelId: string;
    label: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div role="group" aria-labelledby={labelId} className={cn('space-y-1.5', className)}>
            <span id={labelId} className={LABEL}>{label}</span>
            {children}
        </div>
    );
}
