import type { WorkspaceId } from '../../../shared/agent/port'

// Which face the sidebar column is showing, per workspace. Pure: no React, no
// DOM. Remembered for the launch and no longer, exactly as the panel's views
// are, and for the same reason — where you were in one workspace is a fact
// about this sitting, not about the folder.

export type SidebarFace = 'sessions' | 'files'

/**
 * The face each workspace is on. `sessions` is the absence of an entry rather
 * than a value, so one fact has one representation and a workspace nobody has
 * switched costs nothing.
 */
export type SidebarFaces = Readonly<Record<WorkspaceId, 'files'>>

export function faceOf(faces: SidebarFaces, workspaceId: WorkspaceId | undefined): SidebarFace {
  if (workspaceId === undefined) return 'sessions'
  return faces[workspaceId] ?? 'sessions'
}

/** The one writer. Setting `sessions` drops the entry; `files` stores it. */
export function withFace(
  faces: SidebarFaces,
  workspaceId: WorkspaceId,
  face: SidebarFace
): SidebarFaces {
  if (face === 'files') {
    if (faces[workspaceId] === 'files') return faces
    return { ...faces, [workspaceId]: 'files' }
  }
  if (faces[workspaceId] === undefined) return faces
  const rest: Record<WorkspaceId, 'files'> = { ...faces }
  delete rest[workspaceId]
  return rest
}
