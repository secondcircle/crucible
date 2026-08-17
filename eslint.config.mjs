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
    files: ['*.ts', '*.mjs'],
    languageOptions: { globals: globals.node }
  }
)
