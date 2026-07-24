/** Storage object keys: {orgId}/{projectId}/{taskId}/[subfolder/]{batchTs}-{index}-{safeFileName} */

export function sanitizeTaskStorageFileName(name: string): string {
  const base = name.replace(/[/\\]/g, '_').trim() || 'attachment'
  return base.length > 180 ? base.slice(0, 180) : base
}

function normalizePathSegment(segment: string | undefined | null): string | null {
  if (segment == null) return null
  const trimmed = String(segment).trim()
  return trimmed.length > 0 ? trimmed : null
}

export function buildTaskArtifactPath(
  orgId: string,
  projectId: string,
  taskId: string,
  fileName: string,
  index: number,
  subfolder?: string,
  batchTs?: number,
): string {
  const ts = batchTs ?? Date.now()
  const parts = [
    normalizePathSegment(orgId),
    normalizePathSegment(projectId),
    normalizePathSegment(taskId),
    normalizePathSegment(subfolder),
    `${ts}-${index}-${sanitizeTaskStorageFileName(fileName)}`,
  ].filter((part): part is string => part != null)

  const path = parts.join('/')
  if (/\/{2,}/.test(path)) {
    throw new Error(`Invalid task artifact path (empty segment): ${path}`)
  }
  return path
}
