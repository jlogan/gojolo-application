/**
 * Compare app.gojolo.io JS bundle against expected task attachment fix markers.
 * Run: node scripts/check-production-bundle.mjs
 */

const APP_ORIGIN = 'https://app.gojolo.io'

const NEW_MARKERS = [
  'Invalid task artifact path',
  'TaskDetail:attachment',
  '/{2,}/',
]

const OLD_MARKERS = [
  'subfolder ? `${subfolder}/`',
  '${subfolder ? `${subfolder}/`',
]

async function main() {
  const indexRes = await fetch(`${APP_ORIGIN}/`, { cache: 'no-store' })
  if (!indexRes.ok) throw new Error(`index.html HTTP ${indexRes.status}`)
  const indexHtml = await indexRes.text()
  const bundleMatch = indexHtml.match(/assets\/index-[A-Za-z0-9_-]+\.js/)
  if (!bundleMatch) throw new Error('Could not find JS bundle in index.html')
  const bundlePath = bundleMatch[0]

  const versionRes = await fetch(`${APP_ORIGIN}/version.json`, { cache: 'no-store' })
  const version = versionRes.ok ? await versionRes.json() : null

  const bundleRes = await fetch(`${APP_ORIGIN}/${bundlePath}`, { cache: 'no-store' })
  if (!bundleRes.ok) throw new Error(`${bundlePath} HTTP ${bundleRes.status}`)
  const bundle = await bundleRes.text()

  const foundNew = NEW_MARKERS.filter((m) => bundle.includes(m))
  const foundOld = OLD_MARKERS.filter((m) => bundle.includes(m))

  console.log('Production bundle:', bundlePath)
  console.log('version.json:', version)
  console.log('NEW markers found:', foundNew.length ? foundNew.join(', ') : '(none)')
  console.log('OLD markers found:', foundOld.length ? foundOld.join(', ') : '(none)')

  if (foundOld.length > 0) {
    console.error('FAIL: production still serves pre-0ee13dd path builder')
    process.exit(1)
  }
  if (foundNew.length === 0) {
    console.error('FAIL: could not confirm hardened path builder in production bundle')
    process.exit(1)
  }
  console.log('PASS: production bundle includes hardened task artifact upload code')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
