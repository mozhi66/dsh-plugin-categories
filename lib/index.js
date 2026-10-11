// src/index.ts
import { join as join2 } from "node:path";
import Schema from "@deepseek-ai/schemastery";

// src/tool.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/model.ts
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var SKIN_CATEGORY = "skin";
var UNCATEGORIZED = "uncategorized";
function emptyStore() {
  return { version: 1, assignments: {}, categories: [] };
}
var DEFAULT_SKIN_KEYWORDS = ["skin", "theme", "\u76AE\u80A4", "\u6362\u80A4", "\u4E3B\u9898", "\u5916\u89C2"];
function rowText(row) {
  return [row.key, row.entryId ?? "", row.bundle ?? "", row.title ?? "", row.description ?? ""].join("\n").toLowerCase();
}
function detectSkinEvidence(row, config) {
  const evidence = [];
  const explicit = config.skinPlugins ?? [];
  if (explicit.some((name2) => matchesKey(row, name2))) {
    evidence.push("listed in config skinPlugins");
  }
  if (config.skinDetection === false) return evidence;
  const keywords = [...DEFAULT_SKIN_KEYWORDS, ...config.skinKeywords ?? []];
  const text = rowText(row);
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      evidence.push(`name/copy contains "${keyword}"`);
      break;
    }
  }
  return evidence;
}
function matchesKey(row, key) {
  const needle = key.toLowerCase();
  return [row.key, row.entryId ?? "", row.bundle ?? ""].some((actual) => actual.toLowerCase() === needle);
}
function matchesPattern(row, pattern) {
  return rowText(row).includes(pattern.toLowerCase());
}
function allCategories(config, store) {
  const merged = /* @__PURE__ */ new Map();
  const runtimeLabel = new Map(store.categories.map((category) => [category.id, category.label]));
  for (const category of config.categories ?? []) {
    const label = runtimeLabel.get(category.id);
    merged.set(category.id, label === void 0 ? { ...category } : { ...category, label });
  }
  for (const category of store.categories) {
    if (!merged.has(category.id)) merged.set(category.id, { ...category });
  }
  if (!merged.has(SKIN_CATEGORY)) merged.set(SKIN_CATEGORY, { id: SKIN_CATEGORY, label: SKIN_CATEGORY });
  if (!merged.has(UNCATEGORIZED)) merged.set(UNCATEGORIZED, { id: UNCATEGORIZED, label: UNCATEGORIZED });
  return [...merged.values()];
}
function buildGroups(rows, config, store) {
  const definitions = allCategories(config, store);
  const groups = /* @__PURE__ */ new Map();
  const push = (id, source, label) => {
    if (groups.has(id)) return;
    const def = definitions.find((entry) => entry.id === id);
    groups.set(id, { id, label: label ?? def?.label ?? id, source, members: [], evidence: {} });
  };
  const hidden = new Set((store.hidden ?? []).filter((id) => id !== UNCATEGORIZED));
  for (const category of config.categories ?? []) {
    if (hidden.has(category.id)) continue;
    push(category.id, "config");
  }
  for (const category of store.categories) {
    if (category.id === UNCATEGORIZED || category.id === SKIN_CATEGORY) continue;
    if (hidden.has(category.id)) continue;
    push(category.id, "custom");
  }
  push(UNCATEGORIZED, "fallback");
  const configCategoryOf = /* @__PURE__ */ new Map();
  for (const category of config.categories ?? []) {
    if (hidden.has(category.id)) continue;
    for (const key of category.plugins ?? []) configCategoryOf.set(key.toLowerCase(), category.id);
  }
  const evidenceOf = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const evidence = detectSkinEvidence(row, config);
    if (evidence.length > 0) evidenceOf.set(row.key, evidence);
  }
  const skinRelevant = !hidden.has(SKIN_CATEGORY) && (config.skinDetection !== false || evidenceOf.size > 0 || rows.some((row) => store.assignments[row.key] === SKIN_CATEGORY));
  if (skinRelevant) push(SKIN_CATEGORY, "auto");
  for (const row of rows) {
    let evidence = [];
    let target;
    const stored = store.assignments[row.key];
    if (stored !== void 0 && groups.has(stored)) {
      target = stored;
    } else {
      for (const [key, id] of configCategoryOf) {
        if (matchesKey(row, key)) {
          target = id;
          break;
        }
      }
      if (target === void 0) {
        for (const category of config.categories ?? []) {
          if (hidden.has(category.id)) continue;
          if (category.namePattern !== void 0 && matchesPattern(row, category.namePattern)) {
            target = category.id;
            break;
          }
        }
      }
      if (target === void 0 && evidenceOf.has(row.key)) {
        target = SKIN_CATEGORY;
        evidence = evidenceOf.get(row.key);
      }
    }
    const group = groups.get(target ?? UNCATEGORIZED) ?? groups.get(UNCATEGORIZED);
    if (group === void 0) continue;
    group.members.push(row);
    if (evidence.length > 0) group.evidence[row.key] = evidence;
  }
  const ordered = [...groups.values()];
  for (const group of ordered) {
    if (Object.keys(group.evidence ?? {}).length === 0) delete group.evidence;
  }
  return ordered;
}
function upsertCategory(store, id, label) {
  const existing = store.categories.find((category) => category.id === id);
  if (existing) {
    if (label !== void 0 && label !== existing.label) existing.label = label;
    return existing;
  }
  const created = { id, label: label ?? id };
  store.categories.push(created);
  return created;
}
function deleteCategory(store, config, id) {
  if ((config.categories ?? []).some((category) => category.id === id)) return "config-owned";
  if (id === SKIN_CATEGORY || id === UNCATEGORIZED) return "config-owned";
  const index = store.categories.findIndex((category) => category.id === id);
  if (index === -1) return "not-found";
  store.categories.splice(index, 1);
  for (const [key, assigned] of Object.entries(store.assignments)) {
    if (assigned === id) delete store.assignments[key];
  }
  if (store.groupOrder !== void 0) store.groupOrder = store.groupOrder.filter((entry) => entry !== id);
  if (store.memberOrder !== void 0) delete store.memberOrder[id];
  return "removed";
}
function sanitizeMemberOrder(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const out = {};
  for (const [key, list] of Object.entries(value)) {
    if (Array.isArray(list) && list.every((item) => typeof item === "string")) out[key] = list;
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
async function loadStore(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || typeof parsed.assignments !== "object" || parsed.assignments === null) return emptyStore();
    const memberOrder = sanitizeMemberOrder(parsed.memberOrder);
    return {
      version: 1,
      assignments: parsed.assignments,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      ...Array.isArray(parsed.groupOrder) ? { groupOrder: parsed.groupOrder.filter((id) => typeof id === "string") } : {},
      ...memberOrder === void 0 ? {} : { memberOrder },
      ...Array.isArray(parsed.hidden) ? { hidden: parsed.hidden.filter((id) => typeof id === "string" && id !== UNCATEGORIZED) } : {}
    };
  } catch {
    return emptyStore();
  }
}
async function saveStore(file, store) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}
`, "utf8");
  await rename(temp, file);
}
function migrateLegacyDataDir(current, legacy) {
  if (current === legacy) return current;
  try {
    const legacyFile = join(legacy, "assignments.json");
    const currentFile = join(current, "assignments.json");
    if (!existsSync(currentFile) && existsSync(legacyFile)) {
      mkdirSync(current, { recursive: true });
      copyFileSync(legacyFile, currentFile);
    }
  } catch {
  }
  return current;
}
function resolveDataDirSync(config, moduleUrl) {
  if (config.dataDir) return resolve(config.dataDir);
  let dir = fileURLToPath(new URL(".", moduleUrl));
  for (let depth = 0; dir && depth < 20; depth += 1) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
    }
    const declaresProfile = manifest?.dsh?.profile !== void 0;
    const declaresBundle = manifest?.dsh?.bundle !== void 0;
    const holdsPatch = existsSync(join(dir, "cordis.patch.yml"));
    if (declaresProfile || holdsPatch && !declaresBundle) {
      return migrateLegacyDataDir(join(dir, ".plugin-categories"), join(dir, ".plugin-curator"));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return migrateLegacyDataDir(join(homedir(), ".dsh-plugin-categories"), join(homedir(), ".dsh-plugin-curator"));
}
function pickText(value) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value;
    for (const locale of ["zh-CN", "zh", "en"]) {
      if (typeof record[locale] === "string") return record[locale];
    }
    const first = Object.values(record).find((entry) => typeof entry === "string");
    if (typeof first === "string") return first;
  }
  return void 0;
}

// src/service.ts
function probeService(ctx, name2) {
  try {
    if (typeof ctx.get === "function") {
      const value = ctx.get(name2);
      if (value !== void 0) return value;
    }
  } catch {
  }
  try {
    return ctx[name2];
  } catch {
    return void 0;
  }
}
function projectRows(entries, bundles) {
  const bundleOfEntry = /* @__PURE__ */ new Map();
  const bundleOfModule = /* @__PURE__ */ new Map();
  for (const bundle of bundles) {
    const source = { bundle: bundle.name, version: bundle.version, description: bundle.description };
    for (const row of bundle.rows) {
      if (row.entryId !== void 0) bundleOfEntry.set(row.entryId, source);
      bundleOfModule.set(row.moduleName, source);
    }
  }
  return entries.map((entry) => {
    const source = bundleOfEntry.get(entry.entryId) ?? bundleOfModule.get(entry.moduleName);
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
      version: source?.version
    };
  });
}
function findRow(rows, key) {
  const needle = key.toLowerCase();
  return rows.find((row) => row.key.toLowerCase() === needle || row.entryId?.toLowerCase() === needle || row.bundle?.toLowerCase() === needle);
}
async function loadLive(manager, storeFile) {
  const [entries, bundleList] = await Promise.all([
    manager.listPlugins(),
    manager.listBundles().catch(() => [])
  ]);
  const rows = projectRows(entries, bundleList);
  const store = await loadStore(storeFile);
  return { rows, store };
}
function buildSkinSuggestions(rows, config) {
  const suggestions = {};
  for (const row of rows) {
    const evidence = detectSkinEvidence(row, config);
    if (evidence.length > 0) suggestions[row.key] = evidence;
  }
  return suggestions;
}
function applyOrder(items, order, keyOf) {
  if (order === void 0 || order.length === 0) return [...items];
  const rank = new Map(order.map((id, index) => [id, index]));
  const ordered = items.filter((item) => rank.has(keyOf(item))).sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  const rest = items.filter((item) => !rank.has(keyOf(item)));
  return [...ordered, ...rest];
}
function listResult(state, config, storeFile) {
  const { rows, store } = state;
  const groups = applyOrder(buildGroups(rows, config, store), store.groupOrder, (group) => group.id).map((group) => ({ ...group, members: applyOrder(group.members, store.memberOrder?.[group.id], (row) => row.key) }));
  const uncategorized = new Set(
    groups.find((group) => group.id === UNCATEGORIZED)?.members.map((row) => row.key) ?? []
  );
  const definitions = allCategories(config, store);
  return {
    dataFile: storeFile,
    /** Dismissed groups with their (config/renamed) labels, for the restore bar. */
    hidden: (store.hidden ?? []).map((id) => ({
      id,
      label: definitions.find((entry) => entry.id === id)?.label ?? id
    })),
    categories: groups.map((group) => ({
      id: group.id,
      label: group.label,
      source: group.source,
      size: group.members.length,
      members: group.members.map((row) => ({
        key: row.key,
        entryId: row.entryId,
        title: row.title,
        bundle: row.bundle === void 0 ? void 0 : `${row.bundle}${row.version === void 0 ? "" : `@${row.version}`}`,
        enabled: row.enabled,
        phase: row.fiberPhase,
        readOnly: row.readOnlyReason,
        evidence: group.evidence?.[row.key]
      }))
    })),
    suggestedForUncategorized: buildSkinSuggestions(
      rows.filter((row) => uncategorized.has(row.key)),
      config
    )
  };
}
async function assignResult(state, config, storeFile, args) {
  const { rows, store } = state;
  if (args.category === void 0 || args.plugins === void 0 || args.plugins.length === 0) {
    throw new Error("category and a non-empty plugins list are required");
  }
  const known = allCategories(config, store).map((c) => c.id);
  if (!known.includes(args.category)) {
    if (args.createIfMissing === true && args.category !== UNCATEGORIZED) {
      upsertCategory(store, args.category, args.label);
    } else {
      throw new Error(`Unknown category "${args.category}". Known: ${known.join(", ")}. Pass createIfMissing to add it.`);
    }
  }
  const assigned = [];
  const unknown = [];
  for (const key of args.plugins) {
    const row = findRow(rows, key);
    if (row === void 0) {
      unknown.push(key);
      continue;
    }
    if (args.category === UNCATEGORIZED) delete store.assignments[row.key];
    else store.assignments[row.key] = args.category;
    assigned.push(row.key);
  }
  await saveStore(storeFile, store);
  return {
    category: args.category,
    assigned,
    unknown,
    note: unknown.length > 0 ? "unknown keys were skipped; copy keys from `list` output" : void 0
  };
}
async function createResult(state, config, storeFile, args) {
  if (args.category === void 0) throw new Error("category is required");
  const created = upsertCategory(state.store, args.category, args.label);
  await saveStore(storeFile, state.store);
  return { created: created.id, label: created.label, knownCategories: allCategories(config, state.store).map((c) => c.id) };
}
async function deleteResult(state, config, storeFile, args) {
  if (args.category === void 0) throw new Error("category is required");
  const id = args.category;
  if (id === UNCATEGORIZED) {
    return { category: id, outcome: "refused", note: "uncategorized is structural and cannot be deleted or hidden" };
  }
  const declared = (config.categories ?? []).some((category) => category.id === id);
  if (declared || id === SKIN_CATEGORY) {
    state.store.hidden = [.../* @__PURE__ */ new Set([...state.store.hidden ?? [], id])];
    await saveStore(storeFile, state.store);
    return { category: id, outcome: "hidden", note: "members rejoin the remaining rules; restore from the hidden bar" };
  }
  const outcome = deleteCategory(state.store, config, id);
  if (outcome === "removed") await saveStore(storeFile, state.store);
  return {
    category: id,
    outcome,
    note: outcome === "removed" ? "members moved to uncategorized" : void 0
  };
}
async function restoreResult(state, storeFile, args) {
  if (args.category === void 0) throw new Error("category is required");
  const hidden = state.store.hidden ?? [];
  if (!hidden.includes(args.category)) {
    return { category: args.category, outcome: "not-found", note: "category is not hidden" };
  }
  state.store.hidden = hidden.filter((id) => id !== args.category);
  await saveStore(storeFile, state.store);
  return { category: args.category, outcome: "restored" };
}
function planSetCategory(state, config, args) {
  if (args.category === void 0 || args.enabled === void 0) throw new Error("category and enabled are required");
  const group = buildGroups(state.rows, config, state.store).find((candidate) => candidate.id === args.category);
  if (group === void 0) throw new Error(`Unknown category "${args.category}". Call list first.`);
  const enabled = args.enabled;
  const todo = group.members.filter((row) => row.enabled !== enabled);
  const plan = todo.map((row) => ({
    key: row.key,
    entryId: row.entryId,
    enabled,
    blocked: row.readOnlyReason === void 0 && row.entryId === void 0 ? "no entry id" : row.readOnlyReason
  }));
  return { group, todo, plan, enabled };
}
function drySetResult(group, todo, plan) {
  return { category: group.id, dryRun: true, alreadyInState: group.members.length - todo.length, plan };
}
function emptySetResult(group) {
  return { category: group.id, application: "applied", changed: 0, note: "every member is already in the requested state" };
}
async function applySetCategory(manager, category, enabled, todo) {
  const results = [];
  for (const row of todo) {
    if (row.readOnlyReason !== void 0) {
      results.push({ key: row.key, ok: false, error: `read-only: ${row.readOnlyReason}` });
      continue;
    }
    if (row.entryId === void 0) {
      results.push({ key: row.key, ok: false, error: "no entry id" });
      continue;
    }
    try {
      const change = await manager.setPluginEnabled(row.entryId, enabled);
      results.push({ key: row.key, ok: true, application: change.application, error: change.error?.diagnostic });
    } catch (error) {
      results.push({ key: row.key, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = results.filter((result) => !result.ok).length;
  return {
    category,
    changed: results.length - failed,
    failed,
    application: failed === 0 ? "applied" : "partial",
    results
  };
}
function prepareSetPlugin(state, args) {
  if (args.plugin === void 0 || args.enabled === void 0) throw new Error("plugin and enabled are required");
  const row = findRow(state.rows, args.plugin);
  if (row === void 0) throw new Error(`Unknown plugin "${args.plugin}". Call \`list\` to see keys.`);
  if (row.readOnlyReason !== void 0) throw new Error(`read-only: ${row.readOnlyReason}`);
  if (row.entryId === void 0) throw new Error("no entry id");
  return { row, enabled: args.enabled, noop: row.enabled === args.enabled };
}
function unchangedSetPlugin(row) {
  return { plugin: row.key, changed: 0, failed: 0, application: "unchanged", note: "already in the requested state" };
}
async function applySetPlugin(manager, row, enabled) {
  try {
    const change = await manager.setPluginEnabled(row.entryId, enabled);
    return {
      plugin: row.key,
      changed: 1,
      failed: 0,
      application: change.application,
      ...change.error?.diagnostic === void 0 ? {} : { error: change.error.diagnostic }
    };
  } catch (error) {
    return {
      plugin: row.key,
      changed: 0,
      failed: 1,
      application: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function reorderResult(state, config, storeFile, args) {
  if (args.kind !== "groups" && args.kind !== "members") throw new Error('kind must be "groups" or "members"');
  if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.some((id) => typeof id !== "string" || id === "")) {
    throw new Error("ids must be a non-empty array of strings");
  }
  if (new Set(args.ids).size !== args.ids.length) throw new Error("ids contains duplicates");
  const groups = buildGroups(state.rows, config, state.store);
  if (args.kind === "groups") {
    const known = new Set(groups.map((group) => group.id));
    const unknown = args.ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown categories: ${unknown.join(", ")}. Call list first.`);
    state.store.groupOrder = [...args.ids];
  } else {
    if (args.category === void 0) throw new Error('category is required when kind is "members"');
    const group = groups.find((candidate) => candidate.id === args.category);
    if (group === void 0) throw new Error(`Unknown category "${args.category}". Call list first.`);
    const members = new Set(group.members.map((row) => row.key));
    const foreign = args.ids.filter((key) => !members.has(key));
    if (foreign.length > 0) throw new Error(`not members of "${args.category}": ${foreign.join(", ")}`);
    state.store.memberOrder = { ...state.store.memberOrder, [args.category]: [...args.ids] };
  }
  await saveStore(storeFile, state.store);
  return {
    kind: args.kind,
    ...args.category === void 0 ? {} : { category: args.category },
    saved: args.ids.length
  };
}

// src/tool.ts
async function escalateWrite(ctx, exec, summary) {
  const policyService = probeService(ctx, "sandboxPolicy");
  if (policyService === void 0) {
    throw new Error("The sandboxPolicy service is not composed in this deployment; the plugin cannot verify permission for a profile-wide write. Use the built-in plugin_manager tool instead.");
  }
  const policy = policyService.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session });
  if (policy.mode === "danger-full-access") return;
  let approveEscalation;
  try {
    ;
    ({ approveEscalation } = await import("@deepseek-ai/dsh-sandbox"));
  } catch {
    throw new Error("This action changes the profile composition and needs the approval channel (@deepseek-ai/dsh-sandbox, shipped with the DSH host), which could not be loaded. Run the session with danger-full-access permission or use the built-in plugin_manager tool instead.");
  }
  await approveEscalation({
    requestedMode: "danger-full-access",
    effectiveMode: policy.mode,
    subject: "plugin category management operation",
    justification: summary
  }, {
    approver: ctx.get("approval"),
    agent: exec.agent,
    callId: exec.callId,
    toolName: "plugin_categories",
    signal: exec.signal
  });
}
function defineCategoriesTool(ctx, config, storeFile) {
  return defineTool({
    name: "plugin_categories",
    description: [
      "List the current profile's plugins grouped into categories (skins, MCP, tools, ...), assign plugins to",
      "categories, and enable or disable plugins \u2014 a whole category at once (`set_category`) or exactly one",
      "(`set_plugin`). Skin plugins are auto-detected from names and descriptions; the built-in plugin_manager",
      "handles installation and removal \u2014 this tool organizes what is installed. `list` first to obtain exact",
      "identifiers. Both write actions, like plugin_manager, require danger-full-access permission or approval;",
      "changes affect every session in the profile and apply immediately when HMR is enabled (otherwise after restart)."
    ].join(" "),
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "assign", "create_category", "delete_category", "restore_category", "set_category", "set_plugin", "reorder"],
        description: "Curation operation."
      },
      category: { type: "string", description: "Category id for assign / create_category / delete_category / set_category / reorder (members)." },
      label: { type: "string", description: "create_category: display label; defaults to the id." },
      plugins: { type: "array", items: { type: "string" }, description: "assign: plugin keys \u2014 moduleName, entry id, or bundle name, as `list` shows them." },
      plugin: { type: "string", description: "set_plugin: the one plugin key \u2014 moduleName, entry id, or bundle name, as `list` shows them." },
      kind: { type: "string", enum: ["groups", "members"], description: "reorder: reorder category ids or the plugin keys inside one category (with `category`)." },
      ids: { type: "array", items: { type: "string" }, description: "reorder: the new id list \u2014 category ids for groups, plugin keys for members. Unknown/duplicate ids are rejected; ids left out keep their build order after the listed ones." },
      createIfMissing: { type: "boolean", description: "assign: create an ad-hoc category when the id is unknown. Default false." },
      enabled: { type: "boolean", description: "set_category / set_plugin: desired enablement (every member of the category, or the one plugin)." },
      dryRun: { type: "boolean", description: "set_category: report what would change without changing it. Default false." }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    /** Reads may overlap; every profile-mutating action runs alone. */
    isConcurrencySafe: (args) => args.action === "list" || args.dryRun === true,
    async execute(args, exec) {
      const manager = probeService(ctx, "pluginManager");
      if (manager === void 0) {
        throw new Error("The pluginManager service is not composed in this profile; the plugin cannot read or change plugins.");
      }
      const state = await loadLive(manager, storeFile);
      const json = (value) => JSON.stringify(value);
      switch (args.action) {
        case "list":
          return json(listResult(state, config, storeFile));
        case "create_category":
          return json(await createResult(state, config, storeFile, args));
        case "delete_category":
          return json(await deleteResult(state, config, storeFile, args));
        case "restore_category":
          return json(await restoreResult(state, storeFile, args));
        case "assign":
          return json(await assignResult(state, config, storeFile, args));
        case "set_category": {
          const { group, todo, plan, enabled } = planSetCategory(state, config, args);
          if (args.dryRun === true) return json(drySetResult(group, todo, plan));
          if (plan.length === 0) return json(emptySetResult(group));
          await escalateWrite(ctx, exec, `plugin_categories set_category: ${enabled ? "enable" : "disable"} ${plan.length} plugin(s) in category "${group.id}" [${plan.map((row) => row.key).join(", ")}]. Profile changes affect every session.`);
          return json(await applySetCategory(manager, group.id, enabled, todo));
        }
        case "set_plugin": {
          const { row, enabled, noop } = prepareSetPlugin(state, args);
          if (noop) return json(unchangedSetPlugin(row));
          await escalateWrite(ctx, exec, `plugin_categories set_plugin: ${enabled ? "enable" : "disable"} "${row.key}". Profile changes affect every session.`);
          return json(await applySetPlugin(manager, row, enabled));
        }
        case "reorder":
          return json(await reorderResult(state, config, storeFile, args));
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Categorize profile plugins",
      kind: args.action === "list" || args.dryRun === true ? "read" : "other",
      rawInput: args
    })
  });
}

// src/api.ts
var LOOPBACK_NAMES = /* @__PURE__ */ new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
var MAX_BODY_BYTES = 1024 * 1024;
function authorityOf(value, defaultScheme) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.includes("://") ? value.trim() : `${defaultScheme ?? "http"}://${value.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const port = url.port === "" ? url.protocol === "https:" ? "443" : "80" : url.port;
  return { scheme: url.protocol.replace(":", ""), hostname: url.hostname.toLowerCase(), port };
}
function structuralRejection(req) {
  const host = authorityOf(String(req.headers.host ?? ""));
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403;
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "cross-site") return 403;
  for (const header of ["origin", "referer"]) {
    const raw = req.headers[header];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    let authority;
    try {
      authority = authorityOf(raw.trim());
    } catch {
      return 403;
    }
    if (authority === null) return 403;
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403;
  }
  return void 0;
}
function rejectionFor(req, deps) {
  const connection = probeService(deps.ctx, "connection");
  if (connection !== void 0 && typeof connection.admit === "function") {
    try {
      const admission = connection.admit(req);
      if (admission !== void 0 && admission !== null && "rejection" in admission) return admission.rejection;
      return void 0;
    } catch {
    }
  }
  return structuralRejection(req);
}
function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw httpError(400, `invalid JSON body (${error instanceof Error ? error.message : String(error)})`);
  }
}
function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const routePath = url.pathname.replace(/^\/api\/plugin-categories/, "").replace(/\/+$/, "") || "/";
    const method = String(req.method ?? "GET").toUpperCase();
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    const rejection = rejectionFor(req, deps);
    if (rejection !== void 0) {
      deps.logger?.warn?.(`plugin-categories: rejected ${method} ${routePath} -> ${rejection}`);
      return send(rejection, { error: rejection === 401 ? "unauthorized" : "forbidden" });
    }
    try {
      if (method === "GET" && routePath === "/summary") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const state = await loadLive(manager, deps.storeFile);
        return send(200, listResult(state, deps.config, deps.storeFile));
      }
      if (method === "POST" && routePath === "/assign") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const body = await readJson(req);
        const state = await loadLive(manager, deps.storeFile);
        return send(200, await assignResult(state, deps.config, deps.storeFile, body));
      }
      if (method === "POST" && routePath === "/create") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const body = await readJson(req);
        const state = await loadLive(manager, deps.storeFile);
        return send(200, await createResult(state, deps.config, deps.storeFile, body));
      }
      if (method === "POST" && routePath === "/delete") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const body = await readJson(req);
        const state = await loadLive(manager, deps.storeFile);
        return send(200, await deleteResult(state, deps.config, deps.storeFile, body));
      }
      if (method === "POST" && routePath === "/set_category") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const body = await readJson(req);
        const state = await loadLive(manager, deps.storeFile);
        const args = {
          category: typeof body.category === "string" ? body.category : void 0,
          enabled: body.enabled === true,
          dryRun: body.dryRun === true
        };
        const { group, todo, plan, enabled } = planSetCategory(state, deps.config, args);
        if (args.dryRun) return send(200, drySetResult(group, todo, plan));
        if (plan.length === 0) return send(200, emptySetResult(group));
        return send(200, await applySetCategory(manager, group.id, enabled, todo));
      }
      if (method === "POST" && routePath === "/set_plugin") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const body = await readJson(req);
        const state = await loadLive(manager, deps.storeFile);
        const { row, enabled, noop } = prepareSetPlugin(state, {
          plugin: typeof body.plugin === "string" ? body.plugin : void 0,
          enabled: body.enabled === true
        });
        if (noop) return send(200, unchangedSetPlugin(row));
        return send(200, await applySetPlugin(manager, row, enabled));
      }
      if (method === "POST" && routePath === "/reorder") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const body = await readJson(req);
        const state = await loadLive(manager, deps.storeFile);
        return send(200, await reorderResult(state, deps.config, deps.storeFile, {
          kind: typeof body.kind === "string" ? body.kind : void 0,
          category: typeof body.category === "string" ? body.category : void 0,
          ids: Array.isArray(body.ids) ? body.ids : void 0
        }));
      }
      if (method === "POST" && routePath === "/restore") {
        const manager = probeService(deps.ctx, "pluginManager");
        if (manager === void 0) throw httpError(503, "The pluginManager service is not composed in this profile");
        const body = await readJson(req);
        const state = await loadLive(manager, deps.storeFile);
        return send(200, await restoreResult(state, deps.storeFile, {
          category: typeof body.category === "string" ? body.category : void 0
        }));
      }
      return send(404, { error: "not found" });
    } catch (error) {
      const status = Number(error?.statusCode);
      const message = error instanceof Error ? error.message : String(error);
      const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
      deps.logger?.warn?.(`plugin-categories: ${method} ${routePath} -> ${code}: ${message}`);
      return send(code, { error: message });
    }
  };
}

// src/index.ts
var name = "plugin-categories";
var inject = ["tools"];
var Config = Schema.object({
  dataDir: Schema.string().description("\u5206\u7C7B\u6570\u636E\u76EE\u5F55\uFF1B\u7559\u767D\u65F6\u81EA\u52A8\u63A2\u6D4B profile \u76EE\u5F55\uFF08\u5199\u5165 .plugin-categories/assignments.json\uFF09"),
  skinDetection: Schema.boolean().default(true).description("\u6309\u540D\u79F0/\u63CF\u8FF0\u81EA\u52A8\u8BC6\u522B\u76AE\u80A4\u63D2\u4EF6"),
  skinKeywords: Schema.array(Schema.string()).default([]).description("\u8FFD\u52A0\u7684\u76AE\u80A4\u8BC6\u522B\u5173\u952E\u8BCD\uFF08\u5728\u9ED8\u8BA4\u8868\u4E4B\u5916\uFF09"),
  skinPlugins: Schema.array(Schema.string()).default([]).description("\u5F3A\u5236\u89C6\u4E3A\u76AE\u80A4\u63D2\u4EF6\u7684 moduleName / entry id / \u7EC4\u5408\u5305\u540D"),
  categories: Schema.array(Schema.object({
    id: Schema.string().required().description("\u5206\u7C7B id"),
    label: Schema.string().required().description("\u663E\u793A\u540D\u79F0"),
    plugins: Schema.array(Schema.string()).default([]).description("\u56FA\u5B9A\u5F52\u5165\u8BE5\u5206\u7C7B\u7684\u63D2\u4EF6\uFF08moduleName / entry id / \u7EC4\u5408\u5305\u540D\uFF09"),
    namePattern: Schema.string().description("\u5BF9\u540D\u79F0\u4E0E\u63CF\u8FF0\u505A\u4E0D\u533A\u5206\u5927\u5C0F\u5199\u7684\u5B50\u4E32\u5339\u914D")
  })).default([]).description("\u58F0\u660E\u5F0F\u5206\u7C7B\uFF0C\u4E0E\u8FD0\u884C\u65F6\u521B\u5EFA\u7684\u5206\u7C7B\u5408\u5E76")
});
function apply(ctx, config) {
  const resolved = config ?? {};
  const dataDir = resolveDataDirSync(resolved, import.meta.url);
  const storeFile = join2(dataDir, "assignments.json");
  ctx.tools.register(defineCategoriesTool(ctx, resolved, storeFile));
  console.log(`[plugin-categories] loaded; plugin_categories tool registered (data: ${storeFile})`);
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["webServer"], (scoped) => {
    const server = scoped.webServer;
    if (server === void 0) return;
    const logger = probeService(scoped, "logger") ?? console;
    const api = createApiRoutes({ ctx: scoped, config: resolved, storeFile, logger });
    scoped.effect(
      () => server.register({ kind: "prefix", path: "/api/plugin-categories", handler: api }),
      "plugin-categories: api routes"
    );
    console.log("[plugin-categories] settings API mounted at /api/plugin-categories");
  });
}
export {
  Config,
  apply,
  createApiRoutes,
  inject,
  name,
  resolveDataDirSync
};
//# sourceMappingURL=index.js.map
