import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { cspPlugin } from './scripts/csp'
import { devSessionPlugin } from './scripts/devSession'
import { themeBootPlugin } from './scripts/themeBoot'
import { themeBootScript } from './src/features/appearance/bootScript'

// Third-party code is split into stable chunks so the app chunk stays small and
// vendor chunks stay cacheable between releases. Patterns match `/`-normalized ids.
// Workspace panels, dialogs and the chat are lazy (React.lazy), so xterm,
// CodeMirror and the Markdown renderer load with the first panel needing them.
const MARKDOWN_PACKAGES = [
  'react-markdown', 'remark-[^/]+', 'rehype-[^/]+', 'micromark[^/]*', 'mdast-[^/]+', 'hast-[^/]+',
  'unist-[^/]+', 'unified', 'vfile[^/]*', 'property-information', 'decode-named-character-reference',
  'character-entities[^/]*', 'space-separated-tokens', 'comma-separated-tokens', 'html-url-attributes',
  'estree-util-[^/]+', 'style-to-[^/]+', 'inline-style-parser', 'devlop', 'bail', 'trough', 'extend',
  'is-plain-obj', 'ccount', 'longest-streak', 'markdown-table', 'zwitch', 'trim-lines', 'escape-string-regexp',
]
const CHUNK_GROUPS: Array<[name: string, pattern: RegExp]> = [
  ['xterm', /\/node_modules\/@xterm\/xterm\//],
  ['xterm-addons', /\/node_modules\/@xterm\/addon-[^/]+\//],
  // The editor core in two chunks (the view only depends on the state). The
  // language packages stay out: the editor imports each one on demand.
  ['codemirror-view', /\/node_modules\/(@codemirror\/(state|view)|@marijn\/find-cluster-break|crelt|style-mod|w3c-keyname)\//],
  ['codemirror', /\/node_modules\/(@codemirror\/(autocomplete|commands|language|lint|search)|@lezer\/(common|highlight|lr))\//],
  ['markdown', new RegExp(`/node_modules/(${MARKDOWN_PACKAGES.join('|')})/`)],
  ['vendor', /\/node_modules\/(react|react-dom|scheduler)\//],
  // Shared by the app and the lazy panels: one chunk instead of one per icon.
  ['icons', /\/node_modules\/lucide-react\//],
  // W7-S6: the embedded Remote Desktop client, loaded with the first
  // connection. The RDP backend carries its WebAssembly inline (~6 MB).
  ['iron-remote-desktop-rdp', /\/node_modules\/@devolutions\/iron-remote-desktop-rdp\//],
  ['iron-remote-desktop', /\/node_modules\/@devolutions\/iron-remote-desktop\//],
]

// Vite warns about chunks over build.chunkSizeWarningLimit. The RDP backend
// chunk is that large on purpose (and lazy), so the limit is raised for it
// and this keeps the usual 500 kB warning for every other chunk.
const LARGE_CHUNKS = new Set(['iron-remote-desktop-rdp'])
const CHUNK_WARNING_KB = 500
function chunkSizeGuard(): Plugin {
  return {
    name: 'shellmind-chunk-size',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || LARGE_CHUNKS.has(output.name)) continue
        const kb = output.code.length / 1000
        if (kb > CHUNK_WARNING_KB) this.warn(`${output.fileName} is ${Math.round(kb)} kB, more than ${CHUNK_WARNING_KB} kB: split it or load it lazily`)
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const themeBoot = themeBootScript()

  return {
    base: './',
    // devSessionPlugin hands the page the session of `npm start` while serving
    // only; cspPlugin applies to builds only and allows the inline theme boot
    // script by its hash.
    plugins: [react(), cspPlugin(env.VITE_API_BASE, [themeBoot]), devSessionPlugin(), themeBootPlugin(themeBoot), chunkSizeGuard()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@shared": path.resolve(__dirname, "./shared"),
      },
    },
    build: {
      // See chunkSizeGuard: only the RDP backend chunk may be this large.
      chunkSizeWarningLimit: 6500,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.split('\\').join('/')
            return CHUNK_GROUPS.find(([, pattern]) => pattern.test(normalized))?.[0]
          },
        },
      },
    },
    server: {
      port: Number(process.env.WEB_PORT) || 5173,
      strictPort: true,
      // Nothing reads the dev server from another origin, and the served
      // index.html carries the dev session token: no CORS headers at all.
      cors: false,
      // Hidden folders (other local checkouts of the repository, editor
      // settings) and build output are not this app's sources: a change
      // there (another checkout's index.html or tsconfig) made every open
      // window reload.
      watch: {
        ignored: ['**/.*/**', '**/dist/**', '**/dist-server/**', '**/dist-electron/**', '**/release/**', '**/coverage/**'],
      },
    },
  }
})
