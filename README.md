# dsh-plugin-categories — DSH 插件分类

DeepSeek Harness（DSH）的**分类管理插件的插件**：把当前 profile 里已安装的插件按分类组织起来（皮肤、MCP、工具……），支持一键批量启停整个分类，并对**皮肤插件自动识别归类**。适合装了一堆 `ui-skin-*` 皮肤插件、想按类切换或统一关闭的场景。

它不替代内置的 `plugin_manager`（那个负责安装/卸载组合包），而是做它不做的"整理"工作。

## 功能

- **设置面板**：浏览器半身（`client.js`）往设置菜单注册「**插件分类**」入口（`settings.section` id `plugin-categories`）——在界面里按分类查看全部插件、分类级批量启停（先 dry-run 预览、屏幕确认再执行，**计划含 `@deepseek-ai/*`/`cordis:*` 成员时按内容显示红色警告**）、**每行单独启用/禁用某一个插件、分组与组内插件均可拖拽排序**（⠿ 把手，顺序持久化到 `assignments.json`，刷新不跳回顶部；**窗口聚焦即刷新 + 挂载期间 8 秒轮询**，自动跟随官方插件页等其他写入方的开关改动）、分组改名（含配置声明的分组）、单个插件在分类间移动、新建/删除分类（配置分类的"删除"= 从面板移除，可从底部「已移除的分组」一键恢复；未分类不可删）。数据走同源 `/api/plugin-categories/*` 路由（loopback + Origin 信任防火墙，与内核 `/api` 同款准入语义）；宿主侧 HTTP 层与工具层共用 `src/service.ts`，两条通道的结果形状永不漂移。
- **自动分类**：通过 `pluginManager` 服务读取当前 profile 的全部插件条目，按下面三层归组：
  1. 运行时指派（存在 `assignments.json` 里）；
  2. 配置声明的分类（`cordis.yml` / 设置里的 Config）；
  3. 皮肤启发式识别（名称/描述含 `skin`、`theme`、`皮肤`、`换肤`、`主题`、`外观` 等关键词，或组合包名带 `ui-skin-*`），命中结果附带证据（evidence），其余进 `uncategorized`。
- **批量开关**：`set_category` 对一个分类里的所有插件逐个调用 `setPluginEnabled`，先 `dryRun` 预览，再真正执行；只读条目（如 Agent 预设行）自动跳过并说明原因。
- **运行时建类**：对话里直接 `assign` 到新分类（`createIfMissing`），或显式 `create_category` / `delete_category`。
- **权限与内置工具对齐**：批量写操作与 `plugin_manager` 一样走 `danger-full-access` 升级审批；审批通道不可用时**拒绝执行**（fail-closed），绝不静默提权。
- **状态持久化**：指派关系写在 profile 的 `.plugin-categories/assignments.json`（自动探测 profile 目录，探测不到时落到 `~/.dsh-plugin-categories/`，也可用 `dataDir` 配置指定；从旧版本的 `.plugin-curator` / `~/.dsh-plugin-curator` 升级时，首次启动自动把已有分类数据拷贝到新目录）。HMR 开启时改动立即生效，否则提示重启。

## 安装

**通过插件市场搜索安装**：DSH → 插件 → **发现** → **添加索引源**，粘贴：

```
https://raw.githubusercontent.com/mozhi66/dsh-plugin-categories/main/index.json
```

之后在「发现」里搜索 `分类`、`categories` 或 `@dsh-external` 即可找到本插件并一键安装。
本仓库根目录的 `index.json` 是 DSH 插件市场索引（format 1，由 `@deepseek-ai/dsh-plugin-market-index` 校验）；
**发新版本时必须同步更新它**：`version`（精确 SemVer）、`publishTimestamp`（Unix 秒）、
`source.commit`（40 位完整小写 SHA，`git rev-parse HEAD`），否则市场仍会列出并安装旧版本。

**直装（推荐，无需克隆）**：DSH 设置 → 插件 → **添加插件**，在输入框粘贴仓库地址：

```
https://github.com/mozhi66/dsh-plugin-categories
```

对话里让 plugin_manager「安装 `https://github.com/mozhi66/dsh-plugin-categories`」、或 CLI `dsh plugin add https://github.com/mozhi66/dsh-plugin-categories` 同样有效。前提：本机已安装 `git` 且能访问 github.com。

——以下为本地安装（克隆或下载 ZIP 后）——

先获取源码（二选一）：

```sh
git clone https://github.com/mozhi66/dsh-plugin-categories.git
```

或在仓库页面点 **Code → Download ZIP** 解压。下面的 `<插件所在目录>` 即克隆/解压后的目录。

方式一（推荐）：启动 DSH 后，在**创造模式**对话里直接说：

> 用 plugin_manager 把本地插件包 `<插件所在目录>` 安装到当前 profile

方式二：CLI

```sh
dsh plugin --profile <profile> add <插件所在目录>
```

方式三（开发调试）：不动 profile，用 patch 覆盖层加载源码：

```sh
npx @deepseek-ai/dsh web --patch <插件所在目录>\cordis.patch.yml
```

前置要求：`@deepseek-ai/dsh >= 0.1.0-rc.5`（peer 依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 随安装自动解析）。安装后重启或等 HMR 生效。

## 用法

**界面（推荐）**：安装后打开 DSH 设置，左侧菜单出现「插件分类」（Plugin Categories）。包自带默认分类配置（按命中顺序）：

1. `@deepseek-ai/*` → **官方内置**、`cordis:*` → **内核组件**——DSH 框架自带的行集中放这两组，和你自己的插件分开，避免在杂项组误点「全部禁用」把 DSH 自己关掉；对这两个组执行批量禁用时确认条会额外显示红色警告（分组改名不影响这条保护，认的是 id）；
2. 名称含 `skin`/`theme`/`皮肤`/`主题` 等关键词 → **皮肤与主题**（识别证据悬浮可见）；
3. 名称/描述含 `mcp` → **MCP 服务器**；
4. 以上都没命中的 → **未分类**（`uncategorized` 的兜底组——所有规则都匹配不上的插件先落这里，手动把常用插件挪进自建分组即可清空）。

可在 profile 的 `cordis.patch.yml` 里覆盖/扩展 `config.categories`。指派写入 `.plugin-categories/assignments.json`，启停写入 `cordis.patch.yml`。

**对话（给 agent 用）**，指令示例：

```
列出当前所有插件，按分类给我看
→ 调用 plugin_categories {action: 'list'}

把 qq2006 和 my-skin 两个皮肤归到"复古皮肤"类
→ {action: 'assign', category: 'retro-skins', label: '复古皮肤', createIfMissing: true, plugins: ['ui-skin-qq2006', 'my-skin']}

先预览，然后关掉所有皮肤类插件
→ {action: 'set_category', category: 'skin', enabled: false, dryRun: true}
→ {action: 'set_category', category: 'skin', enabled: false}

只开我最常用的那一个皮肤（其余留着但关掉）
→ {action: 'set_plugin', plugin: '@smalltailqwq/dsh-client-ui-skin-maid-atelier', enabled: true}
```

### 工具参数（`plugin_categories`）

| action | 必填参数 | 说明 |
|---|---|---|
| `list` | — | 分类列出全部插件，含启用状态、 fiber 阶段、组合包/版本、只读原因、皮肤证据 |
| `assign` | `category`、`plugins` | 把插件（moduleName / entry id / 组合包名）指派到分类；`createIfMissing: true` 可顺带建类；传 `uncategorized` 清除指派 |
| `create_category` | `category` | 新建运行时分类，`label` 可选 |
| `delete_category` | `category` | 面板上统一显示「删除分类」。自建分类 → **真删除**（成员回 `uncategorized`，不可恢复）；配置/内置分类（官方内置、内核组件、MCP、皮肤）→ **从面板移除**（其定义在插件配置里、无法从数据文件抹除，故实现为：匹配规则暂停、成员按剩余规则重新归类，持久化不反弹；`restore_category` 是后悔药）；`uncategorized` 结构性不可删（返回 `refused`） |
| `restore_category` | `category` | 恢复一个被移除的配置分类（连同其成员与改名后的显示名）；未被移除的 id 返回 `not-found` |
| `set_category` | `category`、`enabled` | 批量启停整个分类；`dryRun: true` 只返回计划；需要审批 |
| `set_plugin` | `plugin`、`enabled` | **单个**插件启停（面板行内按钮的对话版）；只读条目与未知 key 直接报错；同样需要审批，目标态已一致时为无操作、不触发审批 |
| `reorder` | `kind`、`ids`（members 另需 `category`） | 持久化拖拽排序：`kind: 'groups'` 排分组、`kind: 'members'` 排组内插件；拒绝未知/重复 id，未列出的项排在已列出项之后；与 `assign` 同级（只写 `assignments.json`），不触发审批 |

## 配置（Config schema）

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | 自动探测 | `assignments.json` 所在目录 |
| `skinDetection` | `true` | 关掉后关键词识别停用；但 `skinPlugins` 显式列表和已有的 skin 指派仍然生效 |
| `skinKeywords` | `[]` | 追加的皮肤关键词（在默认表之外） |
| `skinPlugins` | `[]` | 强制视为皮肤的插件 key（精确匹配 moduleName / entry id / 组合包名） |
| `categories` | `[]` | 声明式分类：`{ id, label, plugins?, namePattern? }`；`plugins` 是**精确** key 匹配，`namePattern` 才是对名称/描述的不区分大小写子串匹配 |

兼容性说明：较旧的 DSH 构建里插件条目不带 `meta`（标题/描述），此时皮肤识别退回到组合包名 + 组合包描述匹配；两者都命不中的插件用 `skinPlugins` 或分类配置显式指定即可。

在 profile 的 `cordis.patch.yml` 里对应的行下写 `config:` 即可，例如：

```yaml
- insert:
    - id: plugin-categories
      name: '@dsh-external/dsh-plugin-categories'
      config:
        categories:
          - id: mcp
            label: MCP 服务器
            namePattern: mcp
```

## 已知限制

- 只管理"当前 profile 已安装"的插件；安装/卸载请用内置 `plugin_manager`。
- `setPluginEnabled` 遵循内置管理器的语义：改动写入 profile 的 `cordis.patch.yml`，对使用该 profile 的全部会话生效；无 HMR 时返回 `restart-required`。
- `listBundles` 富化（组合包名/版本）是尽力而为，读取失败不影响分类列表。
- 配置声明的分类与运行时分类冲突时，以先注册者（config）为准。
- DSH 处于 developer preview，接口可能变化；本插件按 `0.1.x` 的 `pluginManager` 服务面编写。

## 开发

```sh
npm install
npm run build      # esbuild → lib/index.js
npm run typecheck  # tsc --noEmit
npm test           # mock ctx 的端到端冒烟测试
```

结构：`src/model.ts`（纯逻辑：分类模型/皮肤识别/持久化，可单测）、`src/tool.ts`（`defineTool` 定义 + 审批升级）、`src/index.ts`（插件入口与 Config schema）。

## License

MIT
