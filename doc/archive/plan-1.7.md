# plan-1.7 · 内置客户端：ZCode（智谱 Z.ai）

## 背景与目标

mcp-dock 目前内置 18 个 MCP 客户端（cursor / vscode / claude-code / … / qoder / cloud），
ZCode（智谱 Z.ai 的 AI 编程客户端）不在其中，用户只能走「手动添加自定义客户端」，
且自定义客户端路径无法覆盖 ZCode 的非标准配置结构（见下）。

目标：把 ZCode 提升为**内置客户端**，开箱自动识别——装了就出现在列表里，配置可直接读写，Skills 可直接管理。

## 事实确认（已核实，非推测）

| 项 | 结论 | 来源 |
|---|---|---|
| 产品归属 | ZCode = 智谱 Z.ai 出品的 AI 编程客户端 | https://zcode.z.ai/cn/newdocs/mcp-services |
| 用户级 MCP 配置 | `~/.zcode/cli/config.json`，键 **`mcp.servers`** | 同上 |
| 原生配置结构 | `{"mcp":{"servers":{"memory":{"command":"npx","args":[...],"env":{}}}}}` | 同上 |
| 启用状态 | 停用写入 `"enable": false`；**无此字段即视为启用** | 同上 |
| 工作区级 MCP | `<项目根>/.zcode/config.json`，键同为 `mcp.servers` | 同上 |
| .agents 兜底 | `~/.agents/mcp.json`，键 `mcpServers`；**仅当 .zcode 无任何服务时才生效** | 同上 |
| 用户级 Skills 目录 | `~/.zcode/skills/<skill-name>/SKILL.md` | https://zcode.z.ai/en/newdocs/skill |
| 本机安装情况 | `~/.zcode/` 已存在，含 `skills/` 与 `cli/`；`~/.zcode/cli/config.json` 尚未生成 | 本地 `ls` 实测 |

**关键差异**：ZCode 用的是 `mcp.servers`（嵌套两层），不是业界通用的 `mcpServers`。
现有 18 个客户端里只有 `openclaw` 是这个形状，可复用其适配器分支结构。

## 范围与边界

**做**

1. `zcode` 加入全部内置客户端注册表（类型 / 路径 / 名称 / 探测 / Skills）。
2. 格式适配：`mcp.servers` ↔ `mcpServers` 双向转换（读 + 写）。
3. `enable: false` 透传保留——**读出来是什么就写回什么，不新增、不改写**。
4. UI 图标：无图片资源，走代码绘制分支（与 workbuddy / qoder 同款）。
5. 补单测：Skills 路径断言 + 配置读/写往返。

**不做**（理由）

- 工作区级 `./.zcode/config.json`：mcp-dock 是「用户级全局客户端管理器」，无项目上下文，加进来需要额外的工作区选择交互，收益/复杂度不成立。
- `.agents/mcp.json` 兜底：ZCode 自己的优先级规则是「.zcode 有服务就整体跳过 .agents」，而 mcp-dock 只写 .zcode，兜底路径永远不会被 ZCode 读到，实现它等于死代码。
- 工作区级 Skills（`.zcode/skills/` 项目内）：同上，无项目上下文。

## 设计要点

### 1. 探测策略（对齐现有约定）

项目现有约定：`installed` 判定**只看配置文件是否存在**（见 `config-manager.ts:388-392` 注释）。
因此：

- 配置路径 → `~/.zcode/cli/config.json`
- 应用路径探测 → 三平台补 `zcode` 可执行文件 + `~/.zcode/cli` 目录
- 配置目录标记 → `~/.zcode`（`getClientConfigMarkers`，与 codebuddy/workbuddy/qoder 同款）

**预期表现**：本机 `~/.zcode/cli/config.json` 尚未生成 → ZCode 先显示为「未安装」。
在 mcp-dock 里往 ZCode 加一个 server 后即自动生成该文件，之后恒显示已安装。这是与 codebuddy/workbuddy/qoder **完全一致**的行为，不是 bug。

### 2. 格式适配（核心）

`readClientConfig` 新增 zcode 分支，与 `openclaw` 同构：

```
config.mcp.servers → mcpServers（command/args/env/cwd + url/type/headers 两类都支持，透传 enable）
```

`writeClientConfig` 新增 zcode 分支：用 `jsonc.modify` 定点改 `['mcp','servers']`，
保留文件里其他所有字段（ZCode 的 config.json 还存着模型/插件等非 MCP 设置，整文件覆盖会丢数据）。

配套三处开关：`defaultConfigForMissing` / `reachesDefaultBranch` / `getServersKey`。

### 3. enable 字段

`McpServerConfig` 加可选 `enable?: boolean`：

- 读：原样带出；
- 写：有就写，没有就不写。

不加这个字段的话，用户在 ZCode 里停用的 server，经 mcp-dock 任一次写回就会被悄悄重新启用。

## 触点清单

### 主进程

| 文件 | 改动 |
|---|---|
| `src/main/config/types.ts` | `ClientType` / `SkillClientType` / `SKILL_SUPPORTED_CLIENTS` / `ALL_BUILTIN_CLIENTS` 四处加 `zcode`；`McpServerConfig` 加 `enable?` |
| `src/main/config/client-probe.ts` | `getDefaultClientPaths` 三平台加 `~/.zcode/cli/config.json`；`getClientDisplayName` 加 `ZCode`；`getClientAppPaths` 三平台加探测路径；`getClientConfigMarkers` 加 `~/.zcode` |
| `src/main/client-paths.ts` | `computeDefaultSkillsPaths` 加 `zcode: ~/.zcode/skills` |
| `src/main/config/format-adapters.ts` | `readClientConfig` / `writeClientConfig` / `defaultConfigForMissing` / `reachesDefaultBranch` 四处加 zcode 分支 |
| `src/main/config-manager.ts` | `getAllClients` clients 数组（L375）；`getAllInstalledServers` clients 数组（L548）+ `byClient` 初始化（L570 附近） |
| `src/main/skills-manager.ts` | `getAllInstalledSkills` 的 `byClient` 初始化加 `zcode: []`（L889 附近） |
| `src/main/history-manager.ts` | 两处硬编码 `skillsPaths`（L117-129、L382-395）收敛为 `computeDefaultSkillsPaths()` |

### 渲染层

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/ClientIcon.tsx` | `CODE_DRAWN_KEYS` 加 `zcode`；新增代码绘制图标分支 |
| `src/renderer/src/components/PlatformConnectionBrowser.tsx` | `SKILL_CLIENTS` 加 `zcode`（L23-34） |
| `src/renderer/src/lib/electron.ts` | mock 客户端列表（L588 附近）、`getAllServers.byClient`（L645）、`installedSkills.byClient`（L708）三处补 `zcode` |

> `ClientType` / `SkillClientType` 在渲染层是从 `main/config-manager` re-export（`electron.ts:16,100`），**无需重复声明**。

### 测试

| 文件 | 改动 |
|---|---|
| `src/__tests__/client-paths.test.ts` | 断言 `paths.zcode === ~/.zcode/skills` |
| `src/__tests__/`（新增或并入现有） | zcode 配置读/写往返 + `enable` 字段透传 |

## 顺带清理（遗留问题）

`history-manager.ts` 仍保留两份硬编码 `skillsPaths` 字面量表（L117-129、L382-395），
而 `client-paths.ts` 的模块注释已声明「三处均委托此处解析」——实际只收口了一处。
这两份表目前与 `computeDefaultSkillsPaths()` 内容重复，本次加 zcode 若不同步就立即漂移。
本次一并替换为 `computeDefaultSkillsPaths()` 调用，行为等价（两处原本都未使用 customSkillsPaths）。

## 风险与验证

- **风险**：`enable` 字段进入 `McpServerConfig` 是 additive，其余 18 个客户端读写路径不受影响（只有 zcode 分支读写它）。
- **验证**：本机 `~/.zcode/` 已存在，可直接端到端验证——加一个 server → 落盘 `~/.zcode/cli/config.json` → 用 ZCode 自身设置页确认能读到。
- **回滚**：纯 additive 改动，删掉 zcode 相关分支即可回到现状，无数据迁移。

## TODOS

- [x] `types.ts`：四处注册表 + `enable?` 字段
- [x] `client-paths.ts`：Skills 路径
- [x] `client-probe.ts`：配置路径 / 名称 / 探测路径 / 目录标记
- [x] `format-adapters.ts`：读 + 写 + 两个开关
- [x] `config-manager.ts` / `skills-manager.ts`：遍历与聚合列表
- [x] `history-manager.ts`：收敛硬编码 skillsPaths
- [x] 渲染层：图标 + SKILL_CLIENTS + electron.ts mock 三处
- [x] 单测：路径断言 + 读写往返
- [x] 类型检查 + 构建冒烟

## 实施记录（2026-09-05）

验证结果：`npm run test` 13 文件 / 172 用例全绿（新增 16 条）；`npm run typecheck` 双 tsconfig 全过。

### 超出原计划的两处收敛

原计划只要求「各列表补 zcode」，实际把清单重复一并消掉了——否则下次加客户端照样要改 3 处数组：

| 位置 | 改法 |
|---|---|
| `config-manager.ts` `getAllClients` / `getAllInstalledServers` | 19 项字面量数组 → `[...ALL_BUILTIN_CLIENTS, 'cloud']` |
| `config-manager.ts` `getAllInstalledServers` 的 `byClient` | 19 行字面量对象 → `Object.fromEntries(clients.map(...))`，与遍历范围同源派生 |
| `skills-manager.ts` `getAllInstalledSkills` 的 `byClient` | 11 行字面量对象 → 由 `SKILL_SUPPORTED_CLIENTS` 派生 |
| `history-manager.ts` 两处 `skillsPaths` | → `resolveSkillsPath(client)`，`client-paths.ts` 顶部「三处均委托此处」自此名副其实 |

净效果：`config-manager.ts` −40 行、`history-manager.ts` −37 行、`skills-manager.ts` −17 行。

### 新增测试文件

- `src/__tests__/config-format-adapters.test.ts`（10 例）：`mcp.servers` 双向转换、`enable` 透传、非 MCP 字段保留、读→写→读往返、分支开关。
- `src/__tests__/client-probe.test.ts`（7 例）：**遍历 `ALL_BUILTIN_CLIENTS`** 断言三平台配置路径 / Skills 目录 / 显示名齐全。这是防「加客户端漏配某平台」的兜底，比逐条硬编码断言更耐用。

### 二次修订（2026-09-05 续）：修复两类缺陷

用户反馈「ZCode 已安装却显示未安装」并指示修复备份，两项均已落地。

**缺陷一：已安装判定口径丢弃了更强信号**

根因：`getAllClients` 中 `const isInstalled = client === 'cloud' ? installed : configExists;`
把 `isClientInstalled(client)`（完整三段式探测，对装了的 ZCode 本应返回 true）整个丢弃，
只用 `configExists`（配置文件存在与否）。ZCode 装了但 `~/.zcode/cli/config.json` 尚未生成
→ `configExists=false` → 误判未安装。

该口径来自提交 `7c2f09a`（李文峰，2026-08-12，"客户端检测优化"），动机注释「删掉配置文件就让
客户端消失」——因果倒置：装了客户端 ≠ 生成过 MCP 配置。

修复：`const isInstalled = client === 'cloud' ? installed : (installed || configExists);`
装了客户端（探测命中）或残留配置文件 → 都判已安装；UI 已有独立 `configExists` 字段区分
「已安装但未配置」。全量口径修正（非 ZCode 特例），避免以后加新客户端重蹈覆辙。

**缺陷二：备份/回滚漏算自定义 Skills 路径（P2-4）**

`history-manager.ts` 两处 `resolveSkillsPath(client)`（均未传 `customSkillsPaths` / `customClients`）
→ 改调 `this.configManager.getSkillsPath(client)`，自动带上用户设置里的自定义路径。
顺带移除 history-manager 对 `resolveSkillsPath` 的 import（已无引用）。

验证：`npm run test` 13 文件 / 172 用例全绿（client-probe.test.ts 新增本机相关断言）；
`npm run typecheck` 双 tsconfig 全过。本机构造 `ConfigManager` 的完整端到端受限于测试环境缺
Electron（`cloud` 分支的 `app.getPath`），改用「`getClientConfigMarkers('zcode')` 指向本机存在的
`~/.zcode`」间接证明 isClientInstalled 命中，逻辑链闭合。
