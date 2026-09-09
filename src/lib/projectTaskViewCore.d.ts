export type TaskPresentationView = 'list' | 'kanban'

export type ProjectTaskViewReadableStorage = {
  getItem(key: string): string | null
}

export type ProjectTaskViewWritableStorage = {
  setItem(key: string, value: string): void
}

export function projectTaskViewStorageKey(projectId: string): string
export function getStoredProjectTaskView(
  storage: ProjectTaskViewReadableStorage,
  projectId: string,
): TaskPresentationView
export function storeProjectTaskView(
  storage: ProjectTaskViewWritableStorage,
  projectId: string,
  view: TaskPresentationView,
): void
