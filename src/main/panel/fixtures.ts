import { join } from 'node:path'

// The two exhibits the fake flavor shows. They ship in the repository so every
// panel behavior is drivable at zero cost, by a test or by an agent under
// `npm run dev`.
export const PANEL_FIXTURE_DIRECTORY = join('fixtures', 'panel')

export interface PanelFixtures {
  readonly buildPlan: string
  readonly benchmark: string
}

/** `root` is the app's own directory, which in dev is the repository. */
export function panelFixtures(root: string): PanelFixtures {
  return {
    buildPlan: join(root, PANEL_FIXTURE_DIRECTORY, 'build-plan.md'),
    benchmark: join(root, PANEL_FIXTURE_DIRECTORY, 'benchmark.html')
  }
}
