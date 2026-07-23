/** Canonical task workflow statuses (order matches Kanban columns and edit dropdowns). */
export const TASK_STATUS_FLOW = [
  { value: 'open', label: 'Open', color: 'bg-gray-500/20 text-gray-300', borderColor: 'border-gray-500/30', step: 0 },
  { value: 'in_progress', label: 'In Progress', color: 'bg-blue-500/20 text-blue-400', borderColor: 'border-blue-500/30', step: 1 },
  { value: 'ready_for_testing', label: 'Ready For Testing', color: 'bg-purple-500/20 text-purple-400', borderColor: 'border-purple-500/30', step: 2 },
  { value: 'needs_work', label: 'Needs Work', color: 'bg-orange-500/20 text-orange-400', borderColor: 'border-orange-500/30', step: 3 },
  { value: 'client_review', label: 'Client Review', color: 'bg-yellow-500/20 text-yellow-400', borderColor: 'border-yellow-500/30', step: 4 },
  { value: 'complete', label: 'Complete', color: 'bg-green-500/20 text-green-400', borderColor: 'border-green-500/30', step: 5 },
] as const

export type TaskCanonicalStatus = (typeof TASK_STATUS_FLOW)[number]['value']

export const TASK_KANBAN_STATUS_ORDER: readonly TaskCanonicalStatus[] = TASK_STATUS_FLOW.map(s => s.value)

/** Legacy/raw DB statuses mapped to a canonical workflow status (display, filters, Kanban). */
export const TASK_STATUS_ALIASES: Record<string, TaskCanonicalStatus> = {
  todo: 'open',
  testing: 'ready_for_testing',
  done: 'complete',
  closed: 'complete',
}

export function normalizeTaskStatus(status: string): string {
  return TASK_STATUS_ALIASES[status as keyof typeof TASK_STATUS_ALIASES] ?? status
}

export const TASK_STATUS_CONFIG: Record<string, { label: string; classes: string }> = Object.fromEntries(
  TASK_STATUS_FLOW.map(s => [s.value, { label: s.label, classes: `${s.color} ${s.borderColor}` }]),
)

for (const [legacy, canonical] of Object.entries(TASK_STATUS_ALIASES)) {
  TASK_STATUS_CONFIG[legacy] = TASK_STATUS_CONFIG[canonical]
}

export function taskStatusLabel(status: string): string {
  const normalized = normalizeTaskStatus(status)
  return TASK_STATUS_CONFIG[normalized]?.label ?? TASK_STATUS_CONFIG[status]?.label ?? status.replace(/_/g, ' ')
}

export function taskKanbanColumnId(status: string): string {
  return normalizeTaskStatus(status)
}

export function isTaskCompleted(status: string): boolean {
  return normalizeTaskStatus(status) === 'complete'
}

export function taskKanbanHeaderClasses(status: string): string {
  const normalized = normalizeTaskStatus(status)
  const classes = TASK_STATUS_CONFIG[normalized]?.classes ?? 'bg-gray-500/20 text-gray-300 border-gray-500/30'
  return classes.replace(/\sborder-[^\s]+/g, '')
}

export const TASK_WORKFLOW_STATUSES = new Set<string>(TASK_KANBAN_STATUS_ORDER)
