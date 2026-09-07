# plan-2.0 · 客户端口径统一：设置页 / 我的库 / 技能安装目标全对齐

## 背景与根因

用户反馈「设置-支持的客户端-显示的客户端跟实际有区别：设置里没有安装，我的库技能有安装」。
经全面扫描（2026-09-07，代码实证，非推测），根因是**客户端列表有 5 份、安装判定有 2 套口径**：

| # | 列表 | 位置 | 内容 | 问题 |
|---|------|------|------|------|
| 1 | `ALL_BUILTIN_CLIENTS` | `src/main/config/types.ts:80` | 20 内置 + cloud | MCP 真源，设置页数据源 |
| 2 | `SKILL_SUPPORTED_CLIENTS` | `src/main/config/types.ts:77` | 15 项（含 agent-skills、cloud） | Skill 真源 |
| 3 | `SKILL_CLIENTS` 硬编码 | `PlatformConnectionBrowser.tsx:23` | 14 项（含 agent-skills、无 cloud） | 手工复制真源，注释自认须同步，plan-1.9 已漂移过一次 |
| 4 | `getAllClients().filter(supportsSkills)` | `SkillDetail.tsx:311` | 13 内置 + cloud + custom | **不含 agent-skills** |
| 5 | 英文 README Skills 表 | `doc/README.md:98` | 11 项 | **缺 ZCode / TRAE / TRAE CN / TRAE SOLO CN**（plan-1.9 只修了中文版） |

### 问题清单（按与用户现象的关联排序）

- **P1 · agent-skills 缺失于客户端注册表（用户现象主因）**
  `agent-skills`（`~/.agents/skills` 统一标准）在 `SKILL_SUPPORTED_CLIENTS`，技能能装、我的库能扫
  （`skills-manager.ts:1022` 按全量 15 键扫描，不校验 installed），
  但不在 `ClientType` / `ALL_BUILTIN_CLIENTS` → `getAllClients()` 无此项 → 设置页没有它的卡片、
  技能详情页安装目标选不到它；直连来源浏览器（列表 3）却选得到。三个入口三个口径。
- **P2 · 安装探测与技能扫描口径不一致（用户现象次因）**
  设置页 installed = 本体探测（exe/marker/CLI）‖ MCP 配置文件存在（`config-manager.ts:394`）；
  我的库只要 skills 目录有技能就计入。`getClientConfigMarkers`（`client-probe.ts:395`）仅覆盖
  codebuddy/workbuddy/qoder/zcode/openclaw/marscode 六个目录 marker，
  cursor(`~/.cursor`)/claude-code(`~/.claude`)/gemini-cli(`~/.gemini`)/trae(`~/.trae`)/trae-cn(`~/.trae-cn`)/
  agent-skills(`~/.agents`) 均缺 → 只装过技能、未配过 MCP、exe 探测不命中时，设置页显示未安装而库里有技能。
  另 gemini-cli win32 探测缺 npm 路径（`AppData/Roaming/npm/gemini.cmd`）。
- **P3 · renderer 硬编码列表漂移**（同列表 3）。
- **P4 · 英文 README Skills 表缺 4 项**（同列表 5；中文版已全，英文版是 plan-1.9 遗漏）。
- **P5 · 自定义客户端技能在「我的库」不可见（反向缺口）**
  `getAllInstalledSkills` 遍历固定 `SKILL_SUPPORTED_CLIENTS`，custom 客户端（supportsSkills=true）装的技能扫不到。
- **P6 · 设置页无 Skill 能力标识**：`supportsSkills` 字段存在但 UI 未渲染，用户分不清哪 7 个客户端（vscode/windsurf/zed/kiro/jetbrains/antigravity/openclaw）不能装技能。
- **P7 · cloud 出现在技能详情页安装目标**（`SkillDetail.tsx:311` 过滤后含 cloud；直连浏览器明确排除 cloud）——大概率是云同步暂存的设计意图，**默认不动，待确认**。

## 范围与边界

**做**

1. agent-skills 以「虚拟客户端」身份进 `getAllClients()`（仿 cloud 模式）——设置页有卡片、技能详情页安装目标可选。
2. `ClientInfo` 新增 `supportsMcp` 字段（单一真源），收口 Settings / Detail / PlatformServerDetail 三处 `c.id !== 'cloud'` 魔法字符串过滤，MCP 安装目标统一排除 cloud + agent-skills。
3. `PlatformConnectionBrowser.tsx` 删除硬编码 `SKILL_CLIENTS`，改运行时 IPC 获取（消灭 P3 漂移源）。
4. 补 `getClientConfigMarkers` 目录 marker（P2）+ gemini-cli win32 npm 探测路径。
5. `getAllInstalledSkills` / `resolveScanGroups` 遍历范围加 custom 客户端（P5）。
6. 设置页客户端卡片加 Skill 能力角标（P6，轻量）。
7. 英文 README Skills 表补齐 4 项（P4）；`doc/软件介绍.md` 复核。
8. 单测补齐 + typecheck 全绿。

**不做**（理由）

- **agent-skills 不进 `ClientType` / `ALL_BUILTIN_CLIENTS`**：会污染 MCP 备份遍历
  （`getClientTypes`，`config-manager.ts:207`）与 MCP 服务器扫描（`getAllInstalledServers`，`config-manager.ts:549`），
  需要在多处再写排除逻辑，违背 ALL_BUILTIN_CLIENTS 单一来源设计；cloud 虚拟客户端先例（不在列表、单独追加）证明
  现有模式可行且改动面最小。
- **不改 `getAllInstalledSkills` 的「目录有技能即计入」口径**：残留目录算已安装与现有
  「残留配置文件也算已安装」（`config-manager.ts:394`）口径一致，只补探测 marker 让设置页对齐，不反向收紧。
- **P7（cloud 在技能安装目标）不动**，执行时顺带向用户求证。
- 不引入 `MCP/Skill` 双能力之外的 UI 重构（角标轻量实现）。

## 实现思路

### 关键取舍

| 决策点 | 选择 | 理由 |
|--------|------|------|
| agent-skills 建模 | 虚拟客户端（仿 cloud） | 不污染 MCP 遍历；有先例；改动面最小 |
| MCP 目标过滤 | `supportsMcp` 字段（main 真源） | 三处 UI 魔法字符串收口，加 agent-skills 时不再扩散 |
| renderer 技能列表 | 运行时 `getAllClients().filter(supportsSkills && id !== 'cloud')` | 与 SkillDetail 同模式，单一真源 |
| P2 修复方向 | 补探测 marker（设置页对齐库） | 库显示技能是事实（目录真有技能），反向隐藏会丢信息 |

### 触点清单

| 文件 | 改动 |
|------|------|
| `src/main/config-manager.ts` | `getAllClients()`：遍历数组追加 `'agent-skills'`（cloud 前）；`supportsSkills` 对 agent-skills 恒 true；新增 `supportsMcp` 字段（cloud/agent-skills=false，其余=true，custom=true）；installed 探测对 agent-skills 走 `~/.agents` marker |
| `src/main/config/client-probe.ts` | `getClientDisplayName` 加 `agent-skills: 'Agent Skills (.agents)'`；`getClientConfigMarkers` 补 cursor/claude-code/gemini-cli/trae/trae-cn/agent-skills；win32 `gemini-cli` appPaths 补 `AppData/Roaming/npm/gemini.cmd` |
| `src/renderer/src/lib/electron.ts` | `ClientInfo` 类型加 `supportsMcp`；mock `clients` 补 agent-skills 卡片与 supportsMcp 字段 |
| `src/renderer/src/pages/Settings.tsx` | `filter(c => c.id !== 'cloud')` 改 `filter(c => c.supportsMcp)`；编辑弹窗 `supportsMcp=false` 时隐藏 MCP 路径输入；卡片加 Skill 角标（supportsSkills 时） |
| `src/renderer/src/pages/Detail.tsx` / `PlatformServerDetail.tsx` | `c.installed && c.id !== 'cloud'` 改 `c.installed && c.supportsMcp` |
| `src/renderer/src/components/PlatformConnectionBrowser.tsx` | 删 `SKILL_CLIENTS` 硬编码，改 `api.clients.getAll()` 运行时过滤 `supportsSkills && supportsMcp`（cloud/agent-skills 中 agent-skills 保留、cloud 排除） |
| `src/main/skills-manager.ts` | `resolveScanGroups` / `getAllInstalledSkills` 遍历列表 = `SKILL_SUPPORTED_CLIENTS` + customClients 中 supportsSkills 项；`byClient` 类型放宽 `Record<string, InstalledSkill[]>` |
| `src/main/index.ts` | `skills:get-all-installed` 注入的 installed 列表保持（无需改，custom 已含于 getAllClients） |
| `doc/README.md` | Skills Clients 表补 ZCode / TRAE / TRAE CN / TRAE SOLO CN |
| `src/__tests__/client-probe.test.ts` | 补断言：agent-skills 显示名、marker 命中、`getAllClients` 含 agent-skills 且 `supportsMcp=false`、SKILL_SUPPORTED_CLIENTS 与 `computeDefaultSkillsPaths` 键对齐（已有则确认覆盖） |

### 步骤

1. main 层：client-probe.ts（显示名/marker/npm 路径）→ config-manager.ts（虚拟项 + supportsMcp）。
2. 类型层：electron.ts ClientInfo + mock。
3. renderer 层：三个页面过滤替换 + PlatformConnectionBrowser 去硬编码 + Settings 角标/弹窗。
4. skills-manager custom 扫描（P5）。
5. 文档 + 测试 + 全量验证。

### 风险与回滚

- **风险 1**：agent-skills 卡片 `configPath` 为空 → 设置页 code 标签显示空。处理：`configPath` 给
  `~/.agents`（显示目录名，编辑弹窗隐藏 MCP 输入）；`configExists('')` 抛错已被 try/catch 吞掉，无害。
- **风险 2**：`getAllClients` 缓存（`clientsCache`）不含 agent-skills 结构变更 → 无影响，运行时重新探测。
- **风险 3**：supportsMcp 为新增字段，UI 旧数据无该字段（mock/测试）→ typecheck 强制全改，无隐式 undefined。
- **风险 4**：`byClient` 类型放宽可能影响 Library.tsx 的 `as SkillClientType` cast 语义 → cast 仅用于键入 map，行为不变。
- **回滚**：全部为 additive/等价替换，按触点逐文件 revert 即可，无数据迁移。

### 验证

1. `npm run typecheck` 退出码 0。
2. `npm run test` 全绿（含新增断言）。
3. 手动（本机）：
   - 设置页出现 **Agent Skills (.agents)** 卡片（`~/.agents` 存在时显示已安装）；
   - 已装 agent-skills 技能的用户：设置页该客户端不再「缺席」；
   - 技能详情页安装目标出现 agent-skills；MCP 服务器安装目标（Detail / PlatformServerDetail）**不出现** agent-skills 与 cloud；
   - 直连来源浏览器安装目标与技能详情页一致；
   - `~/.gemini/skills` 有技能的机器：设置页 Gemini CLI 显示已安装（marker 命中）；
   - 自定义 supportsSkills 客户端装的技能在「我的库」可见。

## TODOS

- [x] client-probe.ts：agent-skills 显示名 + markers 补齐 + gemini-cli win32 npm 路径
- [x] config-manager.ts：getAllClients 追加 agent-skills 虚拟项 + supportsMcp 字段
- [x] electron.ts：ClientInfo 类型 + mock 补 agent-skills / supportsMcp
- [x] Settings.tsx / Detail.tsx / PlatformServerDetail.tsx：supportsMcp 过滤替换
- [x] PlatformConnectionBrowser.tsx：删硬编码 SKILL_CLIENTS，改运行时获取
- [x] Settings.tsx：编辑弹窗 supportsMcp=false 隐藏 MCP 路径；卡片 Skill 角标
- [x] skills-manager.ts：getAllInstalledSkills / resolveScanGroups 纳入 custom 客户端
- [x] doc/README.md：Skills 表补 ZCode / TRAE / TRAE CN / TRAE SOLO CN；软件介绍.md 已确认无需改
- [x] client-probe.test.ts：新增断言（虚拟客户端显示名 / markers 全覆盖 / agent-skills 防回归 / npm 探测路径）
- [x] typecheck + test 全绿（196/196 通过；见下方执行备注的二次修正）
- [ ] 手动验证清单过一遍；顺带向用户求证 P7（cloud 在技能安装目标是否设计意图）

## 执行备注（2026-09-07）

- 执行中修正：trae-solo-cn 与 trae-cn 同样**不加**目录 marker（共享 ~/.trae-cn 撞名，
  plan-1.8 已有先例决策，exe 探测足够），原计划只排除 trae-cn，测试断言已同步收窄。
- 执行中修正：codex-cli 的目录探测原本混在 appPaths（`~/.codex`），已统一收口到 markers 表。
- i18n：新增 `settings.skillCapable`（zh/en），`clientsDesc` 文案同步更新为「MCP 客户端与技能客户端」。
- **用户验证后二次修正（P2 方向纠偏）**：首轮曾给 claude-code / gemini-cli / cursor / codex-cli / trae /
  opencode 补目录 marker，导致「没装 Claude Code 本体却显示已安装」——这些客户端的家目录
  （`~/.claude` 等）可能只是 mcp-dock 安装技能时 mkdir 出来的或卸载残留，不代表本体安装。
  已回退，目录 marker 仅保留两类：插件形态（codebuddy / workbuddy / qoder / zcode / openclaw / marscode，
  原有行为）与纯目录标准（agent-skills 的 `~/.agents`）。exe 类客户端的「已安装」只认
  exe / npm / CLI where 探测（configExists 残留配置口径不变）。测试同步改为防回归断言。
- 已知遗留（未动，待用户决策）：codex-cli 在三平台 appPaths 中仍含裸目录 `~/.codex`（历史行为，
  非本轮引入），与「目录不算本体安装」的新口径不一致，如需彻底统一可后续移除。
