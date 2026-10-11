/** Shared category operations: inventory projection, grouping, persistence, and
 * the batch-toggle plan/apply split.
 *
 * The agent tool (`src/tool.ts`) and the browser API (`src/api.ts`) both run
 * through these functions so their results cannot drift apart: `list` over HTTP
 * shows exactly what the `list` action reports, and a category toggled from the
 * settings panel is the same operation — with the same plan/apply semantics —
 * as the tool's, only behind a different permission gate (each side applies its
 * own: escalation for the tool, the HTTP trust fence for the panel).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PluginEntryId, PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import {
  buildGroups, deleteCategory, detectSkinEvidence, loadStore, pickText, saveStore,
  SKIN_CATEGORY, UNCATEGORIZED, upsertCategory, allCategories,
  type AssignmentStore, type CategoryGroup, type CategoriesConfig, type PluginRow,
} from './model.ts'

/** Bundle inventory rows, as `PluginManager.listBundles()` answers them. */
export type BundleList = Awaited<ReturnType<PluginManager['listBundles']>>

/** Live rows plus the loaded store — everything one operation needs. */
export interface LiveState {
  rows: PluginRow[]
  store: AssignmentStore
}

/** Arguments of the `assign` action (tool and HTTP body share this shape). */
export interface AssignArgs {
  category?: string
  plugins?: string[]
  createIfMissing?: boolean
  label?: string
}

/** Arguments of `create_category` / `delete_category`. */
export interface CategoryArgs {
  category?: string
  label?: string
}

/** Arguments of `set_category`. */
export interface SetCategoryArgs {
  category?: string
  enabled?: boolean
  dryRun?: boolean
}

/**
 * Probe a service the fiber did not name in `inject`.
 *
 * Direct property access (`ctx.pluginManager`) inside the real cordis proxy
 * throws `cannot get property "…" without inject` for services outside the
 * fiber's inject/ancestor chain — a TS `| undefined` cast cannot make that
 * safe. `ctx.get(name)` is cordis's documented lookup "without the inject
 * requirement": it answers the service when provided (and its fiber active),
 * `undefined` otherwise. The guarded direct-access fallback exists for mock
 * contexts (the smoke suite) that stub `get` but expose services as plain
 * properties.
 */
export function probeService<T>(ctx: Context, name: string): T | undefined {
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined) return value as T
    }
  } catch { /* fall through to the direct-access fallback */ }
  try {
    return (ctx as unknown as Record<string, unknown>)[name] as T
  } catch {
    return undefined
  }
}

/** Structural view of one inventory entry. `meta` is optional because its
 * presence varies across DSH builds; access stays defensive at runtime. */
interface InventoryEntryLike {
  readonly entryId: PluginEntryId
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
  readonly meta?: { title?: unknown, description?: unknown } | undefined
  readonly readOnlyReason?: string
}

/** One live inventory row projected into the category model. */
function projectRows(entries: readonly InventoryEntryLike[], bundles: BundleList): PluginRow[] {
  const bundleOfEntry = new Map<string, { bundle: string, version?: string, description?: string }>()
  const bundleOfModule = new Map<string, { bundle: string, version?: string, description?: string }>()
  for (const bundle of bundles) {
    const source = { bundle: bundle.name, version: bundle.version, description: bundle.description }
    for (const row of bundle.rows) {
      if (row.entryId !== undefined) bundleOfEntry.set(row.entryId, source)
      bundleOfModule.set(row.moduleName, source)
    }
  }
  return entries.map(entry => {
    const source = bundleOfEntry.get(entry.entryId) ?? bundleOfModule.get(entry.moduleName)
    return {
      key: entry.moduleName,
      entryId: entry.entryId,
      moduleName: entry.moduleName,
      title: pickText(entry.meta?.title),
      description: pickText(entry.meta?.description) ?? source?.description,
      enabled: entry.enabled,
      fiberPhase: entry.fiberPhase,
      readOnlyReason: entry.readOnlyReason,
      bundle: source?.bundle,
      version: source?.version,
    }
  })
}

/** Resolve one user-named plugin key (moduleName, entry id, or bundle name) to a row. */
function findRow(rows: readonly PluginRow[], key: string): PluginRow | undefined {
  const needle = key.toLowerCase()
  return rows.find(row =>
    row.key.toLowerCase() === needle
    || row.entryId?.toLowerCase() === needle
    || row.bundle?.toLowerCase() === needle)
}

/** Read the live inventory and the assignment store in one round. */
export async function loadLive(manager: PluginManager, storeFile: string): Promise<LiveState> {
  const [entries, bundleList] = await Promise.all([
    manager.listPlugins(),
    manager.listBundles().catch(() => [] as BundleList),
  ])
  const rows = projectRows(entries, bundleList)
  const store = await loadStore(storeFile)
  return { rows, store }
}

/** Uncategorized rows that look like skins, surfaced as one-click suggestions. */
function buildSkinSuggestions(rows: readonly PluginRow[], config: CategoriesConfig): Record<string, string[]> {
  const suggestions: Record<string, string[]> = {}
  for (const row of rows) {
    const evidence = detectSkinEvidence(row, config)
    if (evidence.length > 0) suggestions[row.key] = evidence
  }
  return suggestions
}

/** Order items by a persisted id list (drag reorder): listed ids come first in
 * that exact order; unlisted/new items keep their build order after them.
 * Stale ids in the order list are ignored. */
function applyOrder<T>(items: readonly T[], order: readonly string[] | undefined, keyOf: (item: T) => string): T[] {
  if (order === undefined || order.length === 0) return [...items]
  const rank = new Map(order.map((id, index) => [id, index]))
  const ordered = items.filter(item => rank.has(keyOf(item)))
    .sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0))
  const rest = items.filter(item => !rank.has(keyOf(item)))
  return [...ordered, ...rest]
}

/** The `list` result: grouped categories with member detail and suggestions. */
export function listResult(state: LiveState, config: CategoriesConfig, storeFile: string) {
  const { rows, store } = state
  const groups = applyOrder(buildGroups(rows, config, store), store.groupOrder, group => group.id)
    .map(group => ({ ...group, members: applyOrder(group.members, store.memberOrder?.[group.id], row => row.key) }))
  const uncategorized = new Set(
    groups.find(group => group.id === UNCATEGORIZED)?.members.map(row => row.key) ?? [])
  const definitions = allCategories(config, store)
  return {
    dataFile: storeFile,
    /** Dismissed groups with their (config/renamed) labels, for the restore bar. */
    hidden: (store.hidden ?? []).map(id => ({
      id,
      label: definitions.find(entry => entry.id === id)?.label ?? id,
    })),
    categories: groups.map(group => ({
      id: group.id,
      label: group.label,
      source: group.source,
      size: group.members.length,
      members: group.members.map(row => ({
        key: row.key,
        entryId: row.entryId,
        title: row.title,
        bundle: row.bundle === undefined ? undefined : `${row.bundle}${row.version === undefined ? '' : `@${row.version}`}`,
        enabled: row.enabled,
        phase: row.fiberPhase,
        readOnly: row.readOnlyReason,
        evidence: group.evidence?.[row.key],
      })),
    })),
    suggestedForUncategorized: buildSkinSuggestions(
      rows.filter(row => uncategorized.has(row.key)), config),
  }
}

/** Assign plugin keys to a category, persisting the store. */
export async function assignResult(state: LiveState, config: CategoriesConfig, storeFile: string, args: AssignArgs) {
  const { rows, store } = state
  if (args.category === undefined || args.plugins === undefined || args.plugins.length === 0) {
    throw new Error('category and a non-empty plugins list are required')
  }
  const known = allCategories(config, store).map(c => c.id)
  if (!known.includes(args.category)) {
    if (args.createIfMissing === true && args.category !== UNCATEGORIZED) {
      upsertCategory(store, args.category, args.label)
    } else {
      throw new Error(`Unknown category "${args.category}". Known: ${known.join(', ')}. Pass createIfMissing to add it.`)
    }
  }
  const assigned: string[] = []
  const unknown: string[] = []
  for (const key of args.plugins) {
    const row = findRow(rows, key)
    if (row === undefined) { unknown.push(key); continue }
    if (args.category === UNCATEGORIZED) delete store.assignments[row.key]
    else store.assignments[row.key] = args.category
    assigned.push(row.key)
  }
  await saveStore(storeFile, store)
  return { category: args.category, assigned, unknown,
    note: unknown.length > 0 ? 'unknown keys were skipped; copy keys from `list` output' : undefined }
}

/** Create (or relabel) a runtime category, persisting the store. */
export async function createResult(state: LiveState, config: CategoriesConfig, storeFile: string, args: CategoryArgs) {
  if (args.category === undefined) throw new Error('category is required')
  const created = upsertCategory(state.store, args.category, args.label)
  await saveStore(storeFile, state.store)
  return { created: created.id, label: created.label, knownCategories: allCategories(config, state.store).map(c => c.id) }
}

/**
 * Delete a runtime category, or DISMISS a config/builtin one.
 *
 * - `uncategorized` → `refused` (structural bucket; never goes away);
 * - config-declared / skin → `hidden`: the group leaves the panel, its exact
 *   keys and namePatterns stop claiming rows (members rejoin the remaining
 *   rules), and `restore_category` brings it back;
 * - custom → `removed`: the group and its assignments are gone for good.
 */
export async function deleteResult(state: LiveState, config: CategoriesConfig, storeFile: string, args: CategoryArgs) {
  if (args.category === undefined) throw new Error('category is required')
  const id = args.category
  if (id === UNCATEGORIZED) {
    return { category: id, outcome: 'refused', note: 'uncategorized is structural and cannot be deleted or hidden' }
  }
  const declared = (config.categories ?? []).some(category => category.id === id)
  if (declared || id === SKIN_CATEGORY) {
    state.store.hidden = [...new Set([...(state.store.hidden ?? []), id])]
    await saveStore(storeFile, state.store)
    return { category: id, outcome: 'hidden', note: 'members rejoin the remaining rules; restore from the hidden bar' }
  }
  const outcome = deleteCategory(state.store, config, id)
  if (outcome === 'removed') await saveStore(storeFile, state.store)
  return { category: id, outcome,
    note: outcome === 'removed' ? 'members moved to uncategorized' : undefined }
}

/** Bring a hidden (config/builtin) category back to the panel. */
export async function restoreResult(state: LiveState, storeFile: string, args: CategoryArgs) {
  if (args.category === undefined) throw new Error('category is required')
  const hidden = state.store.hidden ?? []
  if (!hidden.includes(args.category)) {
    return { category: args.category, outcome: 'not-found', note: 'category is not hidden' }
  }
  state.store.hidden = hidden.filter(id => id !== args.category)
  await saveStore(storeFile, state.store)
  return { category: args.category, outcome: 'restored' }
}

/** Members of a category that are not yet in the requested state, plus the
 * wire plan for a dry run. Throws for an unknown category. */
export function planSetCategory(state: LiveState, config: CategoriesConfig, args: SetCategoryArgs) {
  if (args.category === undefined || args.enabled === undefined) throw new Error('category and enabled are required')
  const group = buildGroups(state.rows, config, state.store).find(candidate => candidate.id === args.category)
  if (group === undefined) throw new Error(`Unknown category "${args.category}". Call list first.`)
  const enabled = args.enabled
  const todo = group.members.filter(row => row.enabled !== enabled)
  const plan = todo.map(row => ({
    key: row.key, entryId: row.entryId, enabled,
    blocked: row.readOnlyReason === undefined && row.entryId === undefined ? 'no entry id' : row.readOnlyReason,
  }))
  return { group, todo, plan, enabled }
}

/** Dry-run result: what a real toggle would change. */
export function drySetResult(group: CategoryGroup, todo: readonly PluginRow[], plan: readonly object[]) {
  return { category: group.id, dryRun: true, alreadyInState: group.members.length - todo.length, plan }
}

/** Nothing to change — every member is already in the requested state. */
export function emptySetResult(group: CategoryGroup) {
  return { category: group.id, application: 'applied', changed: 0, note: 'every member is already in the requested state' }
}

/** Apply a prepared plan: flip every member through the plugin manager.
 * The caller owns the permission gate (tool: escalation; HTTP: trust fence). */
export async function applySetCategory(manager: PluginManager, category: string, enabled: boolean, todo: readonly PluginRow[]) {
  const results = []
  for (const row of todo) {
    if (row.readOnlyReason !== undefined) { results.push({ key: row.key, ok: false, error: `read-only: ${row.readOnlyReason}` }); continue }
    if (row.entryId === undefined) { results.push({ key: row.key, ok: false, error: 'no entry id' }); continue }
    try {
      // entryId came from the manager itself, so the branded cast is sound.
      const change = await manager.setPluginEnabled(row.entryId as PluginEntryId, enabled)
      results.push({ key: row.key, ok: true, application: change.application, error: change.error?.diagnostic })
    } catch (error) {
      results.push({ key: row.key, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const failed = results.filter(result => !result.ok).length
  return { category, changed: results.length - failed, failed,
    application: failed === 0 ? 'applied' : 'partial',
    results }
}

/** Arguments of the `set_plugin` action (one plugin, one flip). */
export interface SetPluginArgs {
  plugin?: string
  enabled?: boolean
}

/**
 * Validate one single-plugin flip. Throws for unknown keys and immutable rows
 * so the caller can gate escalation/write on a real change only; `noop` says
 * the row already sits in the requested state (no write, no approval needed).
 */
export function prepareSetPlugin(state: LiveState, args: SetPluginArgs) {
  if (args.plugin === undefined || args.enabled === undefined) throw new Error('plugin and enabled are required')
  const row = findRow(state.rows, args.plugin)
  if (row === undefined) throw new Error(`Unknown plugin "${args.plugin}". Call \`list\` to see keys.`)
  if (row.readOnlyReason !== undefined) throw new Error(`read-only: ${row.readOnlyReason}`)
  if (row.entryId === undefined) throw new Error('no entry id')
  return { row, enabled: args.enabled, noop: row.enabled === args.enabled }
}

/** The `set_plugin` no-change answer, shared by the tool and the HTTP route. */
export function unchangedSetPlugin(row: PluginRow) {
  return { plugin: row.key, changed: 0, failed: 0, application: 'unchanged', note: 'already in the requested state' }
}

/** Apply one validated flip through the plugin manager. The caller owns the
 * permission gate (tool: escalation; HTTP: trust fence). */
export async function applySetPlugin(manager: PluginManager, row: PluginRow, enabled: boolean) {
  try {
    // entryId came from the manager itself, so the branded cast is sound.
    const change = await manager.setPluginEnabled(row.entryId as PluginEntryId, enabled)
    return {
      plugin: row.key, changed: 1, failed: 0, application: change.application,
      ...change.error?.diagnostic === undefined ? {} : { error: change.error.diagnostic },
    }
  } catch (error) {
    return {
      plugin: row.key, changed: 0, failed: 1, application: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Arguments of the `reorder` action (drag-and-drop persistence). */
export interface ReorderArgs {
  /** `groups` = category ids; `members` = plugin keys (needs `category`). */
  kind?: string
  category?: string
  ids?: string[]
}

/**
 * Persist a drag-reordered id list. Like `assign`, this only touches the
 * plugin's own assignments file — cosmetic state, so no escalation gate
 * (profile composition writes are the `set_*` actions' concern).
 *
 * The list is validated against the CURRENT structure (known ids only, no
 * duplicates) but need not be exhaustive: ids left out keep their build order
 * after the ordered ones, which is what makes a newly created group or a newly
 * assigned member show up without touching the stored order.
 */
export async function reorderResult(state: LiveState, config: CategoriesConfig, storeFile: string, args: ReorderArgs) {
  if (args.kind !== 'groups' && args.kind !== 'members') throw new Error('kind must be "groups" or "members"')
  if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.some(id => typeof id !== 'string' || id === '')) {
    throw new Error('ids must be a non-empty array of strings')
  }
  if (new Set(args.ids).size !== args.ids.length) throw new Error('ids contains duplicates')
  const groups = buildGroups(state.rows, config, state.store)
  if (args.kind === 'groups') {
    const known = new Set(groups.map(group => group.id))
    const unknown = args.ids.filter(id => !known.has(id))
    if (unknown.length > 0) throw new Error(`unknown categories: ${unknown.join(', ')}. Call list first.`)
    state.store.groupOrder = [...args.ids]
  } else {
    if (args.category === undefined) throw new Error('category is required when kind is "members"')
    const group = groups.find(candidate => candidate.id === args.category)
    if (group === undefined) throw new Error(`Unknown category "${args.category}". Call list first.`)
    const members = new Set(group.members.map(row => row.key))
    const foreign = args.ids.filter(key => !members.has(key))
    if (foreign.length > 0) throw new Error(`not members of "${args.category}": ${foreign.join(', ')}`)
    state.store.memberOrder = { ...state.store.memberOrder, [args.category]: [...args.ids] }
  }
  await saveStore(storeFile, state.store)
  return {
    kind: args.kind, ...args.category === undefined ? {} : { category: args.category },
    saved: args.ids.length,
  }
}
