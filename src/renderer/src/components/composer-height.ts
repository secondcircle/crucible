// How tall the composer's text area is, given how tall its content is. Pure,
// so the rule can be pinned without a browser: the element measuring is the
// only part that needs one.

/** What an empty draft shows. */
export const RESTING_HEIGHT = 46

/** Past it the text area scrolls internally. */
export const CEILING_HEIGHT = 300

/**
 * A measurement that failed (a layout-less environment reports 0) lands on
 * resting, which is where an empty draft belongs anyway.
 */
export function boxHeight(contentHeight: number): number {
  if (!Number.isFinite(contentHeight)) return RESTING_HEIGHT
  return Math.min(CEILING_HEIGHT, Math.max(RESTING_HEIGHT, Math.ceil(contentHeight)))
}
