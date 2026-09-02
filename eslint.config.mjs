import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// The renderer's script-src 'self' is this app's one mechanical backstop
// against an HTML-injection bug, and the renderer holds the agent port.
const DANGEROUS_HTML =
  "The renderer's script-src 'self' is the app's backstop against HTML injection, and the renderer holds the agent port. Render text as text; a context panel exhibit gets its own origin instead. If a legitimate need appears, argue the exception in review rather than taking it silently."

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
            'The renderer reaches agents only through the agent port and the OS only through the workspace service. Take them as props; only src/renderer/src/bridge.ts may touch window.crucible.'
        },
        // Both spellings: the JSX attribute, and the object property that
        // catches createElement props and spread objects.
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: DANGEROUS_HTML
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message: DANGEROUS_HTML
        }
      ]
    }
  },
  {
    // These are the renderer's only readers of the preload surface, so the
    // window.crucible fence lets them through — and only that fence. The
    // dangerouslySetInnerHTML ban is restated rather than switched off with
    // it, so widening this block can never quietly widen that one.
    files: [
      'src/renderer/src/bridge.ts',
      'src/renderer/src/agent/ipc-client.test.ts',
      'src/renderer/src/commands/ipc-client.test.ts',
      'src/renderer/src/quota/ipc-client.test.ts',
      'src/renderer/src/workspace/ipc-client.test.ts'
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: DANGEROUS_HTML
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message: DANGEROUS_HTML
        }
      ]
    }
  },
  {
    files: ['*.ts', '*.mjs', 'scripts/**/*.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    // The two scripts npm and the icon build run directly under plain Node,
    // with no bundler and no type stripping in the way: CommonJS is what a
    // `.js` file is here, and `require` is how it loads.
    files: ['scripts/**/*.js'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
)
