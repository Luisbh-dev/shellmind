// Pure helpers of the file explorer: paths, sorting, filtering and display
// formatting. Collators and formatters are created once per language, not
// per row: a 10,000-entry folder sorts and renders without stalling.
import type { FileEntry, FileProtocol } from '@shared/files';
import { nameProblem as invalidNameProblem, normalizeRemotePath, type NameProblem as InvalidName } from '@shared/remotePaths';
import type { Language } from '@/i18n';

export type SortKey = 'name' | 'size' | 'mtime';
export type SortState = { key: SortKey; direction: 'asc' | 'desc' };

const collators = new Map<string, Intl.Collator>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function collator(language: Language): Intl.Collator {
    let value = collators.get(language);
    if (!value) {
        value = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
        collators.set(language, value);
    }
    return value;
}

// --- Paths --------------------------------------------------------------------

// What the user typed in the path bar: absolute, "~" (home) or relative to
// the current folder.
export function resolveInputPath(input: string, current: string, home: string): string {
    const value = input.trim();
    if (!value) return current;
    if (value === '~' || value.startsWith('~/')) return normalizeRemotePath(`${home}/${value.slice(1)}`);
    return normalizeRemotePath(value.startsWith('/') ? value : `${current}/${value}`);
}

export type Crumb = { name: string; path: string };

export function breadcrumbs(path: string): Crumb[] {
    const segments = normalizeRemotePath(path).split('/').filter(Boolean);
    return segments.map((name, index) => ({ name, path: '/' + segments.slice(0, index + 1).join('/') }));
}

export type NameProblem = InvalidName | 'exists';

// The server's rule for new names in `parent` (shared/remotePaths.ts), plus
// the names already taken in the folder.
export function nameProblem(name: string, taken: ReadonlySet<string>, protocol: FileProtocol = 'sftp', parent = '/'): NameProblem | null {
    return invalidNameProblem(name, protocol, parent) ?? (taken.has(name) ? 'exists' : null);
}

// "report.pdf" -> "report (1).pdf", "report (2).pdf"... the first free one.
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; ; n += 1) {
        const candidate = `${stem} (${n})${extension}`;
        if (!taken.has(candidate)) return candidate;
    }
}

// --- Listing ------------------------------------------------------------------

// Identifies an entry within its folder. The name alone is not enough: S3 can
// list an object "x" and a prefix "x/" side by side.
export function entryKey(entry: Pick<FileEntry, 'name' | 'isDir'>): string {
    return `${entry.isDir ? 'd' : 'f'}:${entry.name}`;
}

export type ListingOptions = {
    sort: SortState;
    filter: string;
    showHidden: boolean;
    language: Language;
};

// Folders first, then by the sort key (name breaks ties).
export function prepareEntries(entries: readonly FileEntry[], options: ListingOptions): FileEntry[] {
    const compareNames = collator(options.language).compare;
    const needle = options.filter.trim().toLocaleLowerCase();
    const visible = entries.filter((entry) =>
        (options.showHidden || !entry.name.startsWith('.')) &&
        (!needle || entry.name.toLocaleLowerCase().includes(needle))
    );
    const sign = options.sort.direction === 'asc' ? 1 : -1;
    const key = options.sort.key;
    return visible.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        if (key === 'name') return sign * compareNames(a.name, b.name);
        const primary = key === 'size' ? a.size - b.size : a.mtime - b.mtime;
        // Equal sizes or dates stay in name order whichever the direction.
        return sign * primary || compareNames(a.name, b.name);
    });
}

// --- Display ------------------------------------------------------------------

// Sizes read as everywhere else in the app (src/lib/format.ts).
export { formatBytes } from '@/lib/format';

export function formatDate(mtime: number, language: Language): string {
    if (!mtime) return '—';
    let format = dateFormats.get(language);
    if (!format) {
        format = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
        dateFormats.set(language, format);
    }
    return format.format(mtime * 1000);
}

export function formatPermissions(mode: number): string {
    if (!mode) return '—';
    return (mode & 0o777).toString(8).padStart(3, '0');
}

export type FileKind = 'folder' | 'archive' | 'image' | 'code' | 'text' | 'binary' | 'other';

const KIND_BY_EXTENSION: Record<string, FileKind> = {};
for (const ext of ['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz', 'zst']) KIND_BY_EXTENSION[ext] = 'archive';
for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif']) KIND_BY_EXTENSION[ext] = 'image';
for (const ext of ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'go', 'rs', 'c', 'h', 'cpp', 'java', 'rb', 'php', 'json', 'yml', 'yaml', 'toml', 'html', 'htm', 'css', 'xml', 'sql', 'ps1']) KIND_BY_EXTENSION[ext] = 'code';
for (const ext of ['txt', 'md', 'log', 'conf', 'cfg', 'ini', 'env', 'properties', 'csv']) KIND_BY_EXTENSION[ext] = 'text';
for (const ext of ['exe', 'dll', 'so', 'bin', 'iso', 'img', 'dmg', 'deb', 'rpm', 'jar', 'class', 'o', 'a', 'pdf', 'mp3', 'mp4', 'mkv', 'mov', 'avi', 'wav', 'flac', 'woff', 'woff2', 'ttf', 'otf', 'sqlite', 'db', 'pyc']) KIND_BY_EXTENSION[ext] = 'binary';

function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileKind(entry: Pick<FileEntry, 'name' | 'isDir'>): FileKind {
    if (entry.isDir) return 'folder';
    return KIND_BY_EXTENSION[extensionOf(entry.name)] ?? 'other';
}

// Opened in the editor on Enter/double-click (else downloaded): small files
// that are not known binary formats. The editor still checks the content.
export function opensInEditor(entry: FileEntry, maxEditBytes: number): boolean {
    if (entry.isDir || entry.size > maxEditBytes) return false;
    const kind = fileKind(entry);
    return kind !== 'binary' && kind !== 'archive' && kind !== 'image';
}
