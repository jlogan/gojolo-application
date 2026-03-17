import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appVersion =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  new Date().toISOString()

function versionManifestPlugin() {
  return {
    name: 'version-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(
          {
            version: appVersion,
            builtAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), versionManifestPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
})
