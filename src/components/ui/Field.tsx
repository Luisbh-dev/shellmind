import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

const baseInput =
    "w-full rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm text-zinc-100 " +
    "placeholder:text-zinc-500 outline-none transition-colors focus:border-brand-500/70 focus:bg-ink-900 " +
    "disabled:opacity-50";

export function Field({
    label,
    hint,
    children,
    className
}: {
    label?: React.ReactNode;
    hint?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("space-y-1.5", className)}>
            {label && (
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    {label}
                </label>
            )}
            {children}
            {hint && <p className="text-xs text-zinc-500">{hint}</p>}
        </div>
    );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className, ...props }, ref) => (
        <input ref={ref} className={cn(baseInput, className)} {...props} />
    )
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
    ({ className, ...props }, ref) => (
        <textarea ref={ref} className={cn(baseInput, "resize-none", className)} {...props} />
    )
);
Textarea.displayName = "Textarea";

/** Password input with a show/hide toggle. */
export const PasswordInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    ({ className, ...props }, ref) => {
        const [visible, setVisible] = useState(false);
        return (
            <div className="relative">
                <input
                    ref={ref}
                    type={visible ? "text" : "password"}
                    className={cn(baseInput, "pr-10", className)}
                    {...props}
                />
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setVisible((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition"
                    aria-label={visible ? "Hide" : "Show"}
                >
                    {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
            </div>
        );
    }
);
PasswordInput.displayName = "PasswordInput";
