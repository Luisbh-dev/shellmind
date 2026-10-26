import { createContext, forwardRef, useContext, useId, useState } from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";

const baseInput =
    "w-full rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm text-zinc-100 " +
    "placeholder:text-zinc-500 outline-none transition-colors focus-field focus:bg-ink-900 " +
    "aria-[invalid=true]:border-rose-500/60 disabled:opacity-50";

// What a Field tells the control inside it: its id (the label points at it),
// the label's id, the hint/error ids that describe it and whether it is invalid.
type FieldContextValue = { id: string; labelId: string; describedBy?: string; invalid: boolean };

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue | null {
    return useContext(FieldContext);
}

const joinIds = (...ids: Array<string | undefined | false>) => ids.filter(Boolean).join(" ") || undefined;

// id / aria-describedby / aria-invalid of a control, merging its own props
// with the surrounding Field's.
function useFieldProps<P extends { id?: string; "aria-describedby"?: string; "aria-invalid"?: React.AriaAttributes["aria-invalid"] }>(props: P) {
    const field = useFieldContext();
    return {
        id: props.id ?? field?.id,
        "aria-describedby": joinIds(field?.describedBy, props["aria-describedby"]),
        "aria-invalid": props["aria-invalid"] ?? (field?.invalid ? true : undefined)
    };
}

/**
 * Label + control + hint/error. The label is associated with the control
 * (Input, Textarea, PasswordInput, Select...) through context, so clicking it
 * focuses the control and screen readers announce the label, hint and error.
 */
export function Field({
    label,
    labelExtra,
    hint,
    error,
    required,
    group,
    children,
    className,
    id
}: {
    label?: React.ReactNode;
    /** Controls shown next to the label (outside of it), e.g. "Saved · Remove". */
    labelExtra?: React.ReactNode;
    hint?: React.ReactNode;
    /** Validation message; marks the control invalid. */
    error?: React.ReactNode;
    /** Shows a required marker (the control still needs `required`). */
    required?: boolean;
    /** The control is a group (radio group, swatches) labelled by id, not a single input. */
    group?: boolean;
    children: React.ReactNode;
    className?: string;
    /** Id of the control (generated when omitted). */
    id?: string;
}) {
    const generated = useId();
    const controlId = id ?? generated;
    const labelId = `${controlId}-label`;
    const hintId = hint ? `${controlId}-hint` : undefined;
    const errorId = error ? `${controlId}-error` : undefined;
    const labelClass = "block text-xs font-semibold uppercase tracking-wider text-zinc-300";
    const labelContent = (
        <>
            {label}
            {required && <span className="ml-0.5 text-rose-300" aria-hidden="true">*</span>}
        </>
    );

    return (
        <div className={cn("space-y-1.5", className)}>
            {label && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {group
                        ? <span id={labelId} className={labelClass}>{labelContent}</span>
                        : <label id={labelId} htmlFor={controlId} className={labelClass}>{labelContent}</label>}
                    {labelExtra}
                </div>
            )}
            <FieldContext.Provider value={{ id: controlId, labelId, describedBy: joinIds(errorId, hintId), invalid: Boolean(error) }}>
                {children}
            </FieldContext.Provider>
            {error && (
                <p id={errorId} className="flex items-start gap-1 text-xs text-rose-300">
                    <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                </p>
            )}
            {hint && <p id={hintId} className="text-xs text-zinc-400">{hint}</p>}
        </div>
    );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className, ...props }, ref) => {
        const fieldProps = useFieldProps(props);
        return <input ref={ref} className={cn(baseInput, className)} {...props} {...fieldProps} />;
    }
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
    ({ className, ...props }, ref) => {
        const fieldProps = useFieldProps(props);
        return <textarea ref={ref} className={cn(baseInput, "resize-none", className)} {...props} {...fieldProps} />;
    }
);
Textarea.displayName = "Textarea";

/** Password input with a show/hide toggle (reachable with the keyboard). */
export const PasswordInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className, ...props }, ref) => {
        const [visible, setVisible] = useState(false);
        const t = useT();
        const fieldProps = useFieldProps(props);
        return (
            <div className="relative">
                <input
                    ref={ref}
                    type={visible ? "text" : "password"}
                    className={cn(baseInput, "pr-10", className)}
                    {...props}
                    {...fieldProps}
                />
                <button
                    type="button"
                    onClick={() => setVisible((v) => !v)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition focus-ring"
                    aria-label={t("app.ui.showSecret")}
                    aria-pressed={visible}
                    aria-controls={fieldProps.id}
                    disabled={props.disabled}
                >
                    {visible ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
            </div>
        );
    }
);
PasswordInput.displayName = "PasswordInput";
