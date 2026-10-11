// End-to-end smoke test of the built bundle against a mocked harness context.
// Covers: apply() registration, list grouping + skin detection (entry meta and
// bundle-description fallback), declarative categories (exact vs fuzzy),
// skinDetection:false semantics, assign persistence, set_category dry-run and
// real batch toggle, delete_category, and profile-directory probing.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply, resolveDataDirSync } from '../lib/index.js'

const dataDir = mkdtempSync(join(tmpdir(), 'curator-smoke-'))

const ENTRIES = [
  { entryId: 'ui-skin-qq2006', moduleName: '@dsh-external/dsh-qq2006', meta: { title: 'QQ2006 皮肤', description: 'QQ2006 skin for the WebUI' }, enabled: true, fiberPhase: 'active' },
  { entryId: 'my-skin', moduleName: '@dsh-external/my-skin', meta: { title: 'My Skin', description: '壁纸智能取色换肤方案' }, enabled: false, fiberPhase: null },
  { entryId: 'dsh-mcp-client', moduleName: '@deepseek-ai/dsh-mcp-client', meta: { title: 'MCP 客户端' }, enabled: true, fiberPhase: 'active' },
  { entryId: 'tool-memory', moduleName: '@dsh-external/dsh-memory', meta: { title: '长期记忆' }, enabled: false, fiberPhase: null },
]
const BUNDLES = [
  { name: '@dsh-external/dsh-qq2006', version: '0.1.2', rows: [{ rowId: 'ui-skin-qq2006', moduleName: '@dsh-external/dsh-qq2006', entryId: 'ui-skin-qq2006' }] },
]
const toggles = []
let registered

const ctx = {
  tools: { register(tool) { registered = tool } },
  pluginManager: {
    listPlugins: async () => ENTRIES,
    listBundles: async () => BUNDLES,
    setPluginEnabled: async (id, enabled) => { toggles.push([id, enabled]); return { changed: true, application: 'applied', stage: 'enable', target: id, enabled } },
  },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  get: () => undefined,
}

apply(ctx, { dataDir })
if (registered?.name !== 'plugin_categories') throw new Error(`tool not registered: ${registered?.name}`)

const run = args => registered.execute(args, { callId: 'smoke', signal: new AbortController().signal })

// 1. list: skins auto-detected, others uncategorized, bundle info enriched.
const listed = JSON.parse(await run({ action: 'list' }))
const byId = Object.fromEntries(listed.categories.map(group => [group.id, group]))
if (byId.skin.members.length !== 2) throw new Error(`expected 2 skins, got ${byId.skin.members.map(m => m.key)}`)
const qq = byId.skin.members.find(row => row.key === '@dsh-external/dsh-qq2006')
if (qq.evidence === undefined) throw new Error('missing skin evidence')
if (qq.bundle !== '@dsh-external/dsh-qq2006@0.1.2') throw new Error(`bundle enrichment failed: ${qq.bundle}`)
if (!byId.uncategorized.members.some(row => row.key === '@dsh-external/dsh-memory')) throw new Error('memory plugin should be uncategorized')

// 2. assign: create a custom category at assign time and persist it.
const assigned = JSON.parse(await run({ action: 'assign', category: 'retro-skins', label: '复古皮肤', createIfMissing: true, plugins: ['@dsh-external/dsh-qq2006'] }))
if (assigned.assigned.length !== 1 || assigned.unknown.length !== 0) throw new Error(`assign failed: ${JSON.stringify(assigned)}`)
const relisted = JSON.parse(await run({ action: 'list' }))
const retro = relisted.categories.find(group => group.id === 'retro-skins')
if (retro?.members.length !== 1 || retro.label !== '复古皮肤') throw new Error(`custom category not applied: ${JSON.stringify(relisted.categories.map(g => g.id))}`)
if (JSON.parse(readFileSync(join(dataDir, 'assignments.json'), 'utf8')).assignments['@dsh-external/dsh-qq2006'] !== 'retro-skins') throw new Error('assignment not persisted')

// 3. set_category dry-run: the remaining skin (my-skin starts disabled → would be enabled).
const dry = JSON.parse(await run({ action: 'set_category', category: 'skin', enabled: true, dryRun: true }))
if (dry.dryRun !== true || dry.plan.length !== 1 || dry.plan[0].key !== '@dsh-external/my-skin') throw new Error(`dry run plan wrong: ${JSON.stringify(dry)}`)
if (toggles.length !== 0) throw new Error('dry run must not toggle')

// 4. set_category for real.
const real = JSON.parse(await run({ action: 'set_category', category: 'skin', enabled: true }))
if (real.changed !== 1 || real.failed !== 0 || toggles.length !== 1 || toggles[0][1] !== true) throw new Error(`batch toggle failed: ${JSON.stringify({ real, toggles })}`)

// 5. unknown plugin key is reported, not thrown.
const partial = JSON.parse(await run({ action: 'assign', category: 'tools', createIfMissing: true, plugins: ['@dsh-external/dsh-memory', 'no-such-plugin'] }))
if (partial.assigned.length !== 1 || partial.unknown[0] !== 'no-such-plugin') throw new Error(`partial assign wrong: ${JSON.stringify(partial)}`)

// 6. delete_category moves members out.
const deleted = JSON.parse(await run({ action: 'delete_category', category: 'tools' }))
if (deleted.outcome !== 'removed') throw new Error(`delete failed: ${JSON.stringify(deleted)}`)
if (JSON.parse(readFileSync(join(dataDir, 'assignments.json'), 'utf8')).assignments['@dsh-external/dsh-memory'] !== undefined) throw new Error('member not unassigned')

// 7. Data-dir probing: a bundle's own package root (ships cordis.patch.yml,
//    declares dsh.bundle) must not match; a manifest with dsh.profile does.
const tree = mkdtempSync(join(tmpdir(), 'curator-probe-'))
const bundleRoot = join(tree, 'node_modules', '@dsh-external', 'dsh-plugin-categories')
mkdirSync(bundleRoot, { recursive: true })
writeFileSync(join(bundleRoot, 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-plugin-categories', dsh: { bundle: {} } }))
writeFileSync(join(bundleRoot, 'cordis.patch.yml'), '- insert: []\n')
const bundleProbe = resolveDataDirSync({}, pathToFileURL(join(bundleRoot, 'lib', 'index.js')).href)
if (bundleProbe.startsWith(bundleRoot)) throw new Error(`bundle root must not match: ${bundleProbe}`)
const profileDir = join(tree, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
const probed = resolveDataDirSync({}, pathToFileURL(join(profileDir, 'node_modules', '@dsh-external', 'dsh-plugin-categories', 'lib', 'index.js')).href)
if (!probed.endsWith('.plugin-categories') || !probed.startsWith(profileDir)) throw new Error(`profile probe failed: ${probed}`)
// 7b. A profile that only holds cordis.patch.yml (no dsh.profile key yet) still matches.
const patchOnly = join(tree, 'profiles', 'fresh')
mkdirSync(patchOnly, { recursive: true })
writeFileSync(join(patchOnly, 'cordis.patch.yml'), '- insert: []\n')
const probed2 = resolveDataDirSync({}, pathToFileURL(join(patchOnly, 'bundle', 'lib', 'index.js')).href)
if (!probed2.startsWith(patchOnly)) throw new Error(`patch-only profile probe failed: ${probed2}`)

// 7c. homedir fallback lands on the current name and migrates data written
//     under the legacy (pre-rename) directory exactly once.
const home = mkdtempSync(join(tmpdir(), 'curator-home-'))
mkdirSync(join(home, '.dsh-plugin-curator'), { recursive: true })
writeFileSync(join(home, '.dsh-plugin-curator', 'assignments.json'),
  JSON.stringify({ version: 1, assignments: { 'a/b': 'legacy-cat' }, categories: [] }))
const plainLib = join(home, 'plain', 'lib')
mkdirSync(plainLib, { recursive: true })
const prevHome = process.env.USERPROFILE
process.env.USERPROFILE = home
let homedirProbe, migrated
try {
  homedirProbe = resolveDataDirSync({}, pathToFileURL(join(plainLib, 'index.js')).href)
  migrated = JSON.parse(readFileSync(join(homedirProbe, 'assignments.json'), 'utf8'))
} finally {
  process.env.USERPROFILE = prevHome
}
if (!homedirProbe.endsWith('.dsh-plugin-categories')) throw new Error(`homedir fallback wrong: ${homedirProbe}`)
if (migrated.assignments['a/b'] !== 'legacy-cat') throw new Error(`legacy data not migrated: ${homedirProbe}`)

// 8. Declarative categories: `plugins` matches exactly (no substring bleed),
//    `namePattern` is the fuzzy path; skin detection off keeps explicit
//    skinPlugins and pre-existing `skin` assignments working.
const dataDir2 = mkdtempSync(join(tmpdir(), 'curator-smoke2-'))
const ENTRIES2 = [
  { entryId: 'mcp-x', moduleName: 'mcp-x', meta: {}, enabled: true, fiberPhase: 'active' },
  { entryId: 'proxy-row', moduleName: '@ext/mcp-proxy', meta: {}, enabled: true, fiberPhase: 'active' },
  { entryId: 'plain', moduleName: '@ext/plain', meta: {}, enabled: true, fiberPhase: 'active' },
  { entryId: 'pinned-skin', moduleName: '@ext/dark-armor', meta: {}, enabled: true, fiberPhase: 'active' },
  { entryId: 'assigned-skin', moduleName: '@ext/quiet', meta: {}, enabled: true, fiberPhase: 'active' },
]
const storeFile2 = join(dataDir2, 'assignments.json')
mkdirSync(dataDir2, { recursive: true })
writeFileSync(storeFile2, JSON.stringify({ version: 1, assignments: { '@ext/quiet': 'skin' }, categories: [] }))
let registered2
const ctx2 = {
  tools: { register(tool) { registered2 = tool } },
  pluginManager: {
    listPlugins: async () => ENTRIES2,
    listBundles: async () => BUNDLES2,
    setPluginEnabled: async () => { throw new Error('not expected here') },
  },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  get: () => undefined,
}
const config2 = {
  dataDir: dataDir2,
  skinDetection: false,
  skinPlugins: ['pinned-skin'],
  categories: [
    { id: 'mcp', label: 'MCP', plugins: ['mcp-x'] },
    { id: 'net', label: '网络', namePattern: 'proxy' },
  ],
}
apply(ctx2, config2)
const listed2 = JSON.parse(await registered2.execute({ action: 'list' }, { callId: 'smoke2', signal: new AbortController().signal }))
const byId2 = Object.fromEntries(listed2.categories.map(group => [group.id, group]))
if (byId2.mcp.members.length !== 1 || byId2.mcp.members[0].key !== 'mcp-x') throw new Error(`exact plugins match failed: ${JSON.stringify(byId2.mcp.members)}`)
if (byId2.net.members.length !== 1 || byId2.net.members[0].key !== '@ext/mcp-proxy') throw new Error(`namePattern match failed: ${JSON.stringify(byId2.net.members)}`)
if (byId2.skin?.members.map(m => m.key).sort().join() !== '@ext/dark-armor,@ext/quiet') {
  throw new Error(`skin group wrong under detection off: ${JSON.stringify(byId2.skin?.members)}`)
}
const quiet = byId2.skin.members.find(m => m.key === '@ext/quiet')
if (quiet.evidence !== undefined) throw new Error('assigned-skin should carry no auto evidence')
if (byId2.uncategorized.members.map(m => m.key).join() !== '@ext/plain') {
  throw new Error(`uncategorized wrong: ${JSON.stringify(byId2.uncategorized.members)}`)
}

// 9. Bundle-description fallback: with detection ON and no entry meta at all
//    (older DSH builds), the bundle's own description still drives detection.
const dataDir3 = mkdtempSync(join(tmpdir(), 'curator-smoke3-'))
const ENTRIES3 = [{ entryId: 'looks', moduleName: '@ext/looks', meta: {}, enabled: true, fiberPhase: 'active' }]
const BUNDLES3 = [
  { name: '@ext/looks', version: '1.0', description: 'A pastel skin for the WebUI', rows: [{ rowId: 'looks', moduleName: '@ext/looks', entryId: 'looks' }] },
]
let registered3
const ctx3 = {
  tools: { register(tool) { registered3 = tool } },
  pluginManager: {
    listPlugins: async () => ENTRIES3,
    listBundles: async () => BUNDLES3,
    setPluginEnabled: async () => { throw new Error('not expected here') },
  },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  get: () => undefined,
}
apply(ctx3, { dataDir: dataDir3 })
const listed3 = JSON.parse(await registered3.execute({ action: 'list' }, { callId: 'smoke3', signal: new AbortController().signal }))
const skin3 = listed3.categories.find(group => group.id === 'skin')
if (skin3?.members.length !== 1 || skin3.members[0].key !== '@ext/looks') throw new Error(`bundle-description detection failed: ${JSON.stringify(listed3.categories)}`)
if (!skin3.members[0].evidence?.[0]?.includes('skin')) throw new Error(`evidence should cite the keyword: ${JSON.stringify(skin3.members[0].evidence)}`)

// 10. set_plugin: flip one plugin, refuse unknown keys, and no-op when the
//     row already sits in the requested state (no escalation for a no-op).
const execOpts = { callId: 'smoke-set-plugin', signal: new AbortController().signal }
const single = JSON.parse(await registered.execute({ action: 'set_plugin', plugin: '@dsh-external/my-skin', enabled: true }, execOpts))
if (single.plugin !== '@dsh-external/my-skin' || single.changed !== 1 || single.failed !== 0 || single.application !== 'applied') {
  throw new Error(`set_plugin failed: ${JSON.stringify(single)}`)
}
if (toggles.length !== 2 || toggles[1][1] !== true) throw new Error(`set_plugin did not reach the manager: ${JSON.stringify(toggles)}`)
const noop = JSON.parse(await registered.execute({ action: 'set_plugin', plugin: '@dsh-external/my-skin', enabled: false }, execOpts))
if (noop.application !== 'unchanged' || noop.changed !== 0) throw new Error(`noop path wrong: ${JSON.stringify(noop)}`)
if (toggles.length !== 2) throw new Error('noop must not call setPluginEnabled')
let unknownThrew = false
try { await registered.execute({ action: 'set_plugin', plugin: 'no-such-plugin', enabled: true }, execOpts) } catch { unknownThrew = true }
if (!unknownThrew) throw new Error('set_plugin on an unknown key must throw')

// 11. reorder: group order and member order persist into `list`; unknown ids,
//     duplicates, and foreign member keys are rejected.
// Give retro-skins two members first (step 2 moved qq2006 there; my-skin is
// the only one left in `skin`).
await registered.execute({ action: 'assign', category: 'retro-skins', plugins: ['@dsh-external/my-skin'] }, execOpts)
const list0 = JSON.parse(await registered.execute({ action: 'list' }, execOpts))
const ids0 = list0.categories.map(group => group.id)
const reversedGroups = [...ids0].reverse()
const reoGroups = JSON.parse(await registered.execute({ action: 'reorder', kind: 'groups', ids: reversedGroups }, execOpts))
if (reoGroups.saved !== reversedGroups.length) throw new Error(`group reorder failed: ${JSON.stringify(reoGroups)}`)
const list1 = JSON.parse(await registered.execute({ action: 'list' }, execOpts))
if (list1.categories.map(group => group.id).join('|') !== reversedGroups.join('|')) {
  throw new Error(`group order not applied: ${list1.categories.map(group => group.id)}`)
}
const retroGroup = list1.categories.find(group => group.id === 'retro-skins')
if (retroGroup === undefined || retroGroup.members.length !== 2) throw new Error(`retro-skins should hold 2: ${JSON.stringify(retroGroup)}`)
const reversedMembers = [...retroGroup.members.map(row => row.key)].reverse()
const reoMembers = JSON.parse(await registered.execute({ action: 'reorder', kind: 'members', category: 'retro-skins', ids: reversedMembers }, execOpts))
if (reoMembers.saved !== 2) throw new Error(`member reorder failed: ${JSON.stringify(reoMembers)}`)
const list2 = JSON.parse(await registered.execute({ action: 'list' }, execOpts))
const retroAfter = list2.categories.find(group => group.id === 'retro-skins')
if (retroAfter.members.map(row => row.key).join('|') !== reversedMembers.join('|')) {
  throw new Error(`member order not applied: ${retroAfter.members.map(row => row.key)}`)
}
let orderThrew = 0
try { await registered.execute({ action: 'reorder', kind: 'groups', ids: [ids0[0], ids0[0]] }, execOpts) } catch { orderThrew += 1 }
try { await registered.execute({ action: 'reorder', kind: 'groups', ids: ['no-such-group'] }, execOpts) } catch { orderThrew += 1 }
try { await registered.execute({ action: 'reorder', kind: 'members', category: 'retro-skins', ids: ['@dsh-external/dsh-memory'] }, execOpts) } catch { orderThrew += 1 }
if (orderThrew !== 3) throw new Error(`reorder validation wrong: ${orderThrew}/3 threw`)

// 12. The plugin's own shipped cordis.patch.yml must route framework rows the
//     way the panel documents: every @deepseek-ai/* (including
//     dsh-user-questions) into 官方内置 — the official pattern outranks the
//     skin heuristic — cordis:* into 内核组件, user plugins into 未分类.
const ownPatch = createRequire(import.meta.url)('js-yaml')
  .load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'))
const ownConfig = ownPatch[0].insert[0].config
const ENTRIES4 = [
  { entryId: 'include:user-questions', moduleName: '@deepseek-ai/dsh-user-questions', meta: { title: '用户提问' }, enabled: true, fiberPhase: 'active' },
  { entryId: 'include', moduleName: 'cordis:include', meta: {}, enabled: true, fiberPhase: 'active' },
  { entryId: 'ui-theme', moduleName: '@deepseek-ai/dsh-client-ui-theme', meta: { title: '主题' }, enabled: true, fiberPhase: 'active' },
  { entryId: 'mine', moduleName: '@dsh-external/my-thing', meta: {}, enabled: true, fiberPhase: 'active' },
]
let registered4
const ctx4 = {
  tools: { register(tool) { registered4 = tool } },
  pluginManager: {
    listPlugins: async () => ENTRIES4,
    listBundles: async () => [],
    setPluginEnabled: async () => { throw new Error('not expected here') },
  },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  get: () => undefined,
}
apply(ctx4, { dataDir: mkdtempSync(join(tmpdir(), 'curator-real-')), ...ownConfig })
const listed4 = JSON.parse(await registered4.execute({ action: 'list' }, { callId: 'smoke-real-config', signal: new AbortController().signal }))
const at4 = id => (listed4.categories.find(group => group.id === id)?.members ?? []).map(member => member.key)
if (!at4('official').includes('@deepseek-ai/dsh-user-questions')) {
  throw new Error(`dsh-user-questions must land in 官方内置: ${JSON.stringify(listed4.categories.map(group => [group.id, group.members.map(m => m.key)]))}`)
}
if (!at4('kernel').includes('cordis:include')) throw new Error(`cordis:include must land in 内核组件: ${JSON.stringify(at4('kernel'))}`)
if (!at4('official').includes('@deepseek-ai/dsh-client-ui-theme')) {
  throw new Error('official pattern must outrank the skin heuristic')
}
if (!at4('uncategorized').includes('@dsh-external/my-thing')) throw new Error('user plugin must land in 未分类')

// 13. Builtin protections: renaming 未分类 must keep it a fallback row (no
//     delete button in the panel), and the server must still refuse deletion.
await registered.execute({ action: 'create_category', category: 'uncategorized', label: '我的杂项' }, execOpts)
const list13 = JSON.parse(await registered.execute({ action: 'list' }, execOpts))
const uncat13 = list13.categories.find(group => group.id === 'uncategorized')
if (uncat13?.source !== 'fallback') throw new Error(`renamed builtin must stay fallback: ${JSON.stringify(uncat13)}`)
if (uncat13.label !== '我的杂项') throw new Error(`renamed builtin label must apply: ${uncat13.label}`)
const del13 = JSON.parse(await registered.execute({ action: 'delete_category', category: 'uncategorized' }, execOpts))
if (del13.outcome !== 'refused') throw new Error(`builtin delete must be refused: ${JSON.stringify(del13)}`)

// 14. Config groups are hidden, not deleted: members rejoin the remaining
//     rules, the summary carries the hidden list, and restore brings the group
//     (with its members and label) back.
const delMcp = JSON.parse(await registered2.execute({ action: 'delete_category', category: 'mcp' }, execOpts))
if (delMcp.outcome !== 'hidden') throw new Error(`config delete should hide: ${JSON.stringify(delMcp)}`)
const afterHide = JSON.parse(await registered2.execute({ action: 'list' }, execOpts))
if (afterHide.categories.some(group => group.id === 'mcp')) throw new Error('hidden group must disappear from the list')
if (!afterHide.hidden?.some(entry => entry.id === 'mcp')) throw new Error(`hidden list must carry mcp: ${JSON.stringify(afterHide.hidden)}`)
const uncat14 = afterHide.categories.find(group => group.id === 'uncategorized')
if (!uncat14.members.some(member => member.key === 'mcp-x')) {
  throw new Error(`exact-matched member must rejoin 未分类 when its group hides: ${JSON.stringify(uncat14.members)}`)
}
const restored14 = JSON.parse(await registered2.execute({ action: 'restore_category', category: 'mcp' }, execOpts))
if (restored14.outcome !== 'restored') throw new Error(`restore failed: ${JSON.stringify(restored14)}`)
const afterRestore = JSON.parse(await registered2.execute({ action: 'list' }, execOpts))
const mcp14 = afterRestore.categories.find(group => group.id === 'mcp')
if (mcp14 === undefined || mcp14.label !== 'MCP') throw new Error(`restored group wrong: ${JSON.stringify(mcp14)}`)
if (!mcp14.members.some(member => member.key === 'mcp-x')) throw new Error('restored group must claim its member again')
if ((afterRestore.hidden ?? []).some(entry => entry.id === 'mcp')) throw new Error('mcp must leave the hidden list')
const restoreMissing = JSON.parse(await registered2.execute({ action: 'restore_category', category: 'mcp' }, execOpts))
if (restoreMissing.outcome !== 'not-found') throw new Error(`restoring a visible group must be not-found: ${JSON.stringify(restoreMissing)}`)

console.log('smoke: all assertions passed')
