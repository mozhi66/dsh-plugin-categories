/**
 * dsh-plugin-categories — browser half.
 *
 * Contributes one thing to the web shell: a settings section (`settings.section`
 * id `plugin-categories`) rendering the profile's plugins grouped into categories,
 * with per-category batch enable/disable (dry run → on-screen confirm → apply),
 * per-plugin moves between categories, custom category creation/deletion, and
 * the skin-detection suggestions the model computes.
 *
 * Data is read over the plugin's own same-origin `/api/plugin-categories/*` routes
 * (src/api.ts), served by the same host process as the kernel's `/api` and
 * guarded by the same trust-fence semantics.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  // MUST equal the full package name: the boot graph keys rows by package
  // specifier, and `arrive()` checks `factories.has(row.id)` to decide the
  // script registered. A shorter id reads as "not registered", retries the
  // one-resource URL, and the second execution throws duplicate-registration
  // — which is exactly how this crashed web boot before the id was fixed.
  id: '@dsh-external/dsh-plugin-categories',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    const inject = ['slots']
    const API = '/api/plugin-categories'

    // ── strings ─────────────────────────────────────────────────────────────
    const zh = () => String(typeof navigator !== 'undefined' ? navigator.language : '').toLowerCase().startsWith('zh')
    const STR = {
      zh: {
        nav: '插件分类',
        subtitle: '当前 profile 的插件按分类整理；改动影响该 profile 的全部会话',
        refresh: '刷新',
        loading: '加载中…',
        loadFailed: '无法读取分类数据',
        retry: '重试',
        empty: '这个分类还没有插件',
        enableAll: '全部启用',
        disableAll: '全部禁用',
        enableOne: '启用',
        disableOne: '禁用',
        confirm: '确认执行',
        cancel: '取消',
        deleting: '删除分类',
        deleteHint: '删除后成员回到「未分类」',
        newCategory: '新建分类',
        createPlaceholder: '分类 id，如 tools',
        create: '创建',
        moveTo: '移动到',
        keepHere: '本分类',
        remove: '移出分类',
        evidence: '识别依据',
        suggestions: '疑似皮肤（未分类）',
        suggestMove: '归入皮肤组',
        readOnly: '只读',
        readonlyReason: '只读：{0}',
        enabled: '启用',
        disabled: '禁用',
        applied: '已完成：{0} 个变更',
        appliedPartial: '已变更 {0} 项；{1} 项失败（只读条目已跳过）',
        appliedRestart: '已写入配置，重启 DSH 后生效',
        appliedNone: '没有需要变更的插件',
        dryPlan: '将{0}{1}个插件',
        blockedSkip: '其中 {0} 个只读条目将跳过',
        riskyBatch: '⚠ 计划中含 DSH 官方/内核组件（@deepseek-ai/*、cordis:*），禁用可能导致 DSH 无法正常工作，请确认你清楚后果',
        working: '执行中…',
        rename: '重命名分组',
        renameOk: '分组已重命名',
        renamePlaceholder: '新的显示名称',
        createOk: '分类已创建',
        deleteOk: '分类已删除',
        deleteRefused: '该分组不可删除（内置兜底分组）',
        deleteMissing: '分组不存在或已删除',
        deleteConfigHint: '删除 = 从面板移除（成员按规则重新归类，底部可恢复）',
        deleteConfigNote: '该分组由插件配置定义，删除即从面板移除、成员按原规则重新归类；可从底部「已移除的分组」恢复',
        hiddenOk: '分组已删除（底部可恢复）',
        hiddenBar: '已移除的分组：',
        restoreHint: '恢复该分组',
        restoredOk: '分组已恢复',
        moveOk: '已移动',
        dragHint: '拖动调整顺序',
        orderSaved: '顺序已保存',
        dataFile: '数据文件',
        sourceAuto: '自动识别',
        sourceConfig: '配置声明',
        sourceCustom: '自建',
        sourceFallback: '未分类',
        fail: '操作失败：{0}',
        pendingNote: '改动写入 cordis.patch.yml，对使用该 profile 的全部会话生效',
      },
      en: {
        nav: 'Plugin Categories',
        subtitle: 'Plugins of the current profile, grouped by category; changes affect every session of this profile',
        refresh: 'Refresh',
        loading: 'Loading…',
        loadFailed: 'Could not read category data',
        retry: 'Retry',
        empty: 'No plugin in this category yet',
        enableAll: 'Enable all',
        disableAll: 'Disable all',
        enableOne: 'Enable',
        disableOne: 'Disable',
        confirm: 'Confirm',
        cancel: 'Cancel',
        deleting: 'Delete category',
        deleteHint: 'Members move back to Uncategorized',
        newCategory: 'New category',
        createPlaceholder: 'category id, e.g. tools',
        create: 'Create',
        moveTo: 'Move to',
        keepHere: 'This category',
        remove: 'Remove from category',
        evidence: 'Detection evidence',
        suggestions: 'Looks like skins (uncategorized)',
        suggestMove: 'Move to skins',
        readOnly: 'read-only',
        readonlyReason: 'read-only: {0}',
        enabled: 'enabled',
        disabled: 'disabled',
        applied: 'Done: {0} change(s)',
        appliedPartial: '{0} changed; {1} failed (read-only entries skipped)',
        appliedRestart: 'Written to the profile; restart DSH to apply',
        appliedNone: 'Nothing to change',
        dryPlan: 'Would {0} {1} plugin(s)',
        blockedSkip: '{0} read-only entries will be skipped',
        riskyBatch: '⚠ The plan contains DSH official/kernel components (@deepseek-ai/*, cordis:*); disabling them may break DSH — make sure you mean it',
        working: 'Working…',
        rename: 'Rename category',
        renameOk: 'Category renamed',
        renamePlaceholder: 'New display name',
        createOk: 'Category created',
        deleteOk: 'Category deleted',
        deleteRefused: 'This category cannot be deleted (structural fallback)',
        deleteMissing: 'Category does not exist or was already deleted',
        deleteConfigHint: 'Delete = remove from the panel (members rejoin their rules; restorable at the bottom)',
        deleteConfigNote: 'This category is defined by plugin config; deleting removes it from the panel and members rejoin their rules — restore from the "Removed categories" bar below',
        hiddenOk: 'Category removed (restorable from the bottom bar)',
        hiddenBar: 'Removed categories:',
        restoreHint: 'Restore this category',
        restoredOk: 'Category restored',
        moveOk: 'Moved',
        dragHint: 'Drag to reorder',
        orderSaved: 'Order saved',
        dataFile: 'Data file',
        sourceAuto: 'auto-detected',
        sourceConfig: 'config',
        sourceCustom: 'custom',
        sourceFallback: 'uncategorized',
        fail: 'Failed: {0}',
        pendingNote: 'Changes write to cordis.patch.yml and affect every session of this profile',
      },
    }
    const t = key => (zh() ? STR.zh : STR.en)[key] ?? key
    const fmt = (key, ...values) => t(key).replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)] ?? ''))

    /** Built-in groups show a localized name until the user renames them
     * (their ids are stable keys, so renaming never breaks assignments). */
    const BUILTIN_LABELS = {
      uncategorized: { zh: '未分类', en: 'Uncategorized' },
      skin: { zh: '皮肤与主题', en: 'Skins & Themes' },
    }
    const groupLabel = group => {
      const builtin = BUILTIN_LABELS[group.id]
      return builtin !== undefined && group.label === group.id
        ? (zh() ? builtin.zh : builtin.en)
        : group.label
    }

    /** Framework members in a dry-run plan: the danger warning follows the
     * CONTENT (@deepseek-ai/*, cordis:*), not the group id — it must still
     * fire when 官方内置 is hidden and its rows sit in 未分类. */
    const planHasFramework = plan => plan.some(row =>
      row.key.startsWith('@deepseek-ai/') || row.key.startsWith('cordis:'))

    // ── api ─────────────────────────────────────────────────────────────────
    // Default timeout is generous: a batch apply serializes one
    // setPluginEnabled per member (each rewrites cordis.patch.yml), so a large
    // category legitimately takes tens of seconds — an 8s cap here aborted the
    // request, showed "failed", and left the user believing toggling was broken.
    async function api(path, options = {}) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 20000)
      try {
        const response = await fetch(`${API}${path}`, {
          method: options.method ?? 'GET',
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          redirect: 'error',
          credentials: 'same-origin',
          signal: ctrl.signal,
        })
        const text = await response.text()
        let payload
        try { payload = JSON.parse(text) } catch { throw new Error(`HTTP ${response.status}`) }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    // ── styles (injected once) ──────────────────────────────────────────────
    // Every --dsw-* name below was verified against the app's real token table
    // (404 definitions, each with light|dark values). Invented names silently
    // fall back to hard-coded light colors — that is exactly how the panel
    // turned white-on-white in night mode, and why no literal color may appear
    // in this block: real tokens flip with the theme.
    const STYLE_ID = 'dsh-plugin-categories-style'
    const CSS = `
.pcu_root{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);min-width:0}
.pcu_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.pcu_title{font-size:16px;font-weight:600;line-height:24px;margin:0}
.pcu_sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:180px}
.pcu_btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary)}
.pcu_btn:hover{border-color:var(--dsw-alias-label-tertiary)}
.pcu_btn:disabled{opacity:.5;cursor:default}
.pcu_btnDanger{color:var(--dsw-alias-state-error-primary)}
.pcu_btnPrimary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground)}
.pcu_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.pcu_cardHead{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.pcu_cardTitle{font-size:13px;font-weight:600}
.pcu_badge{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-button-elevated-fill)}
.pcu_count{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.pcu_actions{display:flex;gap:6px;flex-wrap:wrap}
.pcu_row{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l3)}
.pcu_row:first-child{border-top:none}
.pcu_main{flex:1;min-width:0}
.pcu_name{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pcu_meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pcu_ev{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);font-style:italic}
.pcu_pill{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.pcu_on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.pcu_off{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}
.pcu_ro{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.pcu_select{font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);max-width:170px}
.pcu_confirm{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l2);font-size:12px;flex-wrap:wrap}
.pcu_empty{padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l3)}
.pcu_banner{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.pcu_foot{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.pcu_createBar{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l3)}
.pcu_input{font:inherit;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);min-width:160px}
.pcu_handle{cursor:grab;user-select:none;color:var(--dsw-alias-label-tertiary);padding:0 2px;font-size:12px;flex:none}
.pcu_handle:active{cursor:grabbing}
.pcu_dragOver{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:-2px}
.pcu_toast{position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:1000;padding:8px 16px;border-radius:8px;font-size:13px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:0 4px 16px rgba(0,0,0,.25)}
.pcu_toastError{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-toast-label)}
`

    // ── page ────────────────────────────────────────────────────────────────
    function SettingsPage() {
      const [summary, setSummary] = useState(undefined) // undefined = loading
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [confirm, setConfirm] = useState(null) // {kind:'toggle'|'delete', ...}
      const [creating, setCreating] = useState(false)
      const [createDraft, setCreateDraft] = useState('')
      const [renameFor, setRenameFor] = useState(null) // category id being renamed
      const [renameDraft, setRenameDraft] = useState('')
      const [toast, setToast] = useState(null) // {text, tone:'ok'|'err'}
      const [reloadTick, setReloadTick] = useState(0)
      /** Drop target token while dragging: `group:<id>` | `member:<category>:<key>`. */
      const [dragOver, setDragOver] = useState('')
      /** The drag source `{kind, id}`; ref (not state) so drop handlers see it
       * without waiting for a re-render. */
      const dragRef = useRef(null)
      /** True once summary has ever loaded — gates the first-load skeleton. */
      const loadedRef = useRef(false)
      /** Monotonic fetch counter: a slower older response can never overwrite
       * a newer one once polling and focus refreshes share the channel. */
      const seqRef = useRef(0)
      /** Throttles refresh-failure toasts (polling must not spam). */
      const failFlashAtRef = useRef(0)

      const flash = useCallback((text, tone = 'ok') => {
        setToast({ text, tone })
        setTimeout(() => setToast(current => (current && current.text === text ? null : current)), 3500)
      }, [])

      useEffect(() => {
        let alive = true
        const seq = ++seqRef.current
        // Only the FIRST load shows the skeleton: clearing summary on every
        // reload replaced the page with "loading…", which reset the scroll
        // position after every drag reorder. Refreshes now update the existing
        // DOM in place (stable group/row keys), so scroll survives.
        if (!loadedRef.current) { setSummary(undefined); setError('') }
        api('/summary')
          .then(payload => { if (alive && seq === seqRef.current) { loadedRef.current = true; setSummary(payload) } })
          .catch(err => {
            if (!alive || seq !== seqRef.current) return
            if (!loadedRef.current) { setSummary(null); setError(String(err?.message ?? err)) }
            else {
              // Poll/focus refreshes share this path — toast at most every 30s.
              const now = Date.now()
              if (now - failFlashAtRef.current > 30000) {
                failFlashAtRef.current = now
                flash(fmt('fail', String(err?.message ?? err)), 'err')
              }
            }
          })
        return () => { alive = false }
      }, [reloadTick])

      const reload = useCallback(() => setReloadTick(v => v + 1), [])

      // Stay in sync with OTHER writers: the official plugins page toggles the
      // same live pluginManager state, but neither view hears the other's
      // writes. Refresh on window focus (returning from elsewhere) and on a
      // slow poll while this section is mounted; document-hidden (minimized)
      // skips the tick. Reopening the section remounts and fetches anyway —
      // this covers the keep-alive case where it never unmounts.
      useEffect(() => {
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          reload()
        }
        window.addEventListener('focus', tick)
        const timer = setInterval(tick, 8000)
        return () => { window.removeEventListener('focus', tick); clearInterval(timer) }
      }, [reload])
      const categories = summary?.categories ?? []
      const categoryIds = useMemo(() => categories.map(group => ({ id: group.id, label: groupLabel(group) })), [categories])

      const run = useCallback(async (path, body, successText, timeoutMs = 120000) => {
        setBusy(true)
        try {
          const payload = await api(path, { method: 'POST', body, timeoutMs })
          if (successText !== undefined) {
            const result = typeof successText === 'function' ? successText(payload) : successText
            if (typeof result === 'string') flash(result)
            else if (result !== undefined && result !== null) flash(result.text, result.tone ?? 'ok')
          }
          setConfirm(null)
          reload()
          return payload
        } catch (err) {
          flash(fmt('fail', String(err?.message ?? err)), 'err')
          return null
        } finally {
          setBusy(false)
        }
      }, [flash, reload])

      /** Toast text that actually reports what happened, not just "done". */
      const toggleResultText = useCallback(payload => {
        const changed = payload?.changed ?? 0
        const failed = payload?.failed ?? 0
        if (failed > 0) return fmt('appliedPartial', changed, failed)
        if ((payload?.results ?? []).some(result => result.application === 'restart-required')) return t('appliedRestart')
        return fmt('applied', changed)
      }, [])

      /** Single-plugin result: failures carry the manager's own message. */
      const singleResultText = useCallback(payload => {
        if ((payload?.failed ?? 0) > 0) return { text: fmt('fail', payload?.error ?? 'unknown'), tone: 'err' }
        if (payload?.application === 'restart-required') return t('appliedRestart')
        if ((payload?.changed ?? 0) === 0) return t('appliedNone')
        return fmt('applied', payload.changed)
      }, [])

      /** Delete/hide result: report the server's verdict, never a canned "deleted". */
      const deleteResultText = payload => {
        if (payload?.outcome === 'removed') return t('deleteOk')
        if (payload?.outcome === 'hidden') return t('hiddenOk')
        if (payload?.outcome === 'refused' || payload?.outcome === 'config-owned') {
          return { text: t('deleteRefused'), tone: 'err' }
        }
        return { text: t('deleteMissing'), tone: 'err' }
      }

      // ── drag & drop ──────────────────────────────────────────────────────
      // Groups and members are separate drag kinds; a member only drops on a
      // row of its OWN category (kind carries the category id), so cross-group
      // dragging is inert — moving between groups stays on the select. The drop
      // handler never clears the drag state: `drop` fires on the target first
      // and bubbles (a member-row handler would otherwise swallow a group drop),
      // then `dragend` on the handle clears it exactly once.
      const startDrag = (kind, id) => e => {
        dragRef.current = { kind, id }
        setDragOver('')
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', id) // Firefox refuses a payload-less drag
      }
      const allowDrop = (kind, id) => e => {
        const src = dragRef.current
        if (src === null || src.kind !== kind) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const token = `${kind}:${id}`
        if (dragOver !== token) setDragOver(token)
      }
      const clearDrag = () => { dragRef.current = null; setDragOver('') }
      /** Move `srcId` to `targetId`'s position; null when either id is unknown. */
      const reordered = (ids, srcId, targetId) => {
        if (srcId === targetId) return null
        const next = [...ids]
        const from = next.indexOf(srcId)
        if (from < 0) return null
        next.splice(from, 1)
        const to = next.indexOf(targetId)
        if (to < 0) return null
        next.splice(to, 0, srcId)
        return next
      }
      const dropOnGroup = targetId => e => {
        e.preventDefault()
        const src = dragRef.current
        if (busy || src === null || src.kind !== 'group') return
        const ids = reordered(categories.map(group => group.id), src.id, targetId)
        if (ids !== null) void run('/reorder', { kind: 'groups', ids }, t('orderSaved'))
      }
      const dropOnMember = (group, targetKey) => e => {
        e.preventDefault()
        const src = dragRef.current
        const kind = `member:${group.id}`
        if (busy || src === null || src.kind !== kind) return
        const current = categories.find(candidate => candidate.id === group.id)
        if (current === undefined) return
        const ids = reordered(current.members.map(row => row.key), src.id, targetKey)
        if (ids !== null) void run('/reorder', { kind: 'members', category: group.id, ids }, t('orderSaved'))
      }

      /** Step 1 of a toggle: ask the backend what would change, then confirm. */
      const previewToggle = useCallback(async (category, enabled) => {
        setBusy(true)
        try {
          const plan = await api('/set_category', { method: 'POST', body: { category, enabled, dryRun: true }, timeoutMs: 30000 })
          if (!plan?.dryRun) throw new Error('unexpected dry-run payload')
          if ((plan.plan ?? []).length === 0) { flash(t('appliedNone')); setConfirm(null); return }
          setConfirm({ kind: 'toggle', category, enabled, plan: plan.plan })
        } catch (err) {
          flash(fmt('fail', String(err?.message ?? err)), 'err')
        } finally {
          setBusy(false)
        }
      }, [flash])

      if (summary === undefined) {
        return h('div', { className: 'pcu_root' }, h('p', { className: 'pcu_sub' }, t('loading')))
      }
      if (summary === null) {
        return h('div', { className: 'pcu_root' },
          h('div', { className: 'pcu_banner' },
            h('span', { style: { flex: 1 } }, `${t('loadFailed')}${error ? `：${error}` : ''}`),
            h('button', { className: 'pcu_btn', onClick: reload }, t('retry'))))
      }

      const sourceLabel = source => t(`source${source.charAt(0).toUpperCase()}${source.slice(1)}`)

      return h('div', { className: 'pcu_root' },
        h('div', { className: 'pcu_head' },
          h('h3', { className: 'pcu_title' }, t('nav')),
          h('span', { className: 'pcu_sub' }, t('subtitle')),
          h('button', { className: 'pcu_btn', onClick: reload, disabled: busy }, t('refresh')),
          h('button', {
            className: 'pcu_btn',
            disabled: busy || creating,
            onClick: () => setCreating(value => !value),
          }, t('newCategory'))),
        creating ? h('div', { className: 'pcu_createBar' },
          h('input', {
            className: 'pcu_input',
            placeholder: t('createPlaceholder'),
            value: createDraft,
            onChange: e => setCreateDraft(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter') document.getElementById('pcu-create-go')?.click() },
          }),
          h('button', {
            id: 'pcu-create-go',
            className: 'pcu_btn pcu_btnPrimary',
            disabled: busy || createDraft.trim() === '',
            onClick: () => {
              const id = createDraft.trim()
              if (id === '') return
              void run('/create', { category: id, label: id }, t('createOk')).then(ok => {
                if (ok) { setCreating(false); setCreateDraft('') }
              })
            },
          }, t('create')),
          h('button', { className: 'pcu_btn', onClick: () => { setCreating(false); setCreateDraft('') } }, t('cancel'))) : null,
        categories.map(group => {
          const enabledCount = group.members.filter(row => row.enabled).length
          const someOff = group.members.length > enabledCount
          const someOn = enabledCount > 0
          const pendingConfirm = confirm && confirm.kind === 'toggle' && confirm.category === group.id ? confirm : null
          const pendingDelete = confirm && confirm.kind === 'delete' && confirm.category === group.id ? confirm : null
          return h('div', {
            className: dragOver === `group:${group.id}` ? 'pcu_card pcu_dragOver' : 'pcu_card',
            key: group.id,
            onDragOver: allowDrop('group', group.id),
            onDrop: dropOnGroup(group.id),
          },
            h('div', { className: 'pcu_cardHead' },
              h('span', {
                className: 'pcu_handle', draggable: true, title: t('dragHint'),
                onDragStart: startDrag('group', group.id), onDragEnd: clearDrag,
              }, '⠿'),
              renameFor === group.id
                ? h('span', { className: 'pcu_actions' },
                  h('input', {
                    className: 'pcu_input',
                    autoFocus: true,
                    value: renameDraft,
                    placeholder: t('renamePlaceholder'),
                    onChange: e => setRenameDraft(e.target.value),
                    onKeyDown: e => {
                      if (e.key === 'Enter') document.getElementById('pcu-rename-go')?.click()
                      if (e.key === 'Escape') setRenameFor(null)
                    },
                  }),
                  h('button', {
                    id: 'pcu-rename-go',
                    className: 'pcu_btn pcu_btnPrimary',
                    disabled: busy || renameDraft.trim() === '',
                    onClick: () => {
                      const label = renameDraft.trim()
                      if (label === '') return
                      void run('/create', { category: group.id, label }, t('renameOk')).then(ok => {
                        if (ok) { setRenameFor(null); setRenameDraft('') }
                      })
                    },
                  }, '✓'),
                  h('button', { className: 'pcu_btn', onClick: () => { setRenameFor(null); setRenameDraft('') } }, '✗'))
                : h('span', { className: 'pcu_cardTitle' },
                  groupLabel(group),
                  h('button', {
                    className: 'pcu_btn',
                    style: { marginLeft: '6px', padding: '0 6px' },
                    title: t('rename'),
                    disabled: busy,
                    onClick: () => { setRenameFor(group.id); setRenameDraft(groupLabel(group)) },
                  }, '✎')),
              h('span', { className: 'pcu_badge', title: group.id }, sourceLabel(group.source)),
              h('span', { className: 'pcu_count' }, `${enabledCount}/${group.size} ${t('enabled')}`),
              group.members.length > 0 ? h('div', { className: 'pcu_actions' },
                someOff ? h('button', {
                  className: 'pcu_btn', disabled: busy,
                  onClick: () => void previewToggle(group.id, true),
                }, t('enableAll')) : null,
                someOn ? h('button', {
                  className: 'pcu_btn pcu_btnDanger', disabled: busy,
                  onClick: () => void previewToggle(group.id, false),
                }, t('disableAll')) : null) : null,
              // Every group except 未分类 gets an exit: custom rows are truly
              // deleted, config/builtin rows are dismissed (hidden) and can be
              // restored from the bottom bar.
              group.id === 'uncategorized' ? null : h('button', {
                className: 'pcu_btn pcu_btnDanger', disabled: busy,
                title: group.source === 'custom' ? `${t('deleting')}：${t('deleteHint')}` : t('deleteConfigHint'),
                onClick: () => setConfirm({ kind: 'delete', category: group.id }),
              }, t('deleting'))),
            pendingConfirm ? h('div', { className: 'pcu_confirm' },
              h('span', { style: { flex: 1, minWidth: '180px' } },
                `${fmt('dryPlan', pendingConfirm.enabled ? (zh() ? '启用' : 'enable') : (zh() ? '禁用' : 'disable'), pendingConfirm.plan.length)}：`,
                h('strong', {}, pendingConfirm.plan.slice(0, 6).map(row => row.key.split('/').pop()).join('、')),
                pendingConfirm.plan.length > 6 ? ` …${pendingConfirm.plan.length - 6}` : '',
                pendingConfirm.plan.filter(row => row.blocked).length > 0
                  ? h('span', { className: 'pcu_meta', style: { display: 'block' } },
                    fmt('blockedSkip', pendingConfirm.plan.filter(row => row.blocked).length))
                  : null,
                pendingConfirm.enabled === false && planHasFramework(pendingConfirm.plan)
                  ? h('span', {
                    style: {
                      display: 'block', fontWeight: 600,
                      color: 'var(--dsw-alias-state-error-primary)',
                    },
                  }, t('riskyBatch'))
                  : null,
                h('span', { className: 'pcu_meta', style: { display: 'block' } }, t('pendingNote'))),
              h('button', {
                className: 'pcu_btn pcu_btnPrimary', disabled: busy,
                onClick: () => void run('/set_category',
                  { category: pendingConfirm.category, enabled: pendingConfirm.enabled, dryRun: false },
                  toggleResultText),
              }, busy ? t('working') : t('confirm')),
              h('button', { className: 'pcu_btn', disabled: busy, onClick: () => setConfirm(null) }, t('cancel'))) : null,
            pendingDelete ? h('div', { className: 'pcu_confirm' },
              h('span', { style: { flex: 1, minWidth: '180px' } },
                group.source === 'custom'
                  ? `${t('deleting')} "${groupLabel(group)}" — ${t('deleteHint')}`
                  : `${t('deleting')} "${groupLabel(group)}" — ${t('deleteConfigNote')}`),
              h('button', {
                className: 'pcu_btn pcu_btnDanger', disabled: busy,
                onClick: () => void run('/delete', { category: pendingDelete.category }, deleteResultText),
              }, t('confirm')),
              h('button', { className: 'pcu_btn', onClick: () => setConfirm(null) }, t('cancel'))) : null,
            group.members.length === 0
              ? h('div', { className: 'pcu_empty' }, t('empty'))
              : group.members.map(row => h('div', {
                className: dragOver === `member:${group.id}:${row.key}` ? 'pcu_row pcu_dragOver' : 'pcu_row',
                key: row.key,
                onDragOver: allowDrop(`member:${group.id}`, row.key),
                onDrop: dropOnMember(group, row.key),
              },
                h('span', {
                  className: 'pcu_handle', draggable: true, title: t('dragHint'),
                  onDragStart: startDrag(`member:${group.id}`, row.key), onDragEnd: clearDrag,
                }, '⠿'),
                h('div', { className: 'pcu_main' },
                  h('div', { className: 'pcu_name', title: row.title ?? row.key }, row.title ?? row.key),
                  row.title ? h('div', { className: 'pcu_meta', title: row.key }, row.key) : null,
                  row.bundle ? h('div', { className: 'pcu_meta' }, row.bundle) : null,
                  row.evidence?.length
                    ? h('div', { className: 'pcu_ev', title: `${t('evidence')}: ${row.evidence.join('; ')}` }, `“${row.evidence[0]}”`)
                    : null),
                row.readOnly
                  ? h('span', { className: 'pcu_pill pcu_ro', title: fmt('readonlyReason', row.readOnly) }, t('readOnly'))
                  : h('span', { className: `pcu_pill ${row.enabled ? 'pcu_on' : 'pcu_off'}` },
                      row.enabled ? t('enabled') : t('disabled')),
                row.readOnly ? null : h('button', {
                  className: row.enabled ? 'pcu_btn pcu_btnDanger' : 'pcu_btn',
                  disabled: busy,
                  title: row.enabled ? t('disableOne') : t('enableOne'),
                  onClick: () => void run('/set_plugin',
                    { plugin: row.key, enabled: !row.enabled }, singleResultText),
                }, row.enabled ? t('disableOne') : t('enableOne')),
                row.phase && row.phase !== 'active'
                  ? h('span', { className: 'pcu_badge', title: 'fiber phase' }, String(row.phase))
                  : null,
                h('select', {
                  className: 'pcu_select',
                  value: group.id,
                  disabled: busy || row.readOnly !== undefined,
                  title: t('moveTo'),
                  onChange: e => {
                    const target = e.target.value
                    if (target === group.id) return
                    void run('/assign', { category: target, plugins: [row.key] }, t('moveOk'))
                  },
                },
                categoryIds.map(option => h('option', { key: option.id, value: option.id },
                  option.id === group.id ? t('keepHere') : option.label))))),
            group.id === 'uncategorized' && summary.suggestedForUncategorized
            && Object.keys(summary.suggestedForUncategorized).length > 0
              ? h('div', { className: 'pcu_createBar' },
                h('span', { className: 'pcu_meta', style: { flex: 1 } }, t('suggestions')),
                Object.entries(summary.suggestedForUncategorized).map(([key, evidence]) =>
                  h('button', {
                    key,
                    className: 'pcu_btn',
                    title: (evidence ?? []).join('; '),
                    disabled: busy,
                    onClick: () => void run('/assign',
                      { category: 'skin', plugins: [key], createIfMissing: true, label: '皮肤与主题' }, t('moveOk')),
                  }, key.split('/').pop()))) : null)
        }),
        // Dismissed (hidden) groups live here until restored — hiding must
        // never be a one-way door.
        summary.hidden?.length > 0
          ? h('div', { className: 'pcu_createBar' },
            h('span', { className: 'pcu_meta', style: { flex: 'none' } }, t('hiddenBar')),
            summary.hidden.map(entry => h('button', {
              key: entry.id,
              className: 'pcu_btn',
              title: t('restoreHint'),
              disabled: busy,
              onClick: () => void run('/restore', { category: entry.id }, t('restoredOk')),
            }, `↻ ${entry.label}`)))
          : null,
        h('div', { className: 'pcu_foot' }, `${t('dataFile')}: ${summary.dataFile}`),
        toast ? h('div', { className: `pcu_toast${toast.tone === 'err' ? ' pcu_toastError' : ''}` }, toast.text) : null)
    }

    // ── registration ────────────────────────────────────────────────────────
    function apply(ctx) {
      if (typeof document !== 'undefined' && document.head && !document.getElementById(STYLE_ID)) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'plugin-categories',
        order: 50,
        label: () => t('nav'),
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'plugin-categories'
    return module.exports
  },
})
