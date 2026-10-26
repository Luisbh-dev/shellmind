import type { Plugin } from 'vite';

// `npm start` (scripts/dev.mjs) hands the Vite dev server the backend's session
// token and address (SHELLMIND_AUTH_TOKEN, SHELLMIND_DEV_API_BASE). They reach
// the page as a <meta> in the served index.html, which src/lib/api.ts reads.
// Never as a `define`: Vite serves defines in /@vite/env, a classic script any
// website can load with <script src> and read back from window. Another origin
// cannot read an HTML page (and vite.config.ts turns the dev server's CORS off).

export const DEV_SESSION_META = 'shellmind-dev-session';

export function devSessionPlugin(): Plugin {
    return {
        name: 'shellmind-dev-session',
        apply: 'serve',
        transformIndexHtml: () => {
            const token = process.env.SHELLMIND_AUTH_TOKEN?.trim();
            if (!token) return [];
            const apiBase = process.env.SHELLMIND_DEV_API_BASE?.trim() || undefined;
            return [
                { tag: 'meta', attrs: { name: DEV_SESSION_META, content: JSON.stringify({ token, apiBase }) }, injectTo: 'head' }
            ];
        }
    };
}
