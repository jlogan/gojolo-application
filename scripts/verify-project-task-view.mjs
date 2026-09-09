/**
 * Focused checks for persisted project task presentation preferences.
 *
 * Run: node scripts/verify-project-task-view.mjs
 */
import {
  getStoredProjectTaskView,
  projectTaskViewStorageKey,
  storeProjectTaskView,
} from '../src/lib/projectTaskViewCore.mjs'

let passed = 0
function assert(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

const projectA = 'project-a'
const projectB = 'project-b'
const storage = memoryStorage()

assert(getStoredProjectTaskView(storage, projectA) === 'list', 'defaults to list when no preference exists')
storeProjectTaskView(storage, projectA, 'kanban')
assert(getStoredProjectTaskView(storage, projectA) === 'kanban', 'restores Kanban for the same project')
assert(getStoredProjectTaskView(storage, projectB) === 'list', 'keeps preferences isolated per project')
storeProjectTaskView(storage, projectA, 'list')
assert(getStoredProjectTaskView(storage, projectA) === 'list', 'restores List after switching back')

const invalidStorage = memoryStorage({ [projectTaskViewStorageKey(projectA)]: 'grid' })
assert(getStoredProjectTaskView(invalidStorage, projectA) === 'list', 'ignores invalid stored values')

const unavailableStorage = {
  getItem() { throw new Error('blocked') },
  setItem() { throw new Error('blocked') },
}
assert(getStoredProjectTaskView(unavailableStorage, projectA) === 'list', 'falls back when storage is unavailable')
storeProjectTaskView(unavailableStorage, projectA, 'kanban')
assert(true, 'storage write failures do not break view switching')

console.log(`Project task view checks passed: ${passed}`)
