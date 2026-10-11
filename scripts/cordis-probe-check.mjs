/** Minimal real-cordis repro: sibling-provided service, non-injecting consumer. */
import { Context } from '@deepseek-ai/cordis'

const root = new Context()

// Fiber A: provides pluginManager, like the built-in manager bundle.
root.plugin({
  name: 'fake-manager',
  inject: [],
  apply(ctx) {
    ctx.provide('pluginManager', { marker: 'real-service' })
  },
})

// Fiber B: does NOT inject pluginManager — the plugin's situation.
root.plugin({
  name: 'categories-under-test',
  inject: [],
  apply(ctx) {
    setTimeout(() => {
      // diagnostic: fiber shape
      const fiber = ctx.fiber
      console.log('B fiber.runtime  :', fiber.runtime ? `<${fiber.runtime.name ?? 'runtime'}>` : null)
      console.log('B fiber.store    :', Object.keys(fiber.store ?? {}))
      console.log('inject set       :', Object.keys(fiber.inject ?? {}))

      // Path 1: direct property access (the old code)
      try {
        const value = ctx.pluginManager
        console.log('direct access    : OK ->', JSON.stringify(value))
      } catch (e) {
        console.log('direct access    : THREW ->', e.message)
      }

      // Path 2: ctx.get (the fix)
      try {
        const value = ctx.get('pluginManager')
        console.log('ctx.get          :', value === undefined ? 'undefined' : `OK -> ${JSON.stringify(value)}`)
      } catch (e) {
        console.log('ctx.get          : THREW ->', e.message)
      }

      // Path 3: probeService fallback shape (direct access guarded)
      let fallback
      try { fallback = ctx.get('pluginManager') } catch { fallback = undefined }
      if (fallback === undefined) {
        try { fallback = ctx['pluginManager'] } catch { fallback = undefined }
      }
      console.log('probeService     :', fallback === undefined ? 'undefined' : `OK -> ${JSON.stringify(fallback)}`)
      process.exit(0)
    }, 100)
  },
})

// safety timeout
setTimeout(() => { console.log('TIMEOUT: fibers did not run'); process.exit(2) }, 3000)
