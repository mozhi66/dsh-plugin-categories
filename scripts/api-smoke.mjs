// End-to-end smoke of the browser API (src/api.ts) against a mocked manager.
// Covers: the trust fence (cross-origin refusal), summary grouping, assign
// persistence, set_category dry-run + real batch toggle, and the 503 degrade
// when the pluginManager service is absent.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createApiRoutes } from '../lib/index.js'

const dataDir = mkdtempSync(join(tmpdir(), 'curator-api-'))
const storeFile = join(dataDir, 'assignments.json')

const ENTRIES = [
  { entryId: 'ui-skin-qq2006', moduleName: '@dsh-external/dsh-qq2006', meta: { title: 'QQ2006 皮肤' }, enabled: true, fiberPhase: 'active' },
  { entryId: 'tool-memory', moduleName: '@dsh-external/dsh-memory', meta: { title: '长期记忆' }, enabled: false, fiberPhase: null },
  { entryId: 'locked', moduleName: '@ext/locked', meta: {}, enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' },
]
const BUNDLES = []
const toggles = []

const ctx = {
  pluginManager: {
    listPlugins: async () => ENTRIES,
    listBundles: async () => BUNDLES,
    setPluginEnabled: async (id, enabled) => { toggles.push([id, enabled]); return { changed: true, application: 'applied', target: id, enabled } },
  },
  get: () => undefined,
}
const handler = createApiRoutes({ ctx, config: { categories: [{ id: 'mcp', label: 'MCP 服务器' }] }, storeFile })

function fakeReq({ method = 'GET', url, body, headers = {} }) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = {
    host: '127.0.0.1:19387',
    'sec-fetch-site': 'same-origin',
    origin: 'http://127.0.0.1:19387',
    ...headers,
  }
  return req
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { this.body = chunk ?? '' },
  }
}

async function call(options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  let json
  try { json = JSON.parse(res.body || 'null') } catch { json = res.body }
  return { status: res.status, json }
}

// 1. Trust fence: cross-site fetch and foreign Origin are refused.
const crossSite = await call({ url: '/api/plugin-categories/summary', headers: { 'sec-fetch-site': 'cross-site' } })
if (crossSite.status !== 403 || crossSite.json.error !== 'forbidden') throw new Error(`cross-site not refused: ${crossSite.status} ${JSON.stringify(crossSite.json)}`)
const foreignOrigin = await call({ url: '/api/plugin-categories/summary', headers: { origin: 'http://evil.example:19387' } })
if (foreignOrigin.status !== 403) throw new Error(`foreign origin not refused: ${foreignOrigin.status}`)

// 2. Summary: skin auto-detected, memory plugin uncategorized.
const summary = await call({ url: '/api/plugin-categories/summary' })
if (summary.status !== 200) throw new Error(`summary failed: ${summary.status} ${JSON.stringify(summary.json)}`)
const byId = Object.fromEntries(summary.json.categories.map(group => [group.id, group]))
if (byId.skin?.members.length !== 1 || byId.skin.members[0].key !== '@dsh-external/dsh-qq2006') throw new Error(`skin group wrong: ${JSON.stringify(byId.skin)}`)
if (!byId.uncategorized?.members.some(row => row.key === '@dsh-external/dsh-memory')) throw new Error('memory should be uncategorized')
if (summary.json.dataFile !== storeFile) throw new Error('dataFile mismatch')

// 3. Assign persists to the store file.
const assign = await call({ method: 'POST', url: '/api/plugin-categories/assign', body: { category: 'tools', plugins: ['@dsh-external/dsh-memory'], createIfMissing: true, label: '工具' } })
if (assign.status !== 200 || assign.json.assigned?.length !== 1) throw new Error(`assign failed: ${assign.status} ${JSON.stringify(assign.json)}`)
const persisted = JSON.parse(readFileSync(storeFile, 'utf8'))
if (persisted.assignments['@dsh-external/dsh-memory'] !== 'tools') throw new Error('assignment not persisted')

// 4. set_category: dry run reports the plan without toggling; apply toggles.
const dry = await call({ method: 'POST', url: '/api/plugin-categories/set_category', body: { category: 'skin', enabled: false, dryRun: true } })
if (dry.status !== 200 || dry.json.dryRun !== true || dry.json.plan?.length !== 1) throw new Error(`dry run wrong: ${dry.status} ${JSON.stringify(dry.json)}`)
if (toggles.length !== 0) throw new Error('dry run must not toggle')
const apply = await call({ method: 'POST', url: '/api/plugin-categories/set_category', body: { category: 'skin', enabled: false } })
if (apply.status !== 200 || apply.json.changed !== 1 || toggles.length !== 1 || toggles[0][1] !== false) throw new Error(`apply wrong: ${JSON.stringify(apply.json)} toggles=${JSON.stringify(toggles)}`)

// 5. Unknown route answers 404 through the same fence.
const missing = await call({ url: '/api/plugin-categories/nope' })
if (missing.status !== 404) throw new Error(`expected 404, got ${missing.status}`)

// 6. No pluginManager service → 503 with a clear message (tool parity).
const bareCtx = { get: () => undefined }
const bare = createApiRoutes({ ctx: bareCtx, config: {}, storeFile })
const res503 = fakeRes()
await bare(fakeReq({ url: '/api/plugin-categories/summary' }), res503)
if (res503.status !== 503) throw new Error(`expected 503 without manager, got ${res503.status}`)
if (!JSON.parse(res503.body).error.includes('pluginManager')) throw new Error('503 should name pluginManager')

// 7. Rename a config-declared category: the runtime label must override the
//    config label while membership stays config-driven.
const beforeRename = await call({ url: '/api/plugin-categories/summary' })
const mcpBefore = beforeRename.json.categories.find(group => group.id === 'mcp')
if (mcpBefore === undefined || mcpBefore.label !== 'MCP 服务器') throw new Error(`config label expected: ${JSON.stringify(mcpBefore)}`)
const renamed = await call({ method: 'POST', url: '/api/plugin-categories/create', body: { category: 'mcp', label: '我的 MCP' } })
if (renamed.status !== 200 || renamed.json.created !== 'mcp') throw new Error(`rename failed: ${renamed.status} ${JSON.stringify(renamed.json)}`)
const afterRename = await call({ url: '/api/plugin-categories/summary' })
const mcpAfter = afterRename.json.categories.find(group => group.id === 'mcp')
if (mcpAfter?.label !== '我的 MCP') throw new Error(`config label not overridden: ${JSON.stringify(mcpAfter)}`)

// 8. set_plugin: single flip works; unknown keys and read-only rows are refused
//    before any write reaches the manager.
const flip = await call({ method: 'POST', url: '/api/plugin-categories/set_plugin', body: { plugin: '@dsh-external/dsh-memory', enabled: true } })
if (flip.status !== 200 || flip.json.changed !== 1 || flip.json.failed !== 0) throw new Error(`set_plugin failed: ${flip.status} ${JSON.stringify(flip.json)}`)
if (toggles.length !== 2 || toggles[1][1] !== true) throw new Error(`set_plugin did not reach the manager: ${JSON.stringify(toggles)}`)
const unknownFlip = await call({ method: 'POST', url: '/api/plugin-categories/set_plugin', body: { plugin: 'no-such', enabled: true } })
if (unknownFlip.status !== 500 || !String(unknownFlip.json.error).includes('Unknown plugin')) throw new Error(`unknown key should error: ${unknownFlip.status} ${JSON.stringify(unknownFlip.json)}`)
const lockedFlip = await call({ method: 'POST', url: '/api/plugin-categories/set_plugin', body: { plugin: '@ext/locked', enabled: false } })
if (lockedFlip.status !== 500 || !String(lockedFlip.json.error).includes('read-only')) throw new Error(`read-only should error: ${lockedFlip.status} ${JSON.stringify(lockedFlip.json)}`)
if (toggles.length !== 2) throw new Error('refused flips must not reach the manager')

// 9. reorder: group order persists into the next summary; duplicates and
//    foreign member keys are rejected before writing.
const groups0 = (await call({ url: '/api/plugin-categories/summary' })).json.categories.map(group => group.id)
const reversed = [...groups0].reverse()
const reo = await call({ method: 'POST', url: '/api/plugin-categories/reorder', body: { kind: 'groups', ids: reversed } })
if (reo.status !== 200 || reo.json.saved !== reversed.length) throw new Error(`reorder failed: ${reo.status} ${JSON.stringify(reo.json)}`)
const groups1 = (await call({ url: '/api/plugin-categories/summary' })).json.categories.map(group => group.id)
if (groups1.join('|') !== reversed.join('|')) throw new Error(`order not applied: ${groups1}`)
const dup = await call({ method: 'POST', url: '/api/plugin-categories/reorder', body: { kind: 'groups', ids: [groups1[0], groups1[0]] } })
if (dup.status !== 500 || !String(dup.json.error).includes('duplicate')) throw new Error(`duplicate ids should error: ${dup.status} ${JSON.stringify(dup.json)}`)
const foreign = await call({ method: 'POST', url: '/api/plugin-categories/reorder', body: { kind: 'members', category: 'skin', ids: ['@dsh-external/dsh-memory'] } })
if (foreign.status !== 500 || !String(foreign.json.error).includes('not members')) throw new Error(`foreign member should error: ${foreign.status} ${JSON.stringify(foreign.json)}`)

// 10. delete verdicts: config groups are HIDDEN (restorable via /restore,
//     members rejoin the remaining rules), unknown groups answer not-found.
const delCfg = await call({ method: 'POST', url: '/api/plugin-categories/delete', body: { category: 'mcp' } })
if (delCfg.status !== 200 || delCfg.json.outcome !== 'hidden') throw new Error(`config delete should hide: ${delCfg.status} ${JSON.stringify(delCfg.json)}`)
const sumHidden = await call({ url: '/api/plugin-categories/summary' })
if (sumHidden.json.categories.some(group => group.id === 'mcp')) throw new Error('hidden group must disappear')
if (!sumHidden.json.hidden?.some(entry => entry.id === 'mcp')) throw new Error(`hidden list must carry mcp: ${JSON.stringify(sumHidden.json.hidden)}`)
const restore = await call({ method: 'POST', url: '/api/plugin-categories/restore', body: { category: 'mcp' } })
if (restore.status !== 200 || restore.json.outcome !== 'restored') throw new Error(`restore failed: ${restore.status} ${JSON.stringify(restore.json)}`)
const sumBack = await call({ url: '/api/plugin-categories/summary' })
if (!sumBack.json.categories.some(group => group.id === 'mcp')) throw new Error('restored group must come back')
const delNone = await call({ method: 'POST', url: '/api/plugin-categories/delete', body: { category: 'no-such-group' } })
if (delNone.status !== 200 || delNone.json.outcome !== 'not-found') throw new Error(`missing delete outcome: ${delNone.status} ${JSON.stringify(delNone.json)}`)

console.log('api-smoke: all assertions passed')
