import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // .crucible holds workflow records (run artifacts, repro scripts) — not app code.
  { ignores: ['out/**', 'dist/**', 'logs/**', 'node_modules/**', '.crucible/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser }
  },
  {
    // Everything under src/renderer, whatever a module's extension: the
    // universal `src/renderer/**` covers every file ESLint already scans
    // (.js/.mjs/.cjs/.ts/.tsx/.mts/.cts) without dragging index.html into the
    // lint, and the explicit `.jsx` pattern is what adds JSX files to the scan
    // at all — ESLint's default file set leaves them out. A renderer module
    // that is fenced or not depending on how it is spelled is not a fence.
    // This block carries the fence and nothing else: no plugin, no globals, so
    // it changes what is forbidden under src/renderer and never what is
    // otherwise linted there.
    files: ['src/renderer/**', 'src/renderer/**/*.jsx'],
    // The renderer import fence (D1, D4): the renderer reaches agents only
    // through the agent port, so nothing under src/renderer may import the π
    // SDK, Electron, or main/preload modules, and nothing but the IPC client
    // may touch the preload surface. Two builtin rules are the whole of it.
    //
    // It is a direct-import check. Transitivity is covered by the shape of the
    // tree — the only module the renderer shares with main is the port's type
    // module, which imports nothing — and evasion (aliases, `any` casts,
    // type-level derivations) is review's business, not lint's. What this
    // catches is the honest mistake: someone reaching for the SDK or for
    // `window.crucible` where the port was the thing to use.
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@earendil-works/*', 'electron', '**/main/**', '**/preload/**']
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name=/^(window|globalThis|self)$/][property.name='crucible']",
          message:
            'The renderer reaches agents only through the agent port (D1). Take a port as a prop; only src/renderer/src/agent/ipc-client.ts may touch window.crucible.'
        }
      ]
    }
  },
  {
    // The single exception: the IPC client is the renderer's one adapter over
    // the preload surface, so it is the one file allowed to name it.
    files: ['src/renderer/src/agent/ipc-client.ts'],
    rules: { 'no-restricted-syntax': 'off' }
  },
  {
    files: ['*.ts', '*.mjs', 'scripts/**/*.ts'],
    languageOptions: { globals: globals.node }
  }
)
