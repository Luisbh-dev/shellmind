// The raw `inspect` output of a container with its environment values
// masked. They are in Config.Env, and Podman repeats them in
// Config.CreateCommand (`-e KEY=VALUE`, `--env=KEY=VALUE`, `-eKEY=VALUE`, and
// podman-compose's own arguments): every KEY=VALUE of the environment is
// masked wherever it appears, as is any value given with -e/--env.

type Json = unknown;

const ENV_FLAGS = new Set(['-e', '--env']);
// The KEY=VALUE glued to a flag ("--env=KEY=VALUE", "-eKEY=VALUE").
const GLUED_ENV = /^(--env=|-e)([A-Za-z_][A-Za-z0-9_.-]*)=(.+)$/s;
const PAIR = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.+)$/s;

function environment(inspect: Json): Array<[string, string]> {
    const config = inspect && typeof inspect === 'object' ? (inspect as { Config?: { Env?: unknown } }).Config : undefined;
    if (!config || !Array.isArray(config.Env)) return [];
    return config.Env.flatMap((entry): Array<[string, string]> => {
        if (typeof entry !== 'string') return [];
        const index = entry.indexOf('=');
        return index > 0 && index < entry.length - 1 ? [[entry.slice(0, index), entry.slice(index + 1)]] : [];
    });
}

export function maskInspect(inspect: Json, mask: string): Json {
    // Longest first: "A=secret-long" before "A=secret".
    const pairs = environment(inspect)
        .map(([name, value]) => [`${name}=${value}`, `${name}=${mask}`] as const)
        .sort((a, b) => b[0].length - a[0].length);

    const maskText = (text: string): string => {
        let result = text;
        for (const [plain, masked] of pairs) result = result.split(plain).join(masked);
        return result;
    };

    // One argument of a command line (an array of strings).
    const maskArgument = (argument: string, previous: unknown): string => {
        // After -e / --env comes KEY=VALUE (or a KEY taken from the caller's environment).
        const pair = typeof previous === 'string' && ENV_FLAGS.has(previous) ? PAIR.exec(argument) : null;
        if (pair) return `${pair[1]}=${mask}`;
        const glued = GLUED_ENV.exec(argument);
        return glued ? `${glued[1]}${glued[2]}=${mask}` : maskText(argument);
    };

    const walk = (value: Json): Json => {
        if (typeof value === 'string') return maskText(value);
        if (Array.isArray(value)) {
            return value.map((item, index) => (typeof item === 'string' ? maskArgument(item, value[index - 1]) : walk(item)));
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
        }
        return value;
    };
    return walk(inspect);
}
