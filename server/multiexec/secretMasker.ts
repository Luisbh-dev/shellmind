import { MIN_MASKED_LENGTH, maskSecretValues, type SecretValue } from "../../shared/placeholders";

// Masks the values of a job's secret variables in the output it streams and
// keeps (a script that echoes its password must not write it to the job
// history). Output arrives in chunks, so a value split across two of them is
// caught by holding back the end of each chunk while it could still be the
// start of a value. Values shorter than MIN_MASKED_LENGTH are not looked for
// (shared/placeholders.ts).

export { maskSecretValues, type SecretValue };

export type SecretMasker = {
    // The masked text that is safe to hand on now.
    push: (text: string) => string;
    // What was held back, at the end of the stream.
    end: () => string;
};

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

export function createSecretMasker(values: readonly SecretValue[]): SecretMasker {
    const secrets = values.filter((secret) => secret.value.length >= MIN_MASKED_LENGTH).sort((a, b) => b.value.length - a.value.length);
    if (secrets.length === 0) return { push: (text) => text, end: () => "" };
    const longest = secrets[0].value.length;
    let pending = "";

    // Where the part that could still grow into a value starts.
    const holdFrom = (text: string): number => {
        for (let start = Math.max(0, text.length - longest + 1); start < text.length; start++) {
            const tail = text.slice(start);
            if (secrets.some(({ value }) => value.length > tail.length && value.startsWith(tail))) return start;
        }
        return text.length;
    };

    return {
        push: (text) => {
            const masked = maskSecretValues(pending + text, secrets);
            let cut = holdFrom(masked);
            if (cut > 0 && cut < masked.length && isHighSurrogate(masked.charCodeAt(cut - 1))) cut -= 1;
            pending = masked.slice(cut);
            return masked.slice(0, cut);
        },
        end: () => {
            const rest = pending;
            pending = "";
            return rest;
        }
    };
}
