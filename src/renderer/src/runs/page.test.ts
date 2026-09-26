// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { paged, RUN_PAGE } from './page'

const ids = (count: number): number[] => Array.from({ length: count }, (_, at) => at)

describe('a capped list of runs', () => {
  it('opens on a page of twenty', () => {
    expect(RUN_PAGE).toBe(20)
  })

  it('draws the first rows and says what the next click adds', () => {
    const page = paged(ids(45), 20)
    expect(page.rows).toEqual(ids(20))
    expect(page.more).toEqual({ next: 20, older: 25 })
  })

  it('names the real size of the last batch', () => {
    expect(paged(ids(51), 40).more).toEqual({ next: 11, older: 11 })
  })

  it('has no foot once every row is drawn', () => {
    expect(paged(ids(20), 20)).toEqual({ rows: ids(20) })
    expect(paged(ids(3), 40)).toEqual({ rows: ids(3) })
    expect(paged([], 20)).toEqual({ rows: [] })
  })
})
