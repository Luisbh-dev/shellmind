import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { Badge } from "./Badge";
import { useFieldContext } from "./Field";

interface TagInputProps {
    value: string[];
    onChange: (tags: string[]) => void;
    /** Existing tags offered while typing. */
    suggestions?: string[];
    placeholder?: string;
    maxTags?: number;
    maxLength?: number;
}

/** Tags as removable chips; Enter, comma or Tab adds what was typed. */
export function TagInput({ value, onChange, suggestions = [], placeholder, maxTags = 32, maxLength = 64 }: TagInputProps) {
    const [draft, setDraft] = useState("");
    const field = useFieldContext();
    const listId = useId();
    const t = useT();

    const add = (raw: string) => {
        const tag = raw.trim().slice(0, maxLength);
        if (!tag || value.length >= maxTags) return false;
        if (!value.some((existing) => existing.toLowerCase() === tag.toLowerCase())) onChange([...value, tag]);
        return true;
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if ((event.key === "Enter" || event.key === "," || (event.key === "Tab" && draft.trim())) && !event.nativeEvent.isComposing) {
            if (add(draft) || event.key !== "Tab") event.preventDefault();
            setDraft("");
        } else if (event.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
        }
    };

    const available = suggestions.filter((tag) => !value.includes(tag));

    return (
        <div
            className={cn(
                "flex min-h-[38px] w-full flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-ink-900/70 px-2 py-1.5 transition-colors",
                "focus-field focus-within:bg-ink-900"
            )}
        >
            {value.map((tag) => (
                <Badge
                    key={tag}
                    tone="brand"
                    onRemove={() => onChange(value.filter((other) => other !== tag))}
                    removeLabel={t("app.ui.removeTag", { tag })}
                >
                    {tag}
                </Badge>
            ))}
            <input
                id={field?.id}
                aria-describedby={field?.describedBy}
                value={draft}
                list={available.length ? listId : undefined}
                onChange={(event) => {
                    const next = event.target.value;
                    // Pasting "a, b, c" adds three tags.
                    if (next.includes(",")) {
                        const parts = next.split(",");
                        parts.slice(0, -1).forEach(add);
                        setDraft(parts[parts.length - 1]);
                    } else {
                        setDraft(next);
                    }
                }}
                onKeyDown={onKeyDown}
                onBlur={() => {
                    if (add(draft)) setDraft("");
                }}
                placeholder={value.length ? undefined : placeholder}
                className="min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
            />
            {available.length > 0 && (
                <datalist id={listId}>
                    {available.map((tag) => <option key={tag} value={tag} />)}
                </datalist>
            )}
        </div>
    );
}
