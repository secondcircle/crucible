import { join } from 'node:path'
import type { RuleLib } from '../load'

// Where the repository and the shipped rule library sit, seen from a test
// running straight from source.

export const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

export const RULE_LIB: RuleLib = { dir: join(REPO_ROOT, 'resources', 'rule-lib') }
