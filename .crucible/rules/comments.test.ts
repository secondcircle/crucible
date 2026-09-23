import { commit, edit, existingComment, scenario, write } from 'crucible:rule/test'

const ENGINE = 'src/main/workflows/engine.ts'

// --- extraction: free, no judge ---------------------------------------------

scenario(
  'a new comment is extracted with the code after it',
  edit(ENGINE, {
    replace: [
      '      let validationRetries = 0',
      '      // Count the validation retries.\n      let validationRetries = 0',
    ],
  }),
  { items: [{ stateIncludes: ['Count the validation retries', 'let validationRetries = 0'] }] },
)

scenario(
  'an edit that adds no comment extracts nothing',
  edit(ENGINE, { replace: ['      let validationRetries = 0', '      let validationRetries = 0 '] }),
  { items: 0 },
)

scenario(
  'consecutive line comments are one item',
  edit(ENGINE, {
    replace: [
      '      let validationRetries = 0',
      '      // A node gets three tries at a valid completion:\n      // a fourth failure fails the node.\n      let validationRetries = 0',
    ],
  }),
  { items: 1 },
)

scenario(
  'a lint directive is not a comment',
  edit(ENGINE, {
    replace: [
      '      let validationRetries = 0',
      '      // eslint-disable-next-line prefer-const\n      let validationRetries = 0',
    ],
  }),
  { items: 0 },
)

scenario(
  'a markdown file is out of scope',
  write('docs/adr/0099-example.md', '# 0099\n\n<!-- a comment -->\n'),
  { outOfScope: true },
)

scenario(
  'a police commit that only deletes comments adds none',
  commit('944f32c'),
  { items: 0 },
)

// --- judgment: real Jev --------------------------------------------------------

scenario(
  'a comment that narrates the next line is noted',
  edit(ENGINE, {
    replace: [
      '      let validationRetries = 0',
      '      // Count the validation retries.\n      let validationRetries = 0',
    ],
  }),
  {
    actions: [{ is: 'note' }],
    feedbackIncludes: 'describes what the code does. Delete it, or say why',
  },
)

scenario(
  'a comment naming a reason a reader could not see passes',
  edit('src/main/agent/sdk-adapter.ts', {
    replace: [
      "      steeringMode: 'all',",
      "      // π's default delivers one queued message per boundary, which strands the rest behind a long tool call.\n      steeringMode: 'all',",
    ],
  }),
  { actions: [{ is: 'pass' }] },
)

scenario(
  'a three-line comment is noted on length alone',
  edit(ENGINE, {
    replace: [
      '      let validationRetries = 0',
      '      // A node gets three tries at a valid completion.\n      // After the third the node fails,\n      // and the run hears about it.\n      let validationRetries = 0',
    ],
  }),
  { actions: [{ is: 'note' }], feedbackIncludes: 'runs 3 lines' },
)

scenario(
  'a comment citing an ADR is noted',
  edit(ENGINE, {
    replace: [
      '      let validationRetries = 0',
      '      // See ADR 0012 for why nodes are prompted verbatim.\n      let validationRetries = 0',
    ],
  }),
  { actions: [{ is: 'note' }], feedbackIncludes: 'points outside the code' },
)

// --- real comments from Crucible's history, as the police ruled them -------------
// Each is replayed from the commit before the police pass, as if an agent had just written it.

scenario(
  'police removed (f6f3bf0): names what a value is',
  existingComment('src/shared/monitors/wording.ts', 40, 'f6f3bf058^'),
  { actions: [{ is: 'note' }] },
)

scenario(
  'police removed (ef717a4): narrates a field',
  existingComment('src/renderer/src/runs/canvas.ts', 32, 'ef717a4bb^'),
  { actions: [{ is: 'note' }] },
)

scenario(
  'police removed (c9a6bfc): summarizes a type',
  existingComment('src/shared/agent/port.ts', 98, 'c9a6bfc53^'),
  { actions: [{ is: 'note' }] },
)

scenario(
  'police kept (7e84866): why the element is read instead of the prop',
  existingComment('src/renderer/src/components/Composer.tsx', 118, '7e84866e5^'),
  { actions: [{ is: 'pass' }] },
)

scenario(
  'police kept (f6f3bf0): why guidance rides the tool description',
  existingComment('src/main/agent/monitor-pi-tools.ts', 18, 'f6f3bf058^'),
  { actions: [{ is: 'pass' }] },
)

scenario(
  'police kept (7e84866): an ordering hazard',
  existingComment('src/renderer/src/Shell.tsx', 83, '7e84866e5^'),
  { actions: [{ is: 'pass' }] },
)
