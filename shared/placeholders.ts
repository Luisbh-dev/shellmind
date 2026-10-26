// `{{name}}` and `{{name:default}}` placeholders in snippet commands. Names
// start with a letter or an underscore, so Go templates such as docker's
// `{{.Names}}` or `{{json .}}` are left alone, and so are the bare template
// words (`{{end}}`, `{{else}}`, `{{println}}`…) of `{{range .Mounts}}…{{end}}`.
// A backslash before the braces (`\{{name}}`) keeps a placeholder literally.
//
// Secret variables: `{{name:secret}}` declares one (it has no default and is
// always a secret), and a name that looks like a secret (`{{password}}`,
// `{{api_token}}`…) is one unless the user says otherwise. The user can also
// mark any other variable as a secret. Their values are used to run the
// command and nowhere else: the form of the command that is recorded (audit
// log, job history, terminal history) keeps their `{{name}}` placeholder
// instead (see maskPlaceholders), and output that echoes them is masked
// (maskSecretValues).
//
// Shared by the snippets library, the terminal (which types the filled
// command) and the multi-exec backend (which fills it in itself).

export type SnippetVariable = {
    name: string;
    // null: no default, a value is required. '' is an explicit empty default.
    defaultValue: string | null;
    // A secret unless the user unmarks it: declared, or named like a secret.
    secret: boolean;
    // Declared with `{{name:secret}}`: always a secret.
    declaredSecret: boolean;
};

export type VariableValues = Record<string, string>;

// The user's choices about secrets: variables marked as secret besides the
// declared and secret-looking ones, and secret-looking ones that are not
// (a declared secret cannot be unmarked).
export type SecretChoices = { marked?: Iterable<string>; unmarked?: Iterable<string> };

const PLACEHOLDER = /(\\?)\{\{\s*([A-Za-z_][\w-]*)\s*(?::([^}]*))?\}\}/g;

// The default that declares a secret instead (`{{token:secret}}`).
export const SECRET_MARKER = "secret";

// Go template keywords, literals and the functions that are complete on
// their own. Written bare they belong to a template (docker, kubectl, helm),
// never to a snippet; with a default (`{{end:3}}`) they are a variable.
const TEMPLATE_WORDS = new Set([
    "block", "break", "continue", "define", "else", "end", "false", "if", "nil",
    "print", "println", "range", "template", "true", "with"
]);

// Names that suggest a secret ({{password}}, {{db_pass}}, {{api_token}},
// {{AUTH_KEY}}, {{rootpw}}…), read as words: snake_case, kebab-case and
// camelCase parts, trailing digits ignored. Unambiguous words count anywhere
// in a part ({{dbpassword}}); short ones only as a whole part, so
// {{keyword}}, {{authorized_keys}}, {{spin}}, {{author}} or {{bypass}} are
// ordinary variables. A false positive can be unmarked by the user; a miss
// can be marked.
const SENSITIVE_IN_WORD = ["password", "passwd", "passphrase", "secret", "token", "apikey", "privatekey", "credential"];
const SENSITIVE_WORDS = new Set(["pass", "pwd", "pw", "pin", "otp", "totp", "cred", "creds", "cookie", "cookies", "jwt", "bearer"]);
const SENSITIVE_PAIRS = new Set(["apikey", "privatekey", "authkey", "secretkey", "signingkey", "encryptionkey", "masterkey"]);

function nameWords(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()
        .split(/[_-]+/)
        .map((word) => word.replace(/\d+$/, ""))
        .filter(Boolean);
}

export function isSensitiveVariable(name: string): boolean {
    const words = nameWords(name);
    return words.some((word, index) => SENSITIVE_WORDS.has(word)
        || /(?:pw|pwd)$/.test(word)
        || SENSITIVE_IN_WORD.some((part) => word.includes(part))
        || (index > 0 && SENSITIVE_PAIRS.has(words[index - 1] + word)));
}

const isTemplateWord = (name: string, defaultValue: string | undefined) => defaultValue === undefined && TEMPLATE_WORDS.has(name);

const isSecretMarker = (defaultValue: string | undefined) => defaultValue !== undefined && defaultValue.trim().toLowerCase() === SECRET_MARKER;

// The variables of a command in order of first use. The first default given
// for a name wins; a name declared secret anywhere is a declared secret.
export function parsePlaceholders(command: string): SnippetVariable[] {
    const variables = new Map<string, SnippetVariable>();
    for (const [, escaped, name, defaultValue] of command.matchAll(PLACEHOLDER)) {
        if (escaped || isTemplateWord(name, defaultValue)) continue;
        const declared = isSecretMarker(defaultValue);
        const value = defaultValue === undefined || declared ? null : defaultValue.trim();
        const known = variables.get(name);
        if (!known) {
            variables.set(name, { name, defaultValue: value, secret: declared || isSensitiveVariable(name), declaredSecret: declared });
        } else {
            if (known.defaultValue === null && value !== null) known.defaultValue = value;
            if (declared) {
                known.secret = true;
                known.declaredSecret = true;
            }
        }
    }
    // A declared secret has no default (`secret` is the declaration). One
    // written for a secret-looking name is kept: it is in the snippet anyway.
    for (const variable of variables.values()) if (variable.declaredSecret) variable.defaultValue = null;
    return [...variables.values()];
}

// Whether `variable` is a secret, given the user's choices.
export function isSecretVariable(variable: SnippetVariable, choices: { marked?: readonly string[]; unmarked?: readonly string[] } = {}): boolean {
    if (variable.declaredSecret) return true;
    if (choices.marked?.includes(variable.name)) return true;
    return variable.secret && !choices.unmarked?.includes(variable.name);
}

// The value a placeholder takes: what was typed, else its default.
export function resolveValue(variable: SnippetVariable, values: VariableValues): string {
    const typed = values[variable.name];
    return typed !== undefined && typed !== "" ? typed : variable.defaultValue ?? "";
}

// Variables without a default that have no value yet.
export function missingVariables(variables: SnippetVariable[], values: VariableValues): string[] {
    return variables.filter((variable) => variable.defaultValue === null && !values[variable.name]).map((variable) => variable.name);
}

// The names of the secret variables of `command`: the declared ones, the
// secret-looking ones the user did not unmark and those the user marked.
export function secretVariableNames(command: string, choices: SecretChoices = {}): Set<string> {
    const marked = [...(choices.marked ?? [])];
    const unmarked = [...(choices.unmarked ?? [])];
    return new Set(parsePlaceholders(command).filter((variable) => isSecretVariable(variable, { marked, unmarked })).map((variable) => variable.name));
}

// The secret-looking (not declared) variables of `command` that are not in
// `secret`: those the user unmarked when `secret` was worked out.
export function unmarkedVariableNames(command: string, secret: Iterable<string>): string[] {
    const kept = new Set(secret);
    return parsePlaceholders(command).filter((variable) => variable.secret && !variable.declaredSecret && !kept.has(variable.name)).map((variable) => variable.name);
}

function replacePlaceholders(command: string, value: (variable: SnippetVariable) => string): string {
    const variables = new Map(parsePlaceholders(command).map((variable) => [variable.name, variable]));
    return command.replace(PLACEHOLDER, (match, escaped: string, name: string, defaultValue: string | undefined) => {
        if (escaped) return match.slice(1);
        const variable = isTemplateWord(name, defaultValue) ? undefined : variables.get(name);
        return variable ? value(variable) : match;
    });
}

// The noncharacter that delimits a placeholder set aside by
// rewriteAroundPlaceholders, and the marker that stands in for one (as a
// regular expression): the noncharacter, a private-use character that
// numbers the placeholder, the noncharacter again. Secret patterns
// (server/ai/redact.ts) take a marker for part of a value, but leave alone a
// value that is nothing but markers.
export const PLACEHOLDER_MARK = "\uFDD0";
const MARKER_INDEX = "[\\uE000-\\uF8FF]";
export const PLACEHOLDER_MARKER = `${PLACEHOLDER_MARK}${MARKER_INDEX}${PLACEHOLDER_MARK}`;
const MARKER = new RegExp(`${PLACEHOLDER_MARK}(${MARKER_INDEX})${PLACEHOLDER_MARK}`, "g");

// Applies `rewrite` to the text of `command` around its placeholders, which
// are set aside meanwhile and put back unchanged. Each one stands in as a
// marker that reads as part of whatever word it is in: a pattern that takes
// that word whole (a secret typed next to a placeholder) alters the marker.
// null when `rewrite` dropped or altered a marker (it took a placeholder as
// part of something it replaced).
export function rewriteAroundPlaceholders(command: string, rewrite: (text: string) => string): string | null {
    const MARK = PLACEHOLDER_MARK;
    if (command.includes(MARK)) return null;
    const kept: string[] = [];
    const text = command.replace(PLACEHOLDER, (match) => {
        kept.push(match);
        return `${MARK}${String.fromCharCode(0xe000 + kept.length - 1)}${MARK}`;
    });
    if (kept.length > 0x1900) return null;
    const rewritten = rewrite(text);
    const found = new Set<number>();
    const restored = rewritten.replace(MARKER, (match, code: string) => {
        const index = code.charCodeAt(0) - 0xe000;
        if (found.has(index) || kept[index] === undefined) return match;
        found.add(index);
        return kept[index];
    });
    return found.size === kept.length && !restored.includes(MARK) ? restored : null;
}

// The command with every placeholder replaced. Values are inserted as typed
// (the snippet decides about quoting).
export function fillPlaceholders(command: string, values: VariableValues): string {
    return replacePlaceholders(command, (variable) => resolveValue(variable, values));
}

// The command as it may be recorded: like fillPlaceholders, except that the
// secret variables (`secret`, see secretVariableNames) keep a `{{name}}`
// placeholder in place of their value.
export function maskPlaceholders(command: string, values: VariableValues, secret: ReadonlySet<string>): string {
    return replacePlaceholders(command, (variable) => (secret.has(variable.name) ? `{{${variable.name}}}` : resolveValue(variable, values)));
}

export type SecretValue = { name: string; value: string };

// The values of the secret variables that were given (non-empty), longest
// first, so a value that contains another is masked whole.
export function secretValues(values: VariableValues, secret: ReadonlySet<string>): SecretValue[] {
    return [...secret]
        .map((name) => ({ name, value: values[name] ?? "" }))
        .filter((entry) => entry.value !== "")
        .sort((a, b) => b.value.length - a.value.length);
}

// Values shorter than this are not looked for in output: masking every "ab"
// of it would make it unreadable.
export const MIN_MASKED_LENGTH = 3;

// `text` with every secret value (MIN_MASKED_LENGTH characters or more)
// replaced by its `{{name}}` placeholder; `secrets` longest first.
export function maskSecretValues(text: string, secrets: readonly SecretValue[]): string {
    let result = text;
    for (const { name, value } of secrets) {
        if (value.length >= MIN_MASKED_LENGTH && result.includes(value)) result = result.split(value).join(`{{${name}}}`);
    }
    return result;
}
