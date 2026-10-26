export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// An expected failure with a stable machine-readable code and the HTTP status
// it maps to. Anything else that reaches a route is a 500.
export class AppError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details?: Record<string, unknown>;

    constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
        super(message);
        this.name = "AppError";
        this.code = code;
        this.status = status;
        this.details = details;
    }
}
