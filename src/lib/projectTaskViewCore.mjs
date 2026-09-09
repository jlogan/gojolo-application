const STORAGE_PREFIX = 'jolo_project_task_view'

/** @param {string} projectId */
export function projectTaskViewStorageKey(projectId) {
  return `${STORAGE_PREFIX}_${projectId}`
}

/**
 * @param {{ getItem(key: string): string | null }} storage
 * @param {string} projectId
 * @returns {'list' | 'kanban'}
 */
export function getStoredProjectTaskView(storage, projectId) {
  try {
    return storage.getItem(projectTaskViewStorageKey(projectId)) === 'kanban' ? 'kanban' : 'list'
  } catch {
    return 'list'
  }
}

/**
 * @param {{ setItem(key: string, value: string): void }} storage
 * @param {string} projectId
 * @param {'list' | 'kanban'} view
 */
export function storeProjectTaskView(storage, projectId, view) {
  try {
    storage.setItem(projectTaskViewStorageKey(projectId), view)
  } catch {
    // Keep view switching functional when browser storage is unavailable.
  }
}
