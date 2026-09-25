// Resolve `crucible:rule`, `crucible:rule/extract` and `crucible:rule/test` to the shipped copies,
// the way the workflow loader aliases `crucible:workflow`.
import { registerHooks } from 'node:module'

const aliases: Record<string, string> = {
  'crucible:rule': new URL('./public.ts', import.meta.url).href,
  'crucible:rule/extract': new URL('./extract.ts', import.meta.url).href,
  'crucible:rule/test': new URL('./test-api.ts', import.meta.url).href,
}

registerHooks({
  resolve(specifier, context, next) {
    const url = aliases[specifier]
    if (url) return { url, format: 'module-typescript', shortCircuit: true }
    const resolved = next(specifier, context)
    // A rule file is an ES module whatever the host repo's package.json says.
    if (resolved.url.includes('/.crucible/rules/') && resolved.url.endsWith('.ts')) {
      return { ...resolved, format: 'module-typescript' }
    }
    return resolved
  },
})
