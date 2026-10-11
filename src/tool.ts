/** The `plugin_categories` agent tool: list, categorize, and batch-toggle profile plugins.
 * A thin adapter over `src/service.ts` — all operations (and their exact JSON
 * shapes) are shared with the browser API in `src/api.ts`. */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { CategoriesConfig } from './model.ts'
import {
  applySetCategory, applySetPlugin, assignResult, createResult, deleteResult, drySetResult,
  emptySetResult, listResult, loadLive, planSetCategory, prepareSetPlugin, probeService,
  reorderResult, restoreResult, unchangedSetPlugin,
} from './service.ts'

/**
 * Require `danger-full-access` for batch writes, mirroring the built-in
 * `plugin_manager` tool: no-op when the call already runs wide, otherwise ask
 * through the DSH escalation channel, refusing when that package is absent
 * (fail closed — a missing approval channel must not widen anything).
 */
async function escalateWrite(ctx: Context, exec: ToolRunContext, summary: string): Promise<void> {
  // Typed non-optional by the augmentation, yet genuinely absent when the
  // deployment composes no sandbox policy — probe and fail closed with a
  // clear message instead of a TypeError.
  const policyService = probeService<Context['sandboxPolicy']>(ctx, 'sandboxPolicy')
  if (policyService === undefined) {
    throw new Error('The sandboxPolicy service is not composed in this deployment; the plugin cannot '
      + 'verify permission for a profile-wide write. Use the built-in plugin_manager tool instead.')
  }
  const policy = policyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  if (policy.mode === 'danger-full-access') return
  let approveEscalation: typeof import('@deepseek-ai/dsh-sandbox').approveEscalation
  try {
    ;({ approveEscalation } = await import('@deepseek-ai/dsh-sandbox'))
  } catch {
    throw new Error('This action changes the profile composition and needs the approval channel '
      + '(@deepseek-ai/dsh-sandbox, shipped with the DSH host), which could not be loaded. '
      + 'Run the session with danger-full-access permission or use the built-in plugin_manager tool instead.')
  }
  await approveEscalation({
    requestedMode: 'danger-full-access',
    effectiveMode: policy.mode,
    subject: 'plugin category management operation',
    justification: summary,
  }, {
    approver: ctx.get('approval'),
    agent: exec.agent,
    callId: exec.callId,
    toolName: 'plugin_categories',
    signal: exec.signal,
  })
}

/** Build the tool. Services are probed at execute time, not injected. */
export function defineCategoriesTool(ctx: Context, config: CategoriesConfig, storeFile: string) {
  return defineTool({
    name: 'plugin_categories',
    description: [
      'List the current profile\'s plugins grouped into categories (skins, MCP, tools, ...), assign plugins to',
      'categories, and enable or disable plugins — a whole category at once (`set_category`) or exactly one',
      '(`set_plugin`). Skin plugins are auto-detected from names and descriptions; the built-in plugin_manager',
      'handles installation and removal — this tool organizes what is installed. `list` first to obtain exact',
      'identifiers. Both write actions, like plugin_manager, require danger-full-access permission or approval;',
      'changes affect every session in the profile and apply immediately when HMR is enabled (otherwise after restart).',
    ].join(' '),
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['list', 'assign', 'create_category', 'delete_category', 'restore_category', 'set_category', 'set_plugin', 'reorder'],
        description: 'Curation operation.',
      },
      category: { type: 'string', description: 'Category id for assign / create_category / delete_category / set_category / reorder (members).' },
      label: { type: 'string', description: 'create_category: display label; defaults to the id.' },
      plugins: { type: 'array', items: { type: 'string' }, description: 'assign: plugin keys — moduleName, entry id, or bundle name, as `list` shows them.' },
      plugin: { type: 'string', description: 'set_plugin: the one plugin key — moduleName, entry id, or bundle name, as `list` shows them.' },
      kind: { type: 'string', enum: ['groups', 'members'], description: 'reorder: reorder category ids or the plugin keys inside one category (with `category`).' },
      ids: { type: 'array', items: { type: 'string' }, description: 'reorder: the new id list — category ids for groups, plugin keys for members. Unknown/duplicate ids are rejected; ids left out keep their build order after the listed ones.' },
      createIfMissing: { type: 'boolean', description: 'assign: create an ad-hoc category when the id is unknown. Default false.' },
      enabled: { type: 'boolean', description: 'set_category / set_plugin: desired enablement (every member of the category, or the one plugin).' },
      dryRun: { type: 'boolean', description: 'set_category: report what would change without changing it. Default false.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    /** Reads may overlap; every profile-mutating action runs alone. */
    isConcurrencySafe: args => args.action === 'list' || args.dryRun === true,
    async execute(args, exec) {
      // Typed non-optional by the augmentation, yet genuinely absent when the
      // profile disabled the manager — probe (no inject requirement) instead
      // of trusting the type; direct access would throw before this line.
      const manager = probeService<PluginManager>(ctx, 'pluginManager')
      if (manager === undefined) {
        throw new Error('The pluginManager service is not composed in this profile; the plugin cannot read or change plugins.')
      }
      const state = await loadLive(manager, storeFile)
      const json = (value: unknown) => JSON.stringify(value)

      switch (args.action) {
        case 'list':
          return json(listResult(state, config, storeFile))
        case 'create_category':
          return json(await createResult(state, config, storeFile, args))
        case 'delete_category':
          return json(await deleteResult(state, config, storeFile, args))
        case 'restore_category':
          // Undoes the config/builtin hide path; no escalation (assignments file only).
          return json(await restoreResult(state, storeFile, args))
        case 'assign':
          return json(await assignResult(state, config, storeFile, args))
        case 'set_category': {
          const { group, todo, plan, enabled } = planSetCategory(state, config, args)
          if (args.dryRun === true) return json(drySetResult(group, todo, plan))
          if (plan.length === 0) return json(emptySetResult(group))
          await escalateWrite(ctx, exec, `plugin_categories set_category: ${enabled ? 'enable' : 'disable'} ${plan.length} plugin(s) in category "${group.id}" [${plan.map(row => row.key).join(', ')}]. Profile changes affect every session.`)
          return json(await applySetCategory(manager, group.id, enabled, todo))
        }
        case 'set_plugin': {
          const { row, enabled, noop } = prepareSetPlugin(state, args)
          if (noop) return json(unchangedSetPlugin(row))
          await escalateWrite(ctx, exec, `plugin_categories set_plugin: ${enabled ? 'enable' : 'disable'} "${row.key}". Profile changes affect every session.`)
          return json(await applySetPlugin(manager, row, enabled))
        }
        case 'reorder':
          // Display order only — writes assignments.json like `assign`, so no
          // escalation (that gate belongs to profile composition writes).
          return json(await reorderResult(state, config, storeFile, args))
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Categorize profile plugins',
      kind: args.action === 'list' || args.dryRun === true ? 'read' : 'other',
      rawInput: args,
    }),
  })
}
