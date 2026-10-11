/** Pure categorization model: skin detection, grouping, and assignment persistence.
 *
 * Kept free of DSH imports so it can be unit-tested against plain row objects.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CategoryDef {
  /** Stable category id used in assignments. */
  id: string
  /** Display label. */
  label: string
  /** Plugin keys (moduleName, entry id, or bundle name) always in this category. */
  plugins?: string[]
  /** Case-insensitive substring matched against moduleName, bundle, title, and description. */
  namePattern?: string
}

/** `Config` schema shape; see `src/index.ts` for the Schemastery projection. */
export interface CategoriesConfig {
  /** Directory holding `assignments.json`; probed from the profile layout when omitted. */
  dataDir?: string
  /** Auto-bucket plugins whose names or copy mention skins/themes. Default true. */
  skinDetection?: boolean
  /** Extra skin keywords beyond the built-in list. */
  skinKeywords?: string[]
  /** Plugin keys that are always skins, regardless of detection. */
  skinPlugins?: string[]
  /** Declarative categories; merged with runtime-created ones. */
  categories?: CategoryDef[]
}

export const SKIN_CATEGORY = 'skin'
export const UNCATEGORIZED = 'uncategorized'

export interface AssignmentStore {
  version: 1
  /** Plugin key → category id. */
  assignments: Record<string, string>
  /** Categories created at runtime through the tool. */
  categories: CategoryDef[]
  /** Display order of category ids (drag reorder). Stale ids are ignored at
   * render; ids not listed here keep their build order and append after the
   * ordered ones, so newly created groups still appear. */
  groupOrder?: string[]
  /** Display order of plugin keys per category id (drag reorder). Same rules:
   * unlisted members append after the ordered ones. */
  memberOrder?: Record<string, string[]>
  /** Groups dismissed from the panel (config/builtin "delete" = hide). Their
   * members rejoin the remaining rules; restore with `restore_category`. */
  hidden?: string[]
}

/** One manageable plugin row, projected from the plugin-manager inventory. */
export interface PluginRow {
  /** Assignment key: the exact module specifier (stable across restarts). */
  key: string
  entryId?: string
  moduleName: string
  title?: string
  description?: string
  enabled: boolean
  fiberPhase?: string | null
  readOnlyReason?: string
  bundle?: string
  version?: string
}

export interface CategoryGroup {
  id: string
  label: string
  /** Where the category came from. */
  source: 'config' | 'custom' | 'auto' | 'fallback'
  members: PluginRow[]
  /** Why each member sits in an `auto` category (skin evidence), keyed by plugin key. */
  evidence?: Record<string, string[]>
}

export function emptyStore(): AssignmentStore {
  return { version: 1, assignments: {}, categories: [] }
}

const DEFAULT_SKIN_KEYWORDS = ['skin', 'theme', '皮肤', '换肤', '主题', '外观']

/** Substrings matched against a row when applying skin heuristics. */
function rowText(row: PluginRow): string {
  return [row.key, row.entryId ?? '', row.bundle ?? '', row.title ?? '', row.description ?? '']
    .join('\n')
    .toLowerCase()
}

/** Why heuristics consider this row a skin; empty when it does not look like one.
 * The explicit `skinPlugins` list always applies; keyword matching respects
 * `skinDetection: false`. */
export function detectSkinEvidence(row: PluginRow, config: CategoriesConfig): string[] {
  const evidence: string[] = []
  const explicit = config.skinPlugins ?? []
  if (explicit.some(name => matchesKey(row, name))) {
    evidence.push('listed in config skinPlugins')
  }
  if (config.skinDetection === false) return evidence
  const keywords = [...DEFAULT_SKIN_KEYWORDS, ...(config.skinKeywords ?? [])]
  const text = rowText(row)
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      evidence.push(`name/copy contains "${keyword}"`)
      break
    }
  }
  return evidence
}

/** Whether one configured key names this row: moduleName, entry id, or bundle name. */
function matchesKey(row: PluginRow, key: string): boolean {
  const needle = key.toLowerCase()
  return [row.key, row.entryId ?? '', row.bundle ?? ''].some(actual => actual.toLowerCase() === needle)
}

function matchesPattern(row: PluginRow, pattern: string): boolean {
  return rowText(row).includes(pattern.toLowerCase())
}

/** All category ids that assignments may target: config, runtime, built-ins.
 * Membership rules (plugins / namePattern) always come from config, but a
 * runtime label written through `upsertCategory` overrides the config label —
 * renaming is presentation, not membership, so config-declared categories can
 * be renamed from the panel without editing the profile patch. */
export function allCategories(config: CategoriesConfig, store: AssignmentStore): CategoryDef[] {
  const merged = new Map<string, CategoryDef>()
  const runtimeLabel = new Map(store.categories.map(category => [category.id, category.label]))
  for (const category of config.categories ?? []) {
    const label = runtimeLabel.get(category.id)
    merged.set(category.id, label === undefined ? { ...category } : { ...category, label })
  }
  for (const category of store.categories) {
    if (!merged.has(category.id)) merged.set(category.id, { ...category })
  }
  if (!merged.has(SKIN_CATEGORY)) merged.set(SKIN_CATEGORY, { id: SKIN_CATEGORY, label: SKIN_CATEGORY })
  if (!merged.has(UNCATEGORIZED)) merged.set(UNCATEGORIZED, { id: UNCATEGORIZED, label: UNCATEGORIZED })
  return [...merged.values()]
}

/** Group every row into exactly one category. Rows never listed appear under `uncategorized`. */
export function buildGroups(rows: readonly PluginRow[], config: CategoriesConfig, store: AssignmentStore): CategoryGroup[] {
  const definitions = allCategories(config, store)
  const groups = new Map<string, CategoryGroup>()
  const push = (id: string, source: CategoryGroup['source'], label?: string) => {
    if (groups.has(id)) return
    const def = definitions.find(entry => entry.id === id)
    groups.set(id, { id, label: label ?? def?.label ?? id, source, members: [], evidence: {} })
  }
  // Hidden groups (panel dismiss) are excluded entirely: their exact keys and
  // namePatterns stop claiming rows, so members rejoin the remaining rules.
  // 未分类 is structural and can never be hidden (the delete route refuses it),
  // so it is filtered out of the set as a belt on top of that guard.
  const hidden = new Set((store.hidden ?? []).filter(id => id !== UNCATEGORIZED))
  for (const category of config.categories ?? []) {
    if (hidden.has(category.id)) continue
    push(category.id, 'config')
  }
  // Builtins own their source even when a store entry exists for them (the
  // rename path upserts into the store): a renamed 未分类/皮肤 must keep its
  // fallback/auto semantics and never read as a deletable "custom" row.
  for (const category of store.categories) {
    if (category.id === UNCATEGORIZED || category.id === SKIN_CATEGORY) continue
    if (hidden.has(category.id)) continue
    push(category.id, 'custom')
  }
  push(UNCATEGORIZED, 'fallback')

  // Exact keys from declarative categories; fuzzy matching is namePattern's job.
  const configCategoryOf = new Map<string, string>()
  for (const category of config.categories ?? []) {
    if (hidden.has(category.id)) continue
    for (const key of category.plugins ?? []) configCategoryOf.set(key.toLowerCase(), category.id)
  }

  // Skin evidence is computed once per row; keyword matching inside
  // detectSkinEvidence already respects `skinDetection: false`.
  const evidenceOf = new Map<string, string[]>()
  for (const row of rows) {
    const evidence = detectSkinEvidence(row, config)
    if (evidence.length > 0) evidenceOf.set(row.key, evidence)
  }
  // The skin group exists whenever detection is on, any row looks like a
  // skin, or an explicit assignment targets it — an assignment to `skin`
  // must survive `skinDetection: false`. A hidden skin group claims nothing.
  const skinRelevant = !hidden.has(SKIN_CATEGORY)
    && (config.skinDetection !== false
      || evidenceOf.size > 0
      || rows.some(row => store.assignments[row.key] === SKIN_CATEGORY))
  if (skinRelevant) push(SKIN_CATEGORY, 'auto')

  for (const row of rows) {
    let evidence: string[] = []
    let target: string | undefined
    const stored = store.assignments[row.key]
    if (stored !== undefined && groups.has(stored)) {
      target = stored
    } else {
      for (const [key, id] of configCategoryOf) {
        if (matchesKey(row, key)) { target = id; break }
      }
      if (target === undefined) {
        for (const category of config.categories ?? []) {
          if (hidden.has(category.id)) continue
          if (category.namePattern !== undefined && matchesPattern(row, category.namePattern)) {
            target = category.id
            break
          }
        }
      }
      if (target === undefined && evidenceOf.has(row.key)) {
        target = SKIN_CATEGORY
        evidence = evidenceOf.get(row.key)!
      }
    }
    // A stored assignment (or a raced target) naming a hidden/absent group
    // falls back to 未分类 rather than dropping the row from the panel.
    const group = groups.get(target ?? UNCATEGORIZED) ?? groups.get(UNCATEGORIZED)
    if (group === undefined) continue // unreachable: 未分类 is pushed above
    group.members.push(row)
    if (evidence.length > 0) group.evidence![row.key] = evidence
  }

  const ordered = [...groups.values()]
  for (const group of ordered) {
    if (Object.keys(group.evidence ?? {}).length === 0) delete group.evidence
  }
  return ordered
}

/** Create a runtime category; returns the existing one when the id is taken. */
export function upsertCategory(store: AssignmentStore, id: string, label?: string): CategoryDef {
  const existing = store.categories.find(category => category.id === id)
  if (existing) {
    if (label !== undefined && label !== existing.label) existing.label = label
    return existing
  }
  const created: CategoryDef = { id, label: label ?? id }
  store.categories.push(created)
  return created
}

/** Remove a runtime category and unassign its members. Config-defined ids are refused. */
export function deleteCategory(store: AssignmentStore, config: CategoriesConfig, id: string): 'removed' | 'not-found' | 'config-owned' {
  if ((config.categories ?? []).some(category => category.id === id)) return 'config-owned'
  if (id === SKIN_CATEGORY || id === UNCATEGORIZED) return 'config-owned'
  const index = store.categories.findIndex(category => category.id === id)
  if (index === -1) return 'not-found'
  store.categories.splice(index, 1)
  for (const [key, assigned] of Object.entries(store.assignments)) {
    if (assigned === id) delete store.assignments[key]
  }
  // Hygiene: drop the deleted group's order bookkeeping so a future group that
  // reuses the id does not inherit a stale position/member order.
  if (store.groupOrder !== undefined) store.groupOrder = store.groupOrder.filter(entry => entry !== id)
  if (store.memberOrder !== undefined) delete store.memberOrder[id]
  return 'removed'
}

/** Sanitize an untrusted `memberOrder` record: id → string[] only. */
function sanitizeMemberOrder(value: unknown): Record<string, string[]> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(value)) {
    if (Array.isArray(list) && list.every(item => typeof item === 'string')) out[key] = list as string[]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Read the assignment store; a missing or unreadable file yields an empty store. */
export async function loadStore(file: string): Promise<AssignmentStore> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return emptyStore()
  }
  try {
    const parsed = JSON.parse(raw) as AssignmentStore
    if (parsed.version !== 1 || typeof parsed.assignments !== 'object' || parsed.assignments === null) return emptyStore()
    const memberOrder = sanitizeMemberOrder(parsed.memberOrder)
    return {
      version: 1,
      assignments: parsed.assignments,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      ...Array.isArray(parsed.groupOrder) ? { groupOrder: parsed.groupOrder.filter(id => typeof id === 'string') } : {},
      ...memberOrder === undefined ? {} : { memberOrder },
      ...Array.isArray(parsed.hidden) ? { hidden: parsed.hidden.filter(id => typeof id === 'string' && id !== UNCATEGORIZED) } : {},
    }
  } catch {
    return emptyStore()
  }
}

/** Write the assignment store atomically (unique temp file + rename). */
export async function saveStore(file: string, store: AssignmentStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  // Two overlapping calls must not share a temp path (same-pid reentrancy).
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Where assignments live. Order: explicit `dataDir`, the profile directory
 * (found by walking up from the module location to the nearest ancestor that
 * declares a `dsh.profile` manifest key, or that holds a `cordis.patch.yml`
 * without declaring a bundle of its own — the bundle's own package root must
 * not match even though it ships a patch file), else `~/.dsh-plugin-categories/`.
 *
 * Earlier releases used differently-named directories. When the current
 * directory has no assignments yet but the legacy one does, the file is
 * copied forward once, so a rename never orphans existing categories.
 * Migration is best-effort: a failure must never block plugin boot.
 */
function migrateLegacyDataDir(current: string, legacy: string): string {
  if (current === legacy) return current
  try {
    const legacyFile = join(legacy, 'assignments.json')
    const currentFile = join(current, 'assignments.json')
    if (!existsSync(currentFile) && existsSync(legacyFile)) {
      mkdirSync(current, { recursive: true })
      copyFileSync(legacyFile, currentFile)
    }
  } catch {
    // Handled like a missing legacy dir: nothing to migrate.
  }
  return current
}

export function resolveDataDirSync(config: CategoriesConfig, moduleUrl: string): string {
  if (config.dataDir) return resolve(config.dataDir)
  let dir = fileURLToPath(new URL('.', moduleUrl))
  for (let depth = 0; dir && depth < 20; depth += 1) {
    let manifest: { dsh?: { profile?: unknown, bundle?: unknown } } | undefined
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      // No readable package.json here; the patch rule below still applies.
    }
    const declaresProfile = manifest?.dsh?.profile !== undefined
    const declaresBundle = manifest?.dsh?.bundle !== undefined
    const holdsPatch = existsSync(join(dir, 'cordis.patch.yml'))
    if (declaresProfile || (holdsPatch && !declaresBundle)) {
      return migrateLegacyDataDir(join(dir, '.plugin-categories'), join(dir, '.plugin-curator'))
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return migrateLegacyDataDir(join(homedir(), '.dsh-plugin-categories'), join(homedir(), '.dsh-plugin-curator'))
}

/** Flatten a DSH localized text value to one display string (zh first, then en, then any). */
export function pickText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, string>
    for (const locale of ['zh-CN', 'zh', 'en']) {
      if (typeof record[locale] === 'string') return record[locale]
    }
    const first = Object.values(record).find(entry => typeof entry === 'string')
    if (typeof first === 'string') return first
  }
  return undefined
}
