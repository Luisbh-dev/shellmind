import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";

interface ConfirmOptions {
    title: string;
    message?: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "danger" | "default";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const resolverRef = useRef<((value: boolean) => void) | null>(null);

    const confirm = useCallback<ConfirmFn>((opts) => {
        setOptions(opts);
        return new Promise<boolean>((resolve) => {
            resolverRef.current = resolve;
        });
    }, []);

    const settle = (value: boolean) => {
        resolverRef.current?.(value);
        resolverRef.current = null;
        setOptions(null);
    };

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <Modal
                open={!!options}
                onClose={() => settle(false)}
                title={options?.title}
                icon={options?.tone === "danger" ? <AlertTriangle className="w-4 h-4" /> : undefined}
                widthClass="max-w-sm"
                footer={
                    <>
                        <Button variant="ghost" size="sm" onClick={() => settle(false)}>
                            {options?.cancelLabel || "Cancel"}
                        </Button>
                        <Button
                            variant={options?.tone === "danger" ? "danger" : "primary"}
                            size="sm"
                            onClick={() => settle(true)}
                            autoFocus
                        >
                            {options?.confirmLabel || "Confirm"}
                        </Button>
                    </>
                }
            >
                <div className="text-sm text-zinc-400 leading-relaxed">{options?.message}</div>
            </Modal>
        </ConfirmContext.Provider>
    );
}

export function useConfirm(): ConfirmFn {
    const ctx = useContext(ConfirmContext);
    if (!ctx) {
        return async () => window.confirm("Are you sure?");
    }
    return ctx;
}
