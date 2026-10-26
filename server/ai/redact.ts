// Best-effort masking of well-known secret formats in terminal output before
// it is sent to an AI provider (`cat .env`, `kubectl get secret -o yaml`,
// access tokens printed by a CLI...). Formats only: a password printed on its
// own line cannot be told apart from any other text.

import { PLACEHOLDER_MARKER } from "../../shared/placeholders";
import { clipMiddle, clipShares, joinClipped } from "./untrusted";

const MASK = "[REDACTED]";

// Each pattern matches within a bounded window around the text that anchors
// it (a keyword, "://", a program name). The masking runs over command
// output of several MB, and an open-ended run before or after an anchor makes
// a long token ("a.a.a.a…", "token.token.…") cost time that grows with the
// square of its length, which blocks the backend's only thread.
const MAX_NAME = 128;
const MAX_COMMAND_LINE = 1024;

// Multi-exec redacts a command template with its placeholders set aside
// (rewriteAroundPlaceholders): each one stands in as a marker, which the
// value patterns below read as part of a value. A value that is nothing but
// placeholders (each bare, or a run of them in quotes) up to where it ends
// (`end`) is a variable, not a secret, and is left alone. Anything typed next
// to one makes the whole value a secret, marker included: the template is
// then masked as a whole.
const placeholdersOnly = (end: string) =>
    `(?!(?:${PLACEHOLDER_MARKER}|"(?:${PLACEHOLDER_MARKER})+"|'(?:${PLACEHOLDER_MARKER})+')+(?:${end}|$))`;
// Where a value ends. A shell word: at a blank or an unquoted shell operator,
// or at a quote that closes the string around the command (`sh -c "mysql
// -p{{pw}}"`). A value of text: where its pattern stops.
const WORD_END = "(?:[\\s`;|&()<>]|[\"'](?=[\\s;|&()<>]|$))";
const TEXT_END = "[\\s\"']";
const ASSIGNMENT_END = "[\\s\"',;]";

// Names of command-line options that take a credential (--password,
// --requirepass, --db-pass, -storepass, --api-key...), after their dashes and
// an optional prefix ending in "-" or "_".
const SECRET_OPTION_NAME = "(?:[\\w-]*[-_])?(?:password|passwd|passphrase|pass|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|secret[-_]?key|private[-_]?key|client[-_]?secret|auth[-_]?token|requirepass|masterauth|storepass|keypass)";
// An option's value: one shell word, quoted parts and what is glued to them
// included ("two words", "a"b). One that starts with "-" is the next option
// (`--no-password --host db`), not a secret.
const OPTION_VALUE = `(?!-)${placeholdersOnly(WORD_END)}((?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"'\`])+)`;
// A program's name and the rest of its command line before one of its
// options. The rest stops where the name occurs again, so a line that repeats
// it is read once, not once per occurrence.
const onTheLine = (programs: string) => `\\b(?:${programs})\\b(?:(?!\\b(?:${programs})\\b)[^\\n|;&]){0,${MAX_COMMAND_LINE}}?[ \\t]`;
const MYSQL_CLIENTS = "mysql|mysqladmin|mysqldump|mysqlcheck|mysqlimport|mysqlshow|mariadb(?:-[a-z]+)?";

const SECRET_OPTION = new RegExp(`^--?${SECRET_OPTION_NAME}$`, "i");
const SECRET_OPTION_ASSIGNMENT = new RegExp(`^(--?${SECRET_OPTION_NAME}=).`, "i");

const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
    // Options that take a credential: --password X, --requirepass=X, -storepass X.
    [new RegExp(`(?<![\\w-])(--?${SECRET_OPTION_NAME}(?:=|[ \\t]+))${OPTION_VALUE}`, "gi"), `$1${MASK}`],
    // mysql -pSECRET (the MySQL clients' password glued to -p; -P is the port).
    [new RegExp(`(${onTheLine(MYSQL_CLIENTS)}-p)(?=[^\\s-])${placeholdersOnly(WORD_END)}((?:"[^"\\n]*"|'[^'\\n]*'|\\S)+)`, "g"), `$1${MASK}`],
    // redis-cli -a SECRET, sshpass -p SECRET.
    [new RegExp(`(${onTheLine("redis-cli")}-a[ \\t]+)${OPTION_VALUE}`, "g"), `$1${MASK}`],
    [new RegExp(`(${onTheLine("sshpass")}-p[ \\t]*)${OPTION_VALUE}`, "g"), `$1${MASK}`],
    // curl -u user:SECRET, wget --user=user:SECRET (the password after the colon).
    [new RegExp(`(${onTheLine("curl|wget")}(?:-u[ \\t]*|--(?:proxy-)?user[= \\t][ \\t]*)["']?[^\\s:"']+:)${placeholdersOnly(TEXT_END)}([^\\s"']+)`, "g"), `$1${MASK}`],
    // openssl -passin pass:SECRET.
    [new RegExp(`(-pass(?:in|out)?[ \\t]+pass:)${placeholdersOnly(WORD_END)}(\\S+)`, "g"), `$1${MASK}`],
    // Variables of a password with a prefix: MYSQL_PWD=..., DB_PASS: ...
    // (PWD and OLDPWD, the working directories, have none).
    [new RegExp(`(?<=\\b[A-Za-z][\\w.-]{0,${MAX_NAME}})([_.-](?:pwd|pass)["']?[ \\t]*[:=][ \\t]*)${placeholdersOnly(ASSIGNMENT_END)}(["']?)([^\\s"',;]{2,})\\2`, "gi"), `$1$2${MASK}$2`],
    // PEM private keys (RSA, EC, OPENSSH, PKCS#8, encrypted).
    [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(-----END \1PRIVATE KEY-----|$)/g, (_m, kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----\n${MASK}\n-----END ${kind}PRIVATE KEY-----`],
    // JSON Web Tokens (starting where a run of their characters starts: one
    // that only tried \b would try again at each "-eyJ" of the same run).
    [/(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
    // AWS access key ids.
    [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
    // GitHub, GitLab, Slack, Google, OpenAI/Anthropic-style API keys.
    [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, MASK],
    [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, MASK],
    [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, MASK],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, MASK],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
    [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, MASK],
    // Authorization headers.
    [new RegExp(`\\b(authorization\\s*[:=]\\s*["']?(?:bearer|basic|token)\\s+)${placeholdersOnly(TEXT_END)}[^\\s"']+`, "gi"), `$1${MASK}`],
    // Credentials in URLs: scheme://user:password@host (a placeholder there
    // is taken for part of the password: https://u:{{pw}}@host).
    [/(?<=\b[a-z][a-z0-9+.-]{0,31})(:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
    // key=value / key: value assignments of secret-looking names (numbers,
    // e.g. max_tokens: 4096, are left alone). The match starts at the
    // keyword: the part of the name before it stays as it is anyway.
    [new RegExp(`((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string)[\\w.-]{0,${MAX_NAME}}["']?\\s*[:=]\\s*)${placeholdersOnly(ASSIGNMENT_END)}(["']?)(?!\\d+\\b)([^\\s"',;]{4,})\\2`, "gi"), `$1$2${MASK}$2`]
];

// The arguments of a command (a container's Entrypoint and Cmd): the value
// of an option that takes a credential is masked as a whole, also when it is
// the next argument and holds blanks; then each argument as any text.
export function redactArgv(args: readonly string[]): string[] {
    return args.map((arg, index) => {
        const previous = index > 0 ? args[index - 1] : "";
        if (SECRET_OPTION.test(previous) && !arg.startsWith("-")) return MASK;
        const assignment = SECRET_OPTION_ASSIGNMENT.exec(arg);
        if (assignment) return `${assignment[1]}${MASK}`;
        return redactSecrets(arg);
    });
}

export function redactSecrets(text: string): string {
    let result = text;
    for (const [pattern, replacement] of PATTERNS) {
        result = typeof replacement === "string"
            ? result.replace(pattern, replacement)
            : result.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
    }
    return result;
}

// Masking a part of a text instead of all of it (an output of several MB that
// is then shortened): the part is masked together with this much of the text
// around it, so a secret that the cut splits is still seen whole. It is more
// than the longest secret the patterns mask (a PEM private key).
const CUT_MARGIN = 16_384;

// clipMiddle(redactSecrets(text), max), masking only the ends that are kept.
export function redactClipped(text: string, max: number): { text: string; clipped: boolean } {
    if (text.length <= max + 2 * CUT_MARGIN) return clipMiddle(redactSecrets(text), max);
    const { head, tail } = clipShares(max);
    return {
        text: joinClipped(redactSecrets(text.slice(0, head + CUT_MARGIN)).slice(0, head), text.length - max, redactSecrets(text.slice(-(tail + CUT_MARGIN))).slice(-tail)),
        clipped: true
    };
}

// The end of a text that its last `max` characters are taken from, masked.
export function redactTail(text: string, max: number): string {
    return redactSecrets(text.length > max + CUT_MARGIN ? text.slice(-(max + CUT_MARGIN)) : text).slice(-max);
}

// Its first `max` characters, masked.
export function redactHead(text: string, max: number): string {
    return redactSecrets(text.length > max + CUT_MARGIN ? text.slice(0, max + CUT_MARGIN) : text).slice(0, max);
}
