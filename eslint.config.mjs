import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // .crucible holds workflow records, not app code.
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
    // The explicit `.jsx` pattern is what brings JSX files into the scan at
    // all: a fence that depends on how a module is spelled is not a fence.
    files: ['src/renderer/**', 'src/renderer/**/*.jsx'],
    // Direct imports only. This catches the honest reach for the SDK where the
    // port was the thing to use, not a determined evasion of it.
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
            'The renderer reaches agents only through the agent port (ADR 0001). Take a port as a prop; only src/renderer/src/agent/ipc-client.ts may touch window.crucible.'
        }
      ]
    }
  },
  {
    // The IPC client is the renderer's one adapter over the preload surface,
    // and its test stands in for that surface, so both sit inside the fence.
    files: ['src/renderer/src/agent/ipc-client.ts', 'src/renderer/src/agent/ipc-client.test.ts'],
    rules: { 'no-restricted-syntax': 'off' }
  },
  {
    files: ['*.ts', '*.mjs', 'scripts/**/*.ts'],
    languageOptions: { globals: globals.node }
  }
)
