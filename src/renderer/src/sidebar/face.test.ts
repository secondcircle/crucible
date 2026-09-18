import { describe, expect, it } from 'vitest'
import { faceOf, withFace } from './face'

describe('which face a workspace’s sidebar column is on', () => {
  it('is the sessions until something says otherwise', () => {
    expect(faceOf({}, 'w1')).toBe('sessions')
    expect(faceOf({ w1: 'files' }, 'w2')).toBe('sessions')
    expect(faceOf({ w1: 'files' }, undefined)).toBe('sessions')
  })

  it('is remembered per workspace, and one workspace’s says nothing about another’s', () => {
    const faces = withFace({}, 'w1', 'files')

    expect(faceOf(faces, 'w1')).toBe('files')
    expect(faceOf(faces, 'w2')).toBe('sessions')
  })

  it('drops the entry when the sessions come back, so one fact has one shape', () => {
    expect(withFace(withFace({}, 'w1', 'files'), 'w1', 'sessions')).toEqual({})
  })

  it('hands back the record it was given when nothing moves', () => {
    const faces = withFace({}, 'w1', 'files')

    expect(withFace(faces, 'w1', 'files')).toBe(faces)
    expect(withFace(faces, 'w2', 'sessions')).toBe(faces)
  })
})
