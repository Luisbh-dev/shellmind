// Syntax highlighting by file name. Language support is loaded on demand, so
// opening a YAML file does not download the Python parser.
import type { StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

export const EDITOR_LANGUAGES = [
    'plain', 'json', 'yaml', 'javascript', 'typescript', 'jsx', 'tsx', 'python', 'xml', 'html',
    'markdown', 'sql', 'shell', 'nginx', 'ini', 'toml', 'dockerfile'
] as const;
export type EditorLanguage = typeof EDITOR_LANGUAGES[number];

// Shown in the status bar; "plain" is translated.
export const LANGUAGE_LABELS: Record<Exclude<EditorLanguage, 'plain'>, string> = {
    json: 'JSON',
    yaml: 'YAML',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    jsx: 'JSX',
    tsx: 'TSX',
    python: 'Python',
    xml: 'XML',
    html: 'HTML',
    markdown: 'Markdown',
    sql: 'SQL',
    shell: 'Shell',
    nginx: 'Nginx',
    ini: 'INI / properties',
    toml: 'TOML',
    dockerfile: 'Dockerfile'
};

const BY_NAME: Record<string, EditorLanguage> = {
    dockerfile: 'dockerfile',
    containerfile: 'dockerfile',
    'nginx.conf': 'nginx',
    '.bashrc': 'shell',
    '.bash_profile': 'shell',
    '.bash_aliases': 'shell',
    '.profile': 'shell',
    '.zshrc': 'shell',
    '.zprofile': 'shell',
    // System-wide shell startup files (/etc/profile, /etc/bash.bashrc, /etc/zsh/zshrc).
    profile: 'shell',
    bashrc: 'shell',
    'bash.bashrc': 'shell',
    zshrc: 'shell',
    '.env': 'ini',
    '.gitconfig': 'ini',
    '.editorconfig': 'ini',
    'pipfile': 'toml',
    'cargo.lock': 'toml'
};

const BY_EXTENSION: Record<string, EditorLanguage> = {
    json: 'json', jsonc: 'json', json5: 'json', geojson: 'json', webmanifest: 'json',
    yml: 'yaml', yaml: 'yaml',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript',
    jsx: 'jsx', tsx: 'tsx',
    py: 'python', pyw: 'python', pyi: 'python',
    xml: 'xml', xsd: 'xml', xsl: 'xml', svg: 'xml', plist: 'xml', csproj: 'xml', pom: 'xml',
    html: 'html', htm: 'html', xhtml: 'html',
    md: 'markdown', markdown: 'markdown',
    sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell',
    ini: 'ini', cfg: 'ini', cnf: 'ini', properties: 'ini', env: 'ini', service: 'ini', timer: 'ini', socket: 'ini', desktop: 'ini',
    toml: 'toml',
    dockerfile: 'dockerfile'
};

export function detectLanguage(path: string): EditorLanguage {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (BY_NAME[name]) return BY_NAME[name];
    if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile';
    if (name.startsWith('.env.')) return 'ini';
    const dot = name.lastIndexOf('.');
    const extension = dot >= 0 ? name.slice(dot + 1) : '';
    // nginx keeps its site files as plain *.conf under an nginx folder.
    if (extension === 'conf' && /\/nginx\//i.test(path)) return 'nginx';
    if (extension === 'conf') return 'ini';
    return BY_EXTENSION[extension] ?? 'plain';
}

async function legacy(load: () => Promise<StreamParser<unknown>>): Promise<Extension> {
    const [{ StreamLanguage }, mode] = await Promise.all([import('@codemirror/language'), load()]);
    return StreamLanguage.define(mode);
}

export async function loadLanguage(language: EditorLanguage): Promise<Extension> {
    switch (language) {
        case 'json': return (await import('@codemirror/lang-json')).json();
        case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
        case 'javascript': return (await import('@codemirror/lang-javascript')).javascript();
        case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
        case 'jsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
        case 'tsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
        case 'python': return (await import('@codemirror/lang-python')).python();
        case 'xml': return (await import('@codemirror/lang-xml')).xml();
        case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
        case 'sql': return (await import('@codemirror/lang-sql')).sql();
        case 'html': return legacy(async () => (await import('@codemirror/legacy-modes/mode/xml')).html);
        case 'shell': return legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell);
        case 'nginx': return legacy(async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx);
        case 'ini': return legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties);
        case 'toml': return legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml);
        case 'dockerfile': return legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
        case 'plain': return [];
    }
}
