/** The browser panel's HTTP surface: `/api/plugin-categories/*`.
 *
 * Same-origin JSON routes for the settings section (src/client.ts counterpart:
 * `client.js`). Every route runs the trust fence first — the composition's own
 * `connection` service when present (the exact admission the kernel applies to
 * its `/api`, which includes the browser-auth cookie), otherwise a structural
 * replica: loopback Host only, no cross-site fetches, and an Origin/Referer
 * whose authority matches the Host. The plugin's prefix is *longer* than the
 * kernel's `/api` and webServer dispatch is longest-prefix-wins, so without
 * this fence these routes would answer any local caller the app refuses.
 *
 * Permission model for writes: the fence is the gate, mirroring the kernel's
 * own settings APIs and our-free-model's precedent — the browser is the
 * authenticated local user, and HTTP has no agent session for the tool's
 * escalation channel (escalateWrite in src/tool.ts covers the tool path).
 * Read routes are safe for anyone past the fence; `set_category` applies a
 * dry run first from the panel, so a change is always confirmed on screen.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import type { CategoriesConfig } from './model.ts'
import {
  applySetCategory, applySetPlugin, assignResult, createResult, deleteResult, drySetResult,
  emptySetResult, listResult, loadLive, planSetCategory, prepareSetPlugin, probeService,
  reorderResult, restoreResult, unchangedSetPlugin,
} from './service.ts'

/** Structural view of the host's web server (provided by the web composition). */
export interface WebServerLike {
  register(options: { kind: 'prefix' | 'exact', path: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void
}

/** Connection service admission, as the kernel's own `/api` fence consults it. */
interface ConnectionService {
  admit?: (req: IncomingMessage) => { rejection?: number } | undefined
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])
const MAX_BODY_BYTES = 1024 * 1024

export interface ApiDeps {
  /** Root context — connection/manager services are probed per request. */
  ctx: Context
  config: CategoriesConfig
  storeFile: string
  /** Where rejections and handler errors are reported (kernel log visibility). */
  logger?: { warn?: (message: string) => void }
}

/** Split a Host/Origin/Referer value into {scheme, hostname, port}, defaulting the port. */
function authorityOf(value: string, defaultScheme?: string) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url: URL
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/** The structural replica fence: loopback Host, cross-site refusal, origin match. */
export function structuralRejection(req: IncomingMessage): number | undefined {
  const host = authorityOf(String(req.headers.host ?? ''))
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    let authority: ReturnType<typeof authorityOf>
    try {
      authority = authorityOf(raw.trim())
    } catch {
      return 403
    }
    if (authority === null) return 403
    // The web server speaks plain http on a loopback bind, so an Origin that
    // claims https — or any other scheme — is not this page.
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403
  }
  return undefined
}

/** Decide one request: kernel admission when composed, else the structural fence. */
export function rejectionFor(req: IncomingMessage, deps: ApiDeps): number | undefined {
  const connection = probeService<ConnectionService>(deps.ctx, 'connection')
  if (connection !== undefined && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission !== undefined && admission !== null && 'rejection' in admission) return admission.rejection
      return undefined
    } catch {
      // A connection service that throws is a composition bug; fall through to
      // the structural fence rather than answering 500 for every request.
    }
  }
  return structuralRejection(req)
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = statusCode
  return error
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'request body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch (error) {
    throw httpError(400, `invalid JSON body (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Build the handler for `POST|GET /api/plugin-categories/*`.
 * Route paths arrive with the prefix stripped by the caller below.
 */
export function createApiRoutes(deps: ApiDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/plugin-categories/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status: number, payload: unknown) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    const rejection = rejectionFor(req, deps)
    if (rejection !== undefined) {
      deps.logger?.warn?.(`plugin-categories: rejected ${method} ${routePath} -> ${rejection}`)
      return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    }
    try {
      if (method === 'GET' && routePath === '/summary') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const state = await loadLive(manager, deps.storeFile)
        return send(200, listResult(state, deps.config, deps.storeFile))
      }
      if (method === 'POST' && routePath === '/assign') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const body = await readJson(req)
        const state = await loadLive(manager, deps.storeFile)
        return send(200, await assignResult(state, deps.config, deps.storeFile, body as never))
      }
      if (method === 'POST' && routePath === '/create') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const body = await readJson(req)
        const state = await loadLive(manager, deps.storeFile)
        return send(200, await createResult(state, deps.config, deps.storeFile, body as never))
      }
      if (method === 'POST' && routePath === '/delete') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const body = await readJson(req)
        const state = await loadLive(manager, deps.storeFile)
        return send(200, await deleteResult(state, deps.config, deps.storeFile, body as never))
      }
      if (method === 'POST' && routePath === '/set_category') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const body = await readJson(req) as { category?: unknown, enabled?: unknown, dryRun?: unknown }
        const state = await loadLive(manager, deps.storeFile)
        const args = {
          category: typeof body.category === 'string' ? body.category : undefined,
          enabled: body.enabled === true,
          dryRun: body.dryRun === true,
        }
        const { group, todo, plan, enabled } = planSetCategory(state, deps.config, args)
        if (args.dryRun) return send(200, drySetResult(group, todo, plan))
        if (plan.length === 0) return send(200, emptySetResult(group))
        // Permission gate: the trust fence above (see module doc). The panel
        // always runs a dry run first, so this line only executes after the
        // user confirmed the plan on screen.
        return send(200, await applySetCategory(manager, group.id, enabled, todo))
      }
      if (method === 'POST' && routePath === '/set_plugin') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const body = await readJson(req) as { plugin?: unknown, enabled?: unknown }
        const state = await loadLive(manager, deps.storeFile)
        const { row, enabled, noop } = prepareSetPlugin(state, {
          plugin: typeof body.plugin === 'string' ? body.plugin : undefined,
          enabled: body.enabled === true,
        })
        if (noop) return send(200, unchangedSetPlugin(row))
        // Permission gate: the trust fence above; the panel's row button is the
        // one-click intent (no dry-run step for a single explicit toggle).
        return send(200, await applySetPlugin(manager, row, enabled))
      }
      if (method === 'POST' && routePath === '/reorder') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const body = await readJson(req) as { kind?: unknown, category?: unknown, ids?: unknown }
        const state = await loadLive(manager, deps.storeFile)
        return send(200, await reorderResult(state, deps.config, deps.storeFile, {
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          category: typeof body.category === 'string' ? body.category : undefined,
          ids: Array.isArray(body.ids) ? body.ids as string[] : undefined,
        }))
      }
      if (method === 'POST' && routePath === '/restore') {
        const manager = probeService<PluginManager>(deps.ctx, 'pluginManager')
        if (manager === undefined) throw httpError(503, 'The pluginManager service is not composed in this profile')
        const body = await readJson(req) as { category?: unknown }
        const state = await loadLive(manager, deps.storeFile)
        return send(200, await restoreResult(state, deps.storeFile, {
          category: typeof body.category === 'string' ? body.category : undefined,
        }))
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      const status = Number((error as { statusCode?: unknown } | null)?.statusCode)
      const message = error instanceof Error ? error.message : String(error)
      const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
      deps.logger?.warn?.(`plugin-categories: ${method} ${routePath} -> ${code}: ${message}`)
      return send(code, { error: message })
    }
  }
}
