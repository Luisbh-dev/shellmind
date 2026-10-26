import { createContext, useCallback, useContext, useId, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { t as translate, useT } from "@/i18n";

interface ConfirmOptions {
    title: string;
    message?: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "danger" | "default";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

type Request = { id: number; options: ConfirmOptions; resolve: (value: boolean) => void };

const ConfirmContext = createContext<ConfirmFn | null>(null);

// Confirmations are queued: a second request waits for the first answer
// instead of replacing it (and leaving its promise unresolved).
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
    const [queue, setQueue] = useState<Request[]>([]);
    const nextId = useRef(1);
    const messageId = useId();
    const t = useT();
    const current = queue[0];
    const options = current?.options;
    const danger = options?.tone === "danger";

    const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => {
        const id = nextId.current++;
        setQueue((pending) => [...pending, { id, options: opts, resolve }]);
    }), []);

    const settle = (value: boolean) => {
        current?.resolve(value);
        setQueue((pending) => pending.slice(1));
    };

    // A fresh dialog (and initial focus) for every request. A destructive
    // action is never one Enter away: Cancel has the initial focus then.
    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <Modal
                key={current?.id ?? 0}
                open={Boolean(current)}
                onClose={() => settle(false)}
                title={options?.title}
                role="alertdialog"
                ariaDescribedBy={options?.message ? messageId : undefined}
                icon={danger ? <AlertTriangle className="w-4 h-4 text-rose-400" /> : undefined}
                widthClass="max-w-sm"
                footer={
                    <>
                        <Button variant="ghost" size="sm" onClick={() => settle(false)} data-autofocus={danger ? true : undefined}>
                            {options?.cancelLabel || t("common.cancel")}
                        </Button>
                        <Button
                            variant={danger ? "danger" : "primary"}
                            size="sm"
                            onClick={() => settle(true)}
                            data-autofocus={danger ? undefined : true}
                        >
                            {options?.confirmLabel || t("common.confirm")}
                        </Button>
                    </>
                }
            >
                <div id={messageId} className="text-sm text-zinc-300 leading-relaxed break-words">{options?.message}</div>
            </Modal>
        </ConfirmContext.Provider>
    );
}

export function useConfirm(): ConfirmFn {
    const ctx = useContext(ConfirmContext);
    if (!ctx) {
        return async () => window.confirm(translate("common.areYouSure"));
    }
    return ctx;
}
