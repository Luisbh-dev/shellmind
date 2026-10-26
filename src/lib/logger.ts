// The renderer's logger: the one module that writes to the console, in the
// spirit of server/logger.ts. Messages carry their scope; debug output is kept
// to development builds.

export type Logger = {
    error: (message: string, ...details: unknown[]) => void;
    warn: (message: string, ...details: unknown[]) => void;
    info: (message: string, ...details: unknown[]) => void;
    debug: (message: string, ...details: unknown[]) => void;
};

const debugEnabled = () => Boolean(import.meta.env.DEV) && import.meta.env.MODE !== 'test';

export function createLogger(scope: string): Logger {
    const prefix = `[ShellMind:${scope}]`;
    return {
        error: (message, ...details) => console.error(`${prefix} ${message}`, ...details),
        warn: (message, ...details) => console.warn(`${prefix} ${message}`, ...details),
        info: (message, ...details) => console.info(`${prefix} ${message}`, ...details),
        debug: (message, ...details) => {
            if (debugEnabled()) console.debug(`${prefix} ${message}`, ...details);
        }
    };
}
