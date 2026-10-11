/** Plugin Categories — categorize installed DSH plugins and batch-toggle categories.
 *
 * Registers two surfaces over one shared service layer (`src/service.ts`):
 *   1. the `plugin_categories` agent tool, for conversational curation;
 *   2. `/api/plugin-categories/*` HTTP routes (src/api.ts), mounted in its own
 *      `webServer` fiber, which back the settings panel in `client.js`.
 * Plugin state is read live through the `pluginManager` service (probed at
 * execute time, so the plugin still loads in profiles where that bundle is
 * off); category assignments persist in `assignments.json` under the
 * profile's `.plugin-categories/` directory.
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineCategoriesTool } from './tool.ts'
import { resolveDataDirSync } from './model.ts'
import type { CategoriesConfig } from './model.ts'
import { createApiRoutes, type WebServerLike } from './api.ts'
import { probeService } from './service.ts'

// Re-exported for tooling and tests; the loader itself only reads the keys below.
export { resolveDataDirSync }
export { createApiRoutes }

export const name = 'plugin-categories'

/** Required services. The manager is probed at execute time instead, so a
 * deployment without it degrades to a clear tool error rather than a stuck
 * PENDING load. */
export const inject = ['tools']

export interface Config extends CategoriesConfig {}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().description('分类数据目录；留白时自动探测 profile 目录（写入 .plugin-categories/assignments.json）'),
  skinDetection: Schema.boolean().default(true).description('按名称/描述自动识别皮肤插件'),
  skinKeywords: Schema.array(Schema.string()).default([]).description('追加的皮肤识别关键词（在默认表之外）'),
  skinPlugins: Schema.array(Schema.string()).default([]).description('强制视为皮肤插件的 moduleName / entry id / 组合包名'),
  categories: Schema.array(Schema.object({
    id: Schema.string().required().description('分类 id'),
    label: Schema.string().required().description('显示名称'),
    plugins: Schema.array(Schema.string()).default([]).description('固定归入该分类的插件（moduleName / entry id / 组合包名）'),
    namePattern: Schema.string().description('对名称与描述做不区分大小写的子串匹配'),
  })).default([]).description('声明式分类，与运行时创建的分类合并'),
})

export function apply(ctx: Context, config: Config): void {
  const resolved = config ?? {}
  const dataDir = resolveDataDirSync(resolved, import.meta.url)
  const storeFile = join(dataDir, 'assignments.json')
  ctx.tools.register(defineCategoriesTool(ctx, resolved, storeFile))
  console.log(`[plugin-categories] loaded; plugin_categories tool registered (data: ${storeFile})`)

  // Browser half: the settings panel's API. Its own fiber so a headless
  // composition without a web server keeps the tool working (that fiber just
  // never runs — the same degrade-the-feature pattern our-free-model uses).
  // The typeof guard exists for mock contexts in the smoke suite, which are
  // plain objects without cordis's `inject` method.
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], scoped => {
    const server = (scoped as unknown as { webServer?: WebServerLike }).webServer
    if (server === undefined) return
    // Logger is probed, not read directly: direct service access outside the
    // fiber's inject set throws in the real cordis proxy (see service.ts).
    const logger = probeService<{ warn?: (message: string) => void }>(scoped, 'logger') ?? console
    const api = createApiRoutes({ ctx: scoped, config: resolved, storeFile, logger })
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/plugin-categories', handler: api }),
      'plugin-categories: api routes')
    console.log('[plugin-categories] settings API mounted at /api/plugin-categories')
  })
}
