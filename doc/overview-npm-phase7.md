# npm 数据源弱分类（Phase 7）交付总览

> 日期：2026-09-09 · 计划：[plan-npm-phase7.md](archive/plan-npm-phase7.md) · 前序：[overview-npm-phase3-6.md](overview-npm-phase3-6.md)

## 做了什么

给 npm 数据源加上了「弱分类」：npm 没有原生类目，改为**在内存中遍历每个包的 `keywords` 数组 + 包名/命名空间词元**来归档，让 npm 商店里的 MCP 包能按用途分类展示和筛选。

分类映射表（内置于代码，可多命中）：

| 分类 id | 展示名 | 判别关键词 |
|---|---|---|
| `devtools` | 开发工具 | devtools, github, git, gitlab, bitbucket, vscode, ide |
| `database` | 数据库 | database, db, sql, postgres, postgresql, sqlite, mysql, mongodb |
| `web-search` | 生产力与搜索 | google, brave, search, fetch, web |
| `system` | 本地系统 | system, filesystem, terminal, os, local, shell, cli, desktop |
| `office` | 办公与协同 | office, slack, linear, notion, evernote, docs, calendar |
| `mcp` | 其他 MCP | 兜底（无任何判别词命中） |

包名天然覆盖命名空间场景：`@modelcontextprotocol/server-filesystem` → 本地系统，`mcp-server-slack` → 办公与协同。`mcp` 不作为判别词（几乎每个包都有，无区分度），只作兜底。

**改动文件**

- `src/main/platforms/npm.ts` — 分类引擎 `NPM_CATEGORY_RULES` / `classifyNpmPackage` / `NPM_CATEGORY_LABELS`；`mapListItem` 输出真实分类；`searchServers` 支持 `category` 过滤与 `sort=downloads`；`fetchServerDetail` 未命中官方 Registry 时用 keywords 分类；`getFacets` 返回 6 个扁平分类。
- `src/renderer/src/locales/{zh,en}.json` — `platformCategory` + `mcpCategory` 新增键。
- `src/__tests__/npm-adapter.test.ts` — 新增分类/排序/筛选用例。
- 删除仓库根目录 3 个 0 字节临时探针文件（`tmp-probe.mjs`、`tmp-ms-probe.mjs`、`tmp-icns-check.cjs`，已确认无任何引用）。

## 关键决策

1. **必须先实测再定方案**。npm 搜索接口**确实返回** `package.keywords`（可用），但**不支持**分类过滤：自由文本被忽略（`keywords:mcp filesystem` 与 `keywords:mcp` 的 total 同为 71219），`OR` 无效（同为 71219），多个 `keywords:` 是 AND 关系（过严）。因此只能**内存分类 + 内存过滤**，这也正好就是用户描述的逻辑。
2. **分类筛选下一律取 100 条候选池**后本地过滤切片，且 `total` / `totalPages` 置 `null`（沿用 `failedPageInfo` 的「未知总量」约定），**不用候选池命中数冒充全库计数**——否则 UI 会显示「共 1 个」这种假精确值。
3. **不修改 `platformCategory.search`**。该键被 `modelscope.ts:101` 与 `skillhub.ts:54` 共用，npm 侧改用独立 id `web-search` 规避（详见下方缺陷）。
4. **不把 `description` 喂给分类器**，噪声过大。

## 验证结果

- `pnpm typecheck` → **0 错误**
- `pnpm test` → **19 个文件 / 275 通过 / 0 失败**（改动前基线 257 → +18）
- `src/__tests__/npm-adapter.test.ts` → **28 个用例**（原 10 个）
- 回归：ModelScope `platform-adapters.test.ts` 9/9、`store-search.test.ts` 41/41，均未受影响

实现后做了独立 QA 复查，发现并修复了 4 个 Major 缺陷：

| 缺陷 | 问题 | 修复 |
|---|---|---|
| 跨源污染 | 新增的 `mcpCategory.search` 会被 `ServerCard.tsx:89` 应用到**所有**平台，导致 ModelScope / SkillHub 的 `search` 分类卡片被误标为「生产力与搜索」 | 删除该键，npm 改用 `web-search`；`platformCategory.search` 保持原样 |
| 召回不可达 | 判别词 `file-system` 是死代码（`tokenize` 会按连字符切词，永远命中不到）；`devtools`/`system`/`office` 无法被自身 id 命中 | 移除死代码，每个分类补上自身 id 词元，补充若干单词元同义词；新增兜底分类「其他 MCP」使未分类包仍可被筛选 |
| 排序失效 | `getFacets` 声明了「下载最多」，但 `searchServers` 从不读取 `sort`，选了也没反应 | 按 `downloads.monthly` 对候选集本地重排（npm 无服务端 sort） |
| 总数误导 | 分类筛选下把候选池命中数当总数展示 | 改为 `total: null` |

## 已知限制

1. **弱分类是启发式，兜底占比偏高**。修复前实测 100 个真实 npm 包中 78% 落到兜底类（主因是死代码判别词与分类不可达，已修）。修复后未做同等规模复测，但 npm 关键词生态本身稀疏，兜底占比仍会不低——这是数据特性，不是缺陷。
2. **分类筛选下的分页受 100 条候选池限制**，深分页可能提前见底；总数为未知（`null`）。
3. **`downloads` 排序只在本次抓取的候选集内生效**，不是全库按下载量重排。

## 待确认的后续项

1. `ServerCard.tsx:89` 只查 `mcpCategory`、从不回退 `platformCategory`，导致分类 id 为 `search` 的 ModelScope/SkillHub 卡片显示原始 slug。这是**改动前就存在**的问题（本次已完全还原，未引入新回归），但修它会影响其他平台的展示，属于跨源范围扩张，**建议确认后再动**。
2. npm 列表卡片不显示「已验证」徽章——`mapListItem` 未设 `isVerified`，只有详情页有（Phase 3 的 Registry 命中逻辑在详情链路）。是否要给官方 `@modelcontextprotocol` scope 打标属于语义变更，需你定。
3. `doc/` 下现有 4 个 plan 文件并存（`plan.md` 是 Skill 附属文件编辑主题，另有 3 个 npm 系列），建议择机整理归档。
4. **本次及此前所有 npm 相关改动均未提交**。`git status` 中同时还有许可合规（LICENSE 等）的改动，建议按 `license` / `npm Phase1-2` / `npm Phase3-6` / `npm Phase7` 拆分为独立提交。

---

# 追加轮（同日）：用户反馈四问的处理结果

## 1. 分类中英文双语支持 ✅

- 修复隐藏缺陷：原 `tokenize` 按 `/[^a-z0-9]+/` 切词会**丢弃中文字符**（中文 keyword 什么都匹配不到）。
- 5 个分类各补充中文判别词（开发工具/开发、数据库/数据、搜索/检索、文件系统/系统/本地/终端、办公/协同/文档）。
- 中文无分词边界（`搜索引擎` 切词后是单个 token，永远不等于 `搜索`），因此**中文判别词走原始字符串子串匹配**，英文保持词元相等。
- 中文判别词只参与分类判定，**绝不进入 npm 搜索查询**——实测 `keywords:搜索` 全库仅 1 个包、AND 组合为 0，无召回价值。

## 2. 「分类后数量很少」根因与修复 ✅

根因：旧实现选分类时只抓 1 次 × 100 条候选池再内存过滤（池里命中几条就显示几条，如「办公与协同」仅 1 条）。
修复：带分类时按该分类的**英文判别词并行扇出**（`keywords:mcp keywords:<kw>`，≤12 路并行、各 100 条，实测单关键词命中量 database 1053 / search 1055 / github 593…）→ 按包名去重 → 按 score 确定性排序 → 分类过滤 → 本地分页。分类页现在能填满。各判别词命中数相互重叠，分类总数 npm 不提供，`total` 仍为 null（诚实未知，不显示假计数）。

## 3. 「下载最多」排序：无效 → 改为生效 ✅

原实现无分类时只抓当前页 20 条再排序（无意义）。未移除，改为真正生效：`usePool = hasCategory || sort==='downloads'` 统一走相关度 top-100 候选池本地重排 + 本地分页。诚实范围（已写入代码注释与下拉语义）：排序对象是相关度头部 100 条候选，非全库 71k 重排；池模式下 total 为 null。

## 4. Official Registry 源：无 Bug，7 个就是全部 ✅

上游 `modelcontextprotocol/servers` 仓库 `src/` 目录现在就只有 **7 个维护中的参考服务器**（everything / fetch / filesystem / git / memory / sequentialthinking / time），其余官方已归档。应用链路五项核查全部通过：列表无截断（registry.ts:328-343）、Store 走 noCache 直连无缓存陈旧问题（useMcpData.ts:64）、空搜索 + 全部分类渲染全部 7 条、GitHub 限流时显示明确错误态而非残缺列表、7/7 详情解析有效。
**源价值不足属产品决策**，三个增强方向待拍板：① 并入 npm 源里 `@modelcontextprotocol` 官方 scope 的包（归档 server 在 npm 仍可用）；② GitHub API 加可选 token 提升 60 次/小时限额；③ 保持现状。

## 验证结果（追加轮）

- `pnpm typecheck` 0 错误；`pnpm test` **280 通过**（较上版 +5）
- QA 独立复核：除跑测试外，另用项目自身 tsconfig 编译出 `dist/main/platforms/npm.js` 做 **25/25 黑盒探针**（mock fetch + 真实网络），并 live 验证中文查询无召回、扇出 URL 无任何 CJK 字符、`其他 MCP` 兜底路径不误报 FETCH_FAILED
- 回归：modelscope 9/9；renderer 无分类逻辑改动
- QA 无 critical/major 缺陷；2 条 minor 健壮性建议（空包名防御、未知 category id 静默空集）已记录在 plan v1.1 遗留段
