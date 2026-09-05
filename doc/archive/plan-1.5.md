# plan-1.5 · 历史记录：补 Skill 内容变更（skillsModified）

> 追加：plan-1.6 已并入本文档（同一批改动，见文末「附录 · 清单计数口径与客户端图标」）。

## 背景与目标

历史记录此前**只比 Skill 名字、不比 Skill 内容**：

- `backupSignature` 含 `skillContents` → 内容变了会**新建**备份记录；
- `getDiff` 只做名字集合差分 → 点开该记录，差异弹窗显示「无变更」。

表现为：编辑一个已存在 Skill 的正文/描述（不改名、不增删）后，历史记录多出一条、却看不到改了什么。

目标：让这类变更在差异弹窗里显示为 `~ 已修改`，并**保证不误报**。

## 范围与边界

**做**

- `getDiff` 增加 Skill 内容比较（名字未变、SKILL.md 变了 → modified）。
- 类型同步到三处声明方。
- 差异弹窗展示 modified（统计 + 按客户端详情）。
- 补单测。
- （plan-1.6）`listBackups` 计数口径统一 + 客户端图标收敛，见文末附录。

**暂不做**（已与用户确认）

- 正文级 diff 对照（方案 B）——用户选 A，仅列名字。
- 补 `skills:sync-batch` / `skills:sync-to-cloud-resolved` 的 `backup()`（原 4.C）。
- 引入 hash / content-addressed 存储——实测备份总量仅 2.51 MB（13 条，198 KB/条，上限 50 条 ≈ 10 MB），
  且算 hash 仍需先读全文（IO 不省），收益/复杂度比不成立。
- 修改 `backup()` 写入侧跳过空客户端（方案 C）——`restore()` 依赖 `data.clients` 覆盖全部客户端
  来写回配置，跳过空客户端会导致回滚时其残留配置不被清空，已评估为回归风险，未采纳。

## 实现思路

### 核心取舍：保守比较，宁可不报也不错报

内容比较**仅当前后两条备份都采到该客户端的 `skillContents` 时才进行**：

- 旧备份（P1-3 之前产生）**没有** `skillContents` 字段 → 不比，否则 target 有内容 / prev 为 `undefined` 会被判成全量 modified；
- 某侧因自定义 Skills 路径或读取失败而缺失该客户端内容 → 不比（与 `restoreSkillSnapshots` 已有的「旧备份仅尽力回滚」策略一致）。

即：字段缺失 ≠ 内容变更。

### 触点

| 文件 | 改动 |
|---|---|
| `src/main/history-manager.ts` | `DiffResult` 加 `skillsModified`；`skillClientChanges` 加 `modified`；`getDiff` 内新增内容比较 + 守卫 |
| `src/renderer/src/lib/electron.ts` | 类型同步（渲染层实际使用的那份，History.tsx 从此 import） |
| `src/preload/index.ts` | 类型同步（preload 编译单元自有声明） |
| `src/preload/index.d.ts` | 类型同步（桥接声明） |
| `src/renderer/src/pages/History.tsx` | 统计区加 `~N 修改`；详情区两个分支都渲染 modified |
| `src/__tests__/history-manager.test.ts` | 3 条新用例：内容变更 / 内容未变 / 旧备份跳过 |

### 风险与回滚

- 纯读路径改动，**不动 `backup()` 写入逻辑**，不影响任何已生成的备份文件。
- 新增字段均为 additive；`skillsModified` 与 `skillsAdded`/`skillsRemoved` 同为必选，构造点仅 `getDiff` 一处。
- `History.tsx` 对 `cc.modified` 用 `(cc.modified || [])` 兜底，兼容旧 IPC 数据。
- 回滚：`git checkout --` 上述 6 个文件即可，无数据迁移。

## 验证

- `tsc -p tsconfig.main.json --noEmit`：`history-manager.ts` **0 错误**；
  其余报错（`Cannot find module 'electron'`、`jsonc-parser`）为**既有**依赖未装全，与本次改动无关。
- 逻辑验证 **20/20 通过**（含 4 组回归）：内容变更 / 内容未变 / 旧备份在上一条 / target 侧缺失 /
  纯新增 / 纯删除 / 混合。

> 环境限制：`vitest` 因缺间接依赖 `fdir` 无法启动（`ERR_MODULE_NOT_FOUND`，既有问题，非本次引入）。
> 故改用 `tsc` 转译 `history-manager.ts` + stub 掉 `config-manager`，以 Node 直接跑真实代码验证；
> 新增的 vitest 用例待依赖修复后由 `npm test` 覆盖。

## TODOS

- [x] 主进程 `getDiff` 补 Skill 内容变更比较（含旧备份兼容守卫）
- [x] 同步三处 `DiffResult` 类型（preload/index.ts、preload/index.d.ts、renderer/lib/electron.ts）
- [x] History.tsx 差异弹窗展示 Skill「已修改」统计与详情
- [x] 补单测并完成验证

---

# 附录 · plan-1.6：清单计数口径与客户端图标

## 背景与实测

用户反馈「历史记录清单数据是不是写死了？感觉不太对」「客户端 logo 不要全部显示出来」。

数据**不是写死的**——`listBackups` 纯读 `~/.ai-tools/backups/backup-*.json`。
唯一的假数据是非 Electron 环境的降级 stub（`renderer/src/lib/electron.ts` 的 `list: async () => []`）。

但数字确实失真，Node 解析本机 13 条真实备份的实测结果：

| 指标 | 改前 | 改后 |
|---|---|---|
| 每条 `clients` 数 | **19**（18 内置 + `custom:trae-work`） | **3** |
| 其中空客户端 | 16（84.2%） | 0 |
| `serverCount` | 22（累加） | **11**（去重） |
| `skillCount` | 9（去重） | 9（不变） |

## 根因

1. **空客户端落盘**：`backup()` 无条件遍历 `getClientTypes()`（18 内置 + 自定义）；
   `readConfig` 遇 ENOENT **返回 `defaultConfigForMissing` 而非抛错**，
   故 `try/catch` 永不触发，未安装的客户端也以 `{config:{mcpServers:{}}, serverCount:0}` 落盘。
2. **`clientList` 不过滤**：把 `data.clients` 的全部 key 都 push，19 个图标全渲染。
3. **计数口径不一致**：`serverCount` 跨客户端**累加**、`skillCount` 跨客户端**去重**，
   两个数字并排展示却算法不同——同一份数据算出 22 与 11，正是"数据不太对"的观感来源。

## 改动（方案 B）

| 文件 | 改动 |
|---|---|
| `src/main/history-manager.ts` | `listBackups`：`serverCount` 改跨客户端去重（Set of server id）；`clientList` 只收 `有 server 或 有 skill` 的客户端；`BackupInfo` 三字段补语义注释 |
| `src/renderer/src/lib/electron.ts` | `BackupInfo` 注释同步 |
| `src/renderer/src/pages/History.tsx` | 新增 `MAX_CLIENT_ICONS = 5`；图标 `slice(0,5)` + 超出显示 `+N`；容器加 `title` 列出全部客户端名；`skillCount` 改为**恒显示**（含 0） |
| `src/__tests__/history-manager.test.ts` | 新增 3 用例：serverCount 去重 / clients 过滤空客户端 / skill 去重统计 |

**只改读取侧，`backup()` 写入逻辑一行未动**，不影响任何已生成的备份文件，无数据迁移。

## 验证

- 转译真实代码 + Node 直跑：**13/13 通过**（3 条新口径 + 7 条既有用例回归 + 2 条真实数据断言）。
- 真实数据：最新一条 `clients` 19 → **3**，`serverCount` 22 → **11**。
- `tsc -p tsconfig.main.json --noEmit`：`history-manager.ts` 0 错误；测试文件独立检查 EXIT=0。
- IDE lint 无 ERROR（仅既有风格 WARNING）。

## TODOS

- [x] `listBackups`：clientList 过滤空客户端 + serverCount 改为跨客户端去重
- [x] History.tsx：图标上限 5 + `+N`；skillCount 恒显示
- [x] 补单测并完成验证

---

# 附录 · 自定义客户端图标：按名称关键字匹配

## 需求

`custom:trae-work` 这类自定义客户端此前一律显示灰色兜底图标。
要求：名称中包含已知客户端关键字（如 `trae`）时复用其图标，否则仍用兜底。

## 关键事实

- **slug 派生规则**（`config-manager.ts:165`）：
  `name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client'`
  → 「Trae Work」派生为 `trae-work`，id 为 `custom:trae-work`。
- `ClientIcon` 被 **9 个文件**引用（History / Settings / Detail / SkillDetail /
  PlatformServerDetail / LibrarySkillList / LibraryMcpList / ClientMultiSelect），
  故改在组件内部即可全站生效，无需改动任何调用点。

## 改动

| 文件 | 改动 |
|---|---|
| `src/renderer/src/lib/client-icon-key.ts`（新增） | 纯函数 `resolveIconKey(clientId, candidates)`，**最长匹配**，零依赖 |
| `src/renderer/src/components/ClientIcon.tsx` | 新增 `CODE_DRAWN_KEYS` / `ICON_MATCH_CANDIDATES`；组件内改用 `iconKey` 判定各分支；`alt` 仍用真实 `clientId` |

### 两个设计要点

1. **最长匹配而非首个匹配**。`trae` 与 `trae-cn` 都是候选，slug `trae-cn-2` 会同时命中两者；
   首个匹配会错选 `trae`。取最长命中项才正确。
2. **候选集必须含代码绘制的客户端**。jetbrains / agent-skills / codebuddy / workbuddy / qoder / cloud
   的图标由 JSX 分支绘制，**不在** `ClientIconMap` 里（其中 `codebuddy` 显式置 `undefined` 以走代码分支）。
   只拿 `Object.keys(ClientIconMap)` 做候选的话，这些名字的自定义客户端仍会落到兜底。
   候选集 = `new Set([...Object.keys(ClientIconMap), ...CODE_DRAWN_KEYS])`，单一来源。

## 验证

转译真实 `client-icon-key.ts` + Node 直跑：**20/20 通过**。

覆盖：核心匹配（trae-work / my-cursor-2 / codebuddy-test / jetbrains-ultimate / workbuddy-pro）、
无匹配兜底（foobar / client / 空 slug）、最长匹配（trae-cn-2→trae-cn、gemini-cli-x→gemini-cli、
my-workbuddy→workbuddy）、内置 id 原样透传、边界（空串、大写前缀）。

`tsc -p tsconfig.json --noEmit`：两文件 0 错误；IDE lint 0 问题。

> 注：渲染层无组件测试环境（`vitest.config.ts` 为 `environment: 'node'`，无 jsdom），
> 故将匹配算法抽为零依赖纯函数以便独立验证，而非把断言写进组件测试。

## TODOS

- [x] 抽出 `resolveIconKey` 纯函数（最长匹配）
- [x] ClientIcon 接入，候选集含代码绘制客户端
- [x] 验证 20/20 + 类型检查
