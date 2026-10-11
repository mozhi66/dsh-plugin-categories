import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
mkdirSync(new URL('lib/', root), { recursive: true })

await build({
  entryPoints: [fileURLToPath(new URL('src/index.ts', root))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: fileURLToPath(new URL('lib/index.js', root)),
  // DSH host packages resolve from the profile's node_modules at runtime.
  external: ['@deepseek-ai/*', 'node:*'],
  sourcemap: true,
  legalComments: 'none',
})
console.log('built lib/index.js')
