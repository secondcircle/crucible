// What `crucible:rule` resolves to: the rule surface plus TypeSafe's question builders,
// so a rule file in any repo needs no node_modules of its own.
export { defineRule } from './rule.ts'
export type { Action, Answers, Ctx, EditEvent, Item, Mode, Rule } from './rule.ts'
export { choice, noul, score } from '@typesafe-ai/sdk'
