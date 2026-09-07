# plan-3.0 · 云端一致性：不一致主动提示 + 双方时间展示 + 对照查看

> 版本：3.0（2026-09-07 起始） · 前任：doc/archive/plan-2.0（客户端口径统一，代码已完成）
> 遗留随迁：P7 —— cloud 出现在技能详情页安装目标是否设计意图，待用户求证。

## 背景与目标

用户要求：**多客户端与云端必须保持一致；出现不一致时立即提示用户处理，提示显示不一致两者的更新时间，并提供对照查看功能。**

现状扫描结论（2026-09-07，代码实证）：

| 环节 | 现状 | 差距 |
|------|------|------|
| 技能上传（本地→云端） | 已有冲突检测（detectCloudConflicts：updatedAt/mtime 比对 + 弹窗显示双方时间 + 覆盖/跳过） | 达标，复用 |
| MCP 上传 | `syncServersBatch(['cloud'])` 直接覆盖，无检测 | 需补「完整覆盖确认」 |
| 云端→本地客户端 | `syncBatch`/`syncServer` 直接覆盖本地，无检测 | 需补「新覆盖旧」冲突防护 |
| 主动一致性提示 | 仅技能上传时被动检测；进 Library / 启动 pull 后不提示 | 需补主动扫描 + banner |
| 对照查看 | 冲突弹窗只有名称+时间 | 需补内容对照弹窗 |
| 启动自动 pull | `gitPull` 用 `reset --hard FETCH_HEAD` 强制覆盖暂存区 | 未推送改动可能被冲掉，需脏检查防护 |

用户已拍板的设计决策：
1. 检测范围：本地客户端版本 vs 云端（按时间/内容）；涉及云端的同步默认「新覆盖旧」；手动上传提示「是否完整覆盖」。
2. MCP 时间口径：内容比对（JSON 不一致即报）+ 文件级 mtime 展示（标注「文件修改时间」）。
3. 提示深度：banner + 对照弹窗（左右并排，差异行高亮）。

## 范围与边界

**做**

1. main：一致性检测模块 `src/main/cloud-consistency.ts`（技能双向 + MCP 内容比对）+ IPC `cloud-sync:check-consistency`。
2. main：对照内容读取 IPC（本地端 / 云端端的 SKILL.md 与 server JSON）。
3. renderer：Library 顶部一致性 banner（数量摘要 + 明细 + 逐项/批量操作）。
4. renderer：`ConsistencyCompareModal` 对照弹窗（左右并排 + 差异行高亮）。
5. renderer：云端→本地同步前的冲突检测接入（技能复用现有弹窗；MCP 补同类弹窗），默认「新覆盖旧」。
6. renderer：MCP 手动上传前的「完整覆盖云端？」确认弹窗（列出将变化的 server，不比新旧）。
7. main：git 模式启动 pull 前的暂存区脏检查（脏则跳过 pull 并在同步任务中提示）。
8. i18n（zh/en）+ 单测 + typecheck/test 全绿。

**不做**（理由）

- 本地客户端互检（Cursor vs Claude Code 的版本差异）——本地多客户端版本不同是常态，报出来噪音大于价值；用户选择的范围也仅「本地 vs 云端」。
- MCP per-server 时间戳元数据（.meta.json 方案）——用户已选内容比对+文件时间，避免数据格式侵入。
- SFTP 模式的启动 pull 脏检查——SFTP 为覆盖式下载无本地提交概念，风险场景（上次上传未完成）由同步任务队列串行化缓解，本轮不动。
- 复杂 diff 算法（Myers 等）——行集合比对 + 高亮足够，不引第三方依赖。

## 实现思路

### 关键取舍

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 检测数据源 | 云端=本地暂存区（`~/.ai-tools/cloud/ai-tools`） | 暂存区与远端同构，push/pull 保证二者一致；检测本地↔暂存区即可代表本地↔云端 |
| 技能时间 | `.source.json` updatedAt ‖ SKILL.md mtime | 复用 conflict.ts 现成算法，行为一致 |
| MCP 判定 | server 配置 deep-equal；时间取双方 mcp.json mtime | 无 per-server 时间戳的现实约束（用户已确认） |
| 一致项分类 | local_newer / cloud_newer / same_content / local_only / cloud_only | same（内容相同）不报；「仅一侧存在」单独分组提示 |
| 对照实现 | 两端内容读取后逐行比对，相同行淡化、差异行高亮 | 零依赖，满足「对照查看」诉求 |
| 操作语义 | 每项操作按钮随 resolution 联动（本地新→上传、云端新→下载、仅一侧→相应方向）；批量按钮按组提供 | 「新覆盖旧」作为默认推荐而非自动执行——破坏性操作必须经用户点击 |

### 触点清单

| 文件 | 改动 |
|------|------|
| `src/main/cloud-consistency.ts`（新增） | 检测核心：技能双向扫描（复用/扩展 detectCloudConflicts 算法）+ MCP server deep-equal 比对；产出 `ConsistencyReport` |
| `src/main/skills/conflict.ts` | 抽出可复用的时间读取函数（local/cloud 两端），供一致性模块复用 |
| `src/main/index.ts` | IPC：`cloud-sync:check-consistency`、`cloud-sync:read-ends`（对照内容读取）；gitPull 脏检查接入 |
| `src/main/cloud-sync-service.ts` | `gitPull` 前执行 `git status --porcelain`，脏则返回跳过原因 |
| `src/renderer/src/lib/electron.ts` | 类型（ConsistencyItem / ConsistencyReport / CompareEnds）+ API 声明 + mock |
| `src/renderer/src/pages/Library.tsx` | 检测触发（loadData 后 / onPulled 后）；banner 挂载；云端→本地同步前的冲突检测接入（handleConfirmSync / handleSync 的 source 含 cloud 分支） |
| `src/renderer/src/components/ConsistencyBanner.tsx`（新增） | banner + 明细 + 操作按钮 |
| `src/renderer/src/components/ConsistencyCompareModal.tsx`（新增） | 左右并排对照 + 行差异高亮 |
| `src/renderer/src/hooks/useCloudUpload.ts` | MCP 上传分支接入「完整覆盖云端？」确认 |
| `src/renderer/src/locales/zh.json` / `en.json` | 一致性相关文案 |
| `src/__tests__/cloud-consistency.test.ts`（新增） | 技能双向、MCP 内容比对、仅一侧、时间判定的单测 |

### 步骤

1. main 层：conflict.ts 函数抽离 → cloud-consistency.ts 检测核心 + 单测。
2. main 层：IPC（check-consistency / read-ends）+ gitPull 脏检查。
3. renderer 层：electron.ts 类型与 API。
4. renderer 层：ConsistencyBanner + ConsistencyCompareModal + Library 接入。
5. renderer 层：下载方向冲突防护（技能复用弹窗、MCP 新弹窗）+ MCP 上传覆盖确认。
6. i18n + typecheck + test + 手动验证清单。

### 风险与回滚

- **风险 1**：一致性扫描的 IO 开销（遍历各客户端 skills 目录 + 读 mcp.json）——与 getAllInstalledSkills 同量级，进 Library 一次扫描可接受；检测异步不阻塞 UI。
- **风险 2**：deep-equal 判定对 JSON 键序敏感——统一先 `JSON.stringify` 规范化（键序由 stringify 保持对象字面量序，读出的同一文件稳定）；跨客户端写入的键序不同会产生误报 → 比对前按键名递归排序再序列化。
- **风险 3**：banner 与现有技能上传冲突弹窗（同数据源不同入口）状态不同步 → banner 操作完成后统一 `loadData()` + 重新触发检测刷新 banner。
- **风险 4**：gitPull 脏检查改变启动行为（脏时不再自动 pull）→ 仅跳过并提示，用户可通过手动「下载」恢复；同步任务面板可见原因。
- **回滚**：全部 additive（新模块/新组件/新 IPC），既有行为除 gitPull 脏检查与 MCP 上传确认弹窗外不变；逐文件 revert 即可。

### 验证

1. `npm run typecheck` 退出码 0；`npm run test` 全绿（含新增 cloud-consistency 单测）。
2. 手动（本机，云同步已配置）：
   - 本地改一个 skill 不上传 → 进「我的库」出现 banner，明细含该项与双方时间；
   - 点「对照」→ 左右并排且差异行高亮；
   - 云端较新的项点「下载」→ 本地被更新，banner 消失；
   - MCP：本地 mcp.json 改一个 server → banner 出现对应项；手动「云上传」→ 弹「完整覆盖云端？」确认；
   - 暂存区手改文件（模拟未推送）后重启 → 启动 pull 被跳过且同步任务中有原因说明。

## TODOS

- [x] conflict.ts：抽出时间读取函数供复用（readSkillUpdatedAt，行为等价重构）
- [x] cloud-consistency.ts：技能双向 + MCP 内容比对检测核心 + 单测（13 个用例全绿）
- [x] index.ts：check-consistency / read-ends IPC；gitPull 脏检查经核实**已存在**（P0-2 备份分支机制，优于计划方案），无需新增
- [x] electron.ts + preload：类型 + API + mock（ConsistencyItem / ConsistencyReport 桥接）
- [x] ConsistencyBanner / ConsistencyCompareModal 组件 + Library 接入（挂载 / onPulled / 手动刷新三处触发）
- [x] 云端→本地同步冲突防护（技能按时间弹逐项确认，MCP 按内容弹覆盖确认）
- [x] MCP 上传「完整覆盖云端？」确认（useCloudUpload，云端非空时弹窗）
- [x] i18n zh/en 文案（consistency 段 28 键 + library 段 9 键）
- [x] typecheck + test 全绿（209/209；执行中修复一处 JSX 标签不平衡与一处未用变量）
- [ ] 手动验证清单过一遍；P7 遗留求证（cloud 是否保留在技能安装目标）
- [x] 用户反馈修正①：对照窗口加大——Modal 新增 xl/full 尺寸，对照弹窗默认 1024px 宽 + 「全面显示」按钮切换近全屏（95vw、内容区更高）
- [x] 用户反馈修正②：banner 按钮改为「覆盖本地 / 覆盖云端」两枚；覆盖本地 = 所有已安装客户端全部覆盖（不再局限于已持有该条目的客户端）
- [x] 用户反馈修正③：Skill 与 MCP 分组显示（互不混排）；对照弹窗多客户端一致性说明；仅单侧存在的不再算不一致；两边都存在的恒定提供「覆盖本地 + 覆盖云端」两枚按钮
- [x] 用户反馈修正④：一致性 banner 按当前 Tab 过滤——MCP Servers tab 只显示 MCP 不一致，Skills tab 只显示 Skill 不一致；摘要行对 0 计数的类型隐藏
- [x] 用户反馈修正⑤：内容完全相同（仅时间戳差异）→ 默认视为已同步，静默不报。Skill 检测从「纯时间比对」改为「SKILL.md 内容比对 + 时间判定」；MCP 本就是内容比对
- [x] 用户反馈修正⑥：本地多客户端互检——同名 Skill / Server 在各本地客户端内容不一致 → 报 local_diverged（紫色标签，逐客户端时间明细），提供「统一同步」（最新客户端为源覆盖其余）与两个本地客户端互相对照
- [x] 用户报障修复（跨主题，属 plan-2.0 客户端口径回归）：Claude Code 未安装却显示已安装——① CLI 形态客户端（EXECUTABLE_ONLY_CLIENTS）不再用 configExists 兜底判定已安装；② 移除 codex-cli / opencode(win32) / openclaw(win32) 探测表中的裸目录项

## 执行备注（2026-09-07）

- 用户反馈修正①：原对照弹窗内容 minWidth 520 但 Modal 只有 max-w-md(448px)，内容被压缩是
  「看不清」的直接原因。Modal 增加 xl（max-w-5xl≈1024px）/full（95vw）两档，对照弹窗默认 xl、
  两栏内容区高 48vh；「全面显示」切 full + 70vh，切换条目时自动回到默认尺寸。
- 用户反馈修正②：「覆盖本地」语义 = 用云端版本覆盖**所有已安装客户端**（含未持有该条目的
  客户端，写入即补齐），不再按 item.localClients 收窄；「覆盖云端」保持本地代表 → 云端。
  i18n 键 upload/download 替换为 overwriteCloud/overwriteLocal，旧键已移除。
- 用户反馈修正③（四项）：
  1. banner 明细按类型分组（Skills 组 / MCP Servers 组，组头带数量），不再混排；
  2. 对照弹窗逐个本地客户端读取内容：全部一致时顶部注明「本地 N 个客户端内容一致（共同版本）」，
     不一致时注明显示的是哪一个客户端的版本；本地栏标题也标注所显示的客户端名；
  3. 仅单侧存在（local_only / cloud_only）从一致性报告中过滤——属正常状态而非不一致
     （主进程过滤 + 单测同步改为「静默不报」断言）；
  4. 两侧都存在的条目恒定渲染「覆盖本地 + 覆盖云端」两枚按钮（不再按新旧联动只给一枚）；
     RESOLUTION 映射收窄为三种实际发生的判定，无死代码。
- 用户反馈修正④：banner 的数据按当前 Tab 过滤（Library 传过滤后的 report：mcp tab →
  kind==='server'，skills tab → kind==='skill'）；主进程检测仍全量一次完成，仅展示分流。
  摘要行同步改为「0 计数的类型不显示」（如 MCP tab 下不再出现「0 个 Skill」）。
- 用户反馈修正⑤：检测从「时间驱动」改为「内容驱动」——Skill 先比 SKILL.md 全文（与对照查看
  同一口径），内容相同即静默（等同用户要求的「默认同步」，零人工零副作用）；内容不同才按
  updatedAt 判先后。MCP 已是内容比对，无需改。local_only / cloud_only 从类型与产出中彻底移除
  （前一轮仅入口过滤，本轮根除）。
- 用户反馈修正⑥：本地互检——每个 name 先做本地客户端内容互相比较（skill：SKILL.md；
  server：stableStringify），>=2 个不同 → local_diverged（附 localDetails 逐客户端时间），
  且不再与云端比对（本地先统一才有意义）。UI：「统一同步」按钮以 updatedAt 最新客户端为源
  覆盖其余已安装客户端；对照弹窗在该模式下左右栏是两个内容不同的本地客户端，标题为其显示名。
- 用户报障修复（Claude Code 未安装显示已安装，plan-2.0 口径回归）：
  - 根因 1（主）：getAllClients 的 isInstalled = installed || configExists——本应用或第三方脚本
    写 MCP 配置时创建的 ~/.claude.json 会让 configExists=true，从而翻转未安装为已安装。
    修复：类型表新增 EXECUTABLE_ONLY_CLIENTS（claude-code / gemini-cli / codex-cli / opencode /
    openclaw / qoder / zcode），这些纯 CLI 客户端的已安装判定只看本体探测，忽略 configExists。
    GUI/IDE 形态保留原口径（exe 安装位置变异大，configExists 是有效「在用」信号）。
  - 根因 2（类似问题普查）：appPaths 探测表中的裸目录项（目录存在即误判安装）——codex-cli
    三平台的 ~/.codex、opencode win32 的 ~/.config/opencode、openclaw win32 的 ~/.openclaw，
    全部移除；保留的文件级探测（如 ~/.codex/codex.exe、npm *.cmd）不受影响。
  - 行为影响说明：修复后若本机确实装有对应 CLI（exe/npm/where 命中）仍正常显示已安装；
    未装但配置残留的用户，设置页改为「未安装」、技能同步目标不再包含该客户端（符合预期）。
  - 防回归：client-probe.test.ts 新增 EXECUTABLE_ONLY_CLIENTS 成员断言 + 三平台裸目录
    排除断言（4 用例），217/217 全绿。

- 检测核心修正：一致项静默（continue）前必须先标记 handled，否则会被「仅本地存在」兜底循环
  误报为 local_only——单测跑出后修复，两侧（skill / server）同步处理。
- gitPull 防护与计划不同：扫描时发现 gitPull 已有 P0-2 的备份分支机制（reset --hard 前
  先 commit 到 backup-before-pull-* 分支），数据不丢且不中断同步，优于计划的「脏则跳过」，
  故不改动。
- 对照弹窗的行比对为「行号对齐」而非 LCS：插入/删除行导致后续错位高亮，恰好暴露结构性
  改动；零第三方依赖（plan 既定取舍）。
- 下载防护中 Skill 的 checkCloudConflicts 复用上传方向同一算法（时间口径一致），
  MCP 下载用 readEnds 内容比对（无可靠时间戳，按用户拍板口径）。
