/**
 * Verifies task artifact path builder never emits double slashes.
 * Run: node scripts/verify-task-artifact-paths.mjs
 */

function sanitizeTaskStorageFileName(name) {
  const base = name.replace(/[/\\]/g, '_').trim() || 'attachment'
  return base.length > 180 ? base.slice(0, 180) : base
}

function normalizePathSegment(segment) {
  if (segment == null) return null
  const trimmed = String(segment).trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildTaskArtifactPath(orgId, projectId, taskId, fileName, index, subfolder, batchTs) {
  const ts = batchTs ?? Date.now()
  const parts = [
    normalizePathSegment(orgId),
    normalizePathSegment(projectId),
    normalizePathSegment(taskId),
    normalizePathSegment(subfolder),
    `${ts}-${index}-${sanitizeTaskStorageFileName(fileName)}`,
  ].filter((part) => part != null)

  const path = parts.join('/')
  if (/\/{2,}/.test(path)) {
    throw new Error(`Invalid task artifact path (empty segment): ${path}`)
  }
  return path
}

const org = '29db2684-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const project = '926849e1-217d-4fee-8b63-4e4c3d09aa20'
const task = '74bb4751-dbf2-4edf-af5a-ba276dc7608f'
const batchTs = 1784908220780

const cases = [
  ['attachments tab (no subfolder)', buildTaskArtifactPath(org, project, task, 'Screenshot.png', 0, undefined, batchTs)],
  ['comment attachment', buildTaskArtifactPath(org, project, task, 'Screenshot.png', 0, 'comments', batchTs)],
  ['empty subfolder', buildTaskArtifactPath(org, project, task, 'Screenshot.png', 0, '', batchTs)],
  ['whitespace subfolder', buildTaskArtifactPath(org, project, task, 'Screenshot.png', 0, '   ', batchTs)],
  ['multi-file same batch', [
    buildTaskArtifactPath(org, project, task, 'a.png', 0, undefined, batchTs),
    buildTaskArtifactPath(org, project, task, 'b.png', 1, undefined, batchTs),
  ]],
]

let failed = false
for (const [label, result] of cases) {
  const paths = Array.isArray(result) ? result : [result]
  for (const path of paths) {
    const bad = /\/{2,}/.test(path)
    console.log(`${label}: ${path} ${bad ? 'FAIL' : 'ok'}`)
    if (bad) failed = true
  }
}

if (failed) {
  console.error('FAIL: path builder produced double slashes')
  process.exit(1)
}

console.log('PASS: no double slashes in task artifact paths')
