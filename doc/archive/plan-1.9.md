# plan-1.9 · TRAE 系列支持 Skills 同步（接 plan-1.8）

## 背景与根因

用户在「我的库 → 技能同步」中发现 trae / trae-solo-cn 不在可选客户端列表中。
经本机实测 + 官方文档核实（2026-09-05，非推测）：

- 探测逻辑正确：`trae-solo-cn` 已安装（exe 命中）、`workbuddy` 已安装（marker + config 命中），二者 `installed=true`。
- 技能同步弹窗过滤（`Library.tsx:1078`）：`c.installed && c.supportsSkills && !alreadyAll`。
- `trae` / `trae-cn` / `trae-solo-cn` 均不在 `SkillClientType` / `computeDefaultSkillsPaths` / `SKILL_SUPPORTED_CLIENTS`，
  故 `supportsSkills=false` → 被过滤器整条剔除。
- `workbuddy` 已在 `SKILL_SUPPORTED_CLIENTS` 内，不在列表仅因本次同步的技能它**已装过**（`alreadyAll=true`），属设计行为，**本次不改**。

plan-1.8 当时显式决定不加 Skills 支持（边界「TRAE 系均不在 SKILL_SUPPORTED_CLIENTS，SOLO 亦然，不加」），
本次补上该缺口。

## Skills 目录（已核实，非臆测）

来源：docs.trae.ai 官方文档 + 本机目录实测。

| 客户端 | skills 目录 | 依据 |
|---|---|---|
| `trae`（国际版 Trae IDE） | `~/.trae/skills`（Win `%userprofile%\.trae\skills`） | docs.trae.ai 官方文档；本机无 `~/.trae`（用户未装国际版） |
| `trae-cn` | `~/.trae-cn/skills`（Win `%userprofile%\.trae-cn\skills`） | 社区文档（引 TRAE 官方）+ 本机 `~/.trae-cn` 真实存在 |
| `trae-solo-cn`（TRAE SOLO CN / TRAE Work 桌面版） | `~/.trae-cn/skills` | 同上；用户实际装的是此版，`~/.trae-cn` 已存在，`~/.trae-cn/skills` 待写入时由 `ensureSkillsDir` 自动 mkdir |

> 注：`trae-cn` 与 `trae-solo-cn` 同指 CN 家目录 `~/.trae-cn`，与它们共享同一 skills 根（产品层差异，目录一致）。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/main/config/types.ts` | `SkillClientType` 增加 `trae` / `trae-cn` / `trae-solo-cn`；`SKILL_SUPPORTED_CLIENTS` 同步三项 |
| `src/main/client-paths.ts` | `computeDefaultSkillsPaths` 增加 `trae: ~/.trae/skills`、`trae-cn` / `trae-solo-cn`: `~/.trae-cn/skills` |
| `src/renderer/src/components/PlatformConnectionBrowser.tsx` | `SKILL_CLIENTS` 增加三项 |
| `src/renderer/src/lib/electron.ts` | mock `clients` 中 trae / trae-cn / trae-solo-cn 的 `supportsSkills:false→true`，补 `skillsPath` |
| `src/__tests__/skills-manager.test.ts` | 测试内硬编码 `SKILL_SUPPORTED_CLIENTS` mock 补三项（防漂移） |
| `doc/软件介绍.md` | 「12 个 Skills 客户端」 → 「15 个 Skills 客户端」 |

> `config-manager.ts` / `skills-manager.ts` / `getAllInstalledSkills` 均无需改：
> 遍历取自 `SKILL_SUPPORTED_CLIENTS`（派生 `byClient`）与 `computeDefaultSkillsPaths`，纯 additive。

## 风险与验证

- **风险**：纯 additive；既有 19 个 MCP 客户端 + 12 个 Skills 客户端行为不变。
- **验证**：
  1. `npm run typecheck` 退出码 0（`SkillClientType` 收窄后类型一致）。
  2. `npm run test` 全绿；`client-probe.test.ts` 的 `SKILL_SUPPORTED_CLIENTS` 遍历断言会覆盖新三项（要求 `computeDefaultSkillsPaths` 含对应路径）。
  3. 本机重开「我的库 → 技能」→ 选技能 → 同步：列表出现 **TRAE / TRAE CN / TRAE SOLO CN**，且 trae-solo-cn 指向 `~/.trae-cn/skills`。
- **回滚**：删掉上述表项即可，无数据迁移。

## TODOS

- [x] `types.ts`：`SkillClientType` + `SKILL_SUPPORTED_CLIENTS`
- [x] `client-paths.ts`：`computeDefaultSkillsPaths`
- [x] `PlatformConnectionBrowser.tsx`：`SKILL_CLIENTS`
- [x] `electron.ts`：mock `clients` 三项 `supportsSkills` + `skillsPath`；另补 `installedSkills.byClient` 三项 key（typecheck 抓出的第 4 处硬编码 mock）
- [x] `skills-manager.test.ts`：mock `SKILL_SUPPORTED_CLIENTS` 补三项
- [x] `doc/软件介绍.md`：Skills 客户端计数 12 → 15；`doc/README_CN.md` Skills 表补 ZCode / TRAE 三项 / Cloud（原有漂移一并修正）
- [x] typecheck + test 全绿

## 实施记录（2026-09-05）

- `npm run typecheck` 退出码 0。
- `npm run test`：175/176 绿；唯一失败为 `env-manager.test.ts` 的 npx 探测用例（环境依赖，本次未触碰 env-manager，属存量环境问题，与本改动无关）。
- 相关三文件单独跑：`client-probe.test.ts` + `client-paths.test.ts` + `skills-manager.test.ts` = 57/57 全绿；
  其中 client-probe 的「每个 SKILL_SUPPORTED_CLIENTS 都有 skills 目录」遍历断言自动覆盖新增的 TRAE 三项。

## 顺带审计：其他「已安装客户端显示」站点（用户要求）

全仓 grep `\.installed|supportsSkills|configExists` 审计所有过滤/展示点，结论：**无其他问题**。

| 站点 | 过滤条件 | 结论 |
|---|---|---|
| Library.tsx:1047/1063（服务器同步） | `installed && 未装过` | 正确 |
| Library.tsx:1084（技能同步） | `installed && supportsSkills && 未装过` | 本次修复后正确 |
| Library.tsx:440（技能批量导出） | `supportsSkills && installed` | 正确 |
| SkillDetail.tsx:862（装技能） | `installed && supportsSkills` + 已装禁用 | 正确 |
| CreateSkillModal.tsx:32 | `supportsSkills && installed` | 正确 |
| AddServerModal.tsx:56 / Detail.tsx:1051 / PlatformServerDetail.tsx:599 | `installed` | 正确 |
| Settings.tsx:341-424（已装/未装分组） | `installed` + `configExists` 徽标 | 正确 |
| PlatformConnectionBrowser.tsx:122 | 白名单 + `installed` | 已与 SKILL_SUPPORTED_CLIENTS 同步 |

- 主进程无残留硬编码客户端数组（plan-1.7 的收敛仍然成立，`'workbuddy'` 字面量仅存于 types.ts 单一来源与 client-probe 路径表）。
- `getInstalledSkills` 对不存在的 skills 目录有 try/catch 兜底，`~/.trae*/skills` 未创建时安全返回空。

## 二次修订（2026-09-05 下午）：共享 Skills 目录去重

### 问题

用户反馈：只安装了 TRAE SOLO CN（trae-solo-cn），技能同步后显示「装了两个客户端」（trae-cn + trae-solo-cn）。

本机实证（17:44 时间戳）：`~/.trae-cn/skills/` 出现 novel-audit / novel-write-pro；trae-cn 的 app 目录与 config 均不存在（确未安装）。

### 根因

本 plan 首版把 `trae-cn` 与 `trae-solo-cn` 的 skills 目录都指向 `~/.trae-cn/skills`（TRAE SOLO CN 的
`dataFolderName=.trae-cn`，与经典 Trae CN 撞名，产品层事实，无法分开）。`getAllInstalledSkills` 与
`getLocalSkillDetail` 按 `SKILL_SUPPORTED_CLIENTS` 逐客户端扫描，同一物理目录被扫两次 → 同一批技能归属两个 id。

### 修复（通用解：按物理目录分组 + 安装态归属）

`skills-manager.ts`：
- 从 `getInstalledSkills` 抽出 `scanSkillsDir`（物理目录级扫描，行为不变）；
- 新增 `resolveScanGroups(installedClients?)`：按 `normalizeDirKey`（resolve + win32 小写）将
  `SKILL_SUPPORTED_CLIENTS` 分组，同物理目录合组、只扫一次；owners = 组内已安装者，
  组内无已安装者或缺省注入时回退全组（保持历史行为）；
- `getAllInstalledSkills(installedClients?)` / `getLocalSkillDetail(skillId, installedClients?)` 改按组归属。

`index.ts`：`skills:get-all-installed` / `skills:get-local-detail` 两个 handler 由 `configManager.getAllClients()`
取 installed 集合注入。

语义：只装 trae-solo-cn → 技能只归 trae-solo-cn（本 bug 修复）；两个产品都装了 → 归属双方（技能确实同时生效，显示两个是诚实的）。

### 排除项

- MCP 侧无此问题：trae-cn 与 trae-solo-cn 的 mcp.json 物理路径不同（`Roaming\Trae CN` vs `Roaming\TRAE SOLO CN`）。
- 云端冲突检测（`detectCloudConflicts`）按「技能 + 单一 sourceClient」逐条处理，不遍历客户端全集，无重复。

### 验证

- typecheck 0 错；`skills-manager.test.ts` 45/45（新增 5 个去重用例：单装归属 / 双装归属 / 缺省回退 / 分组断言 / detail 归属）；
  全量 180/181（唯一失败仍为 env-manager npx 环境依赖存量用例，与本次无关）。
- 本机重启应用后：技能列表中 novel-audit / novel-write-pro 应只显示「已安装于 TRAE SOLO CN」。
