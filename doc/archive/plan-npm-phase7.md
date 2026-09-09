# plan-1.1 · npm 数据源弱分类（keywords + 命名空间）

> 版本：1.1（2026-09-09 追加：双语分类 / 分类召回修复 / 排序生效 / Official 源核查） · 1.0（2026-09-09） · 前任：[plan-npm-phase3-6.md](plan-npm-phase3-6.md)（可信层 / 预缓存 / 许可聚合）

## 背景与目标

npm 没有原生类目体系，Phase 1–6 落地后 npm 源在 UI 上只有一个扁平的「MCP」分类，无法按用途筛选。
用户要求：**用开发者在 package.json 里定义的 keywords 与组织命名空间做弱分类（轻量、动态）**——
后端拿到 npm 搜索大列表后，在内存中遍历每个包的 `keywords` 数组归类，前端按「数据库 / 网络搜索 / …」标签页展示。

目标：npm 搜索结果按 5 个用途分类（开发工具 / 数据库 / 生产力与搜索 / 本地系统 / 办公与协同）归类，且可按分类筛选。

## 范围与边界

**做**

1. `src/main/platforms/npm.ts`：内置 `NPM_CATEGORY_RULES` 关键词映射表 + 导出 `classifyNpmPackage()`（keywords + 包名/命名空间词元）。
2. `mapListItem` 输出真实 `categories` / `categoryNames`，替换硬编码 `['mcp']`。
3. `searchServers` 支持 `params.category` 过滤；支持 `sort === 'downloads'`。
4. `fetchServerDetail`：未命中官方 Registry 时用最新版本的 keywords 分类（Registry 结果优先）。
5. `getFacets` 返回 6 个**扁平**分类（5 个用途类 + 兜底 `mcp`）。
6. i18n（zh/en）：`platformCategory` + `mcpCategory` 新增键。
7. 单测覆盖分类规则、排序、分类筛选。

**不做**（理由）

- **不做服务端分类过滤**——npm 无此能力。实测：`keywords:mcp filesystem` 与 `keywords:mcp` 的 total 同为 71219（自由文本被忽略），`(filesystem OR terminal)` 同为 71219（OR 不支持），只有 `keywords:<term>` 生效且多个之间是 AND（`keywords:mcp keywords:filesystem` → 154），对多关键词分类而言过严，故只能内存分类 + 内存过滤。
- **不把 `description` 喂给分类器**——噪声过大，会把提到 database 的无关包误分。
- **不修改 `platformCategory.search`**——该键被 `modelscope.ts:101`、`skillhub.ts:54` 共用；npm 侧改用独立 id `web-search` 规避。
- 不引入 `children` 层级——`StoreToolbar.tsx:159-173` 只渲染顶层节点。

## 实现思路

- **触点**：`npm.ts`（分类引擎 / `mapListItem` / `searchServers` / `fetchServerDetail` / `getFacets`）、`locales/{zh,en}.json`、`src/__tests__/npm-adapter.test.ts`。
- **分类**：`tokenize` 按 `/[^a-z0-9]+/` 切词，把 `keywords` 与包名词元并入同一集合再匹配。包名天然覆盖命名空间场景（`@modelcontextprotocol/server-filesystem` → `system`，`mcp-server-slack` → `office`）。`mcp` 不作为判别词（几乎人人都有，无区分度），仅作兜底。
- **筛选**：有分类时一次性取 100 条候选池（`CATEGORY_POOL_SIZE`）→ 分类 → 过滤 → 本地切片分页；**total/totalPages 置 null**（与 `failedPageInfo` 同一「未知总量」约定），不拿候选池命中数冒充全库计数。
- **排序**：npm 搜索无服务端 sort，`sort === 'downloads'` 时对已抓取候选集按 `downloads.monthly` 本地重排。
- **取舍**：弱分类本质是启发式，允许一个包命中多个分类（提高筛选召回），顺序由规则表决定。
- **风险回滚**：改动集中在 `npm.ts` 单文件 + 两份 i18n，可整体 revert；`getFacets` 若返回空数组即退化为「无分类筛选」，不影响列表本身。

## TODOS

- [x] 实测 npm 搜索接口是否返回 `keywords`，以及查询语法（自由文本 / OR / 多 `keywords:`）
- [x] 分类引擎 `NPM_CATEGORY_RULES` + `classifyNpmPackage` + `NPM_CATEGORY_LABELS`
- [x] `mapListItem` / `fetchServerDetail` / `getFacets` 接线
- [x] `searchServers` 分类过滤 + `downloads` 排序
- [x] i18n zh/en 新增键（含规避 `search` 跨源冲突）
- [x] 单测 + `pnpm typecheck` / `pnpm test` 全绿
- [x] QA 独立复查，修复 4 个 Major 缺陷（跨源污染 / 召回不可达 / 排序失效 / 总数误导）
- [x] 清理仓库根目录 3 个 0 字节临时探针文件

## 跨版本遗留

- 来自本次：ModelScope / SkillHub 分类 id 为 `search` 的卡片在 `ServerCard.tsx:89` 仍只查 `mcpCategory`，会回落到原始 slug（删除 `mcpCategory.search` 后恢复为改动前行为）。已在总览中列为待确认项。

---

## v1.1 追加（2026-09-09）：用户反馈四问

**问题与结论**

| # | 用户反馈 | 结论 / 处理 |
|---|---|---|
| 1 | 分类要同时支持中英文（如「搜索」↔ search） | 已实现：`tokenize` 改为 CJK 感知（`/[^a-z0-9\u4e00-\u9fff]+/`，修复中文字符被丢弃的隐藏缺陷）；5 类各补中文判别词；中文走**原始串子串匹配**（中文无分词边界，`搜索引擎` 是单 token 永不等于 `搜索`），英文保持词元相等；中文判别词只参与分类判定，绝不进 npm 查询（实测 `keywords:搜索` total=1、AND 组合=0，无召回价值） |
| 2 | 分类后数量变得很少 | 根因：旧实现带分类时只抓 1 次 × 100 条候选池再内存过滤。已改为**按分类英文判别词并行扇出**（`keywords:mcp keywords:<kw>` × ≤12 路、各 100 条）→ 按包名去重 → score 确定性排序 → 分类过滤 → 本地分页。召回来自服务端按词过滤，分类页能填满；各词命中数重叠，`total` 仍为 null（诚实未知） |
| 3 | npm 排序是否有效，无效则移除 | 「下载最多」原实现只排当前页 20 条，实际无效。未移除而是**改为生效**：`usePool = hasCategory \|\| sort==='downloads'` 统一走相关度 top-100 候选池本地重排，诚实范围标注在代码注释（非全库重排） |
| 4 | Official Registry 源只有寥寥几个，逻辑是否有问题 | **无 App 侧 Bug**：上游 `modelcontextprotocol/servers` 的 `src/` 现在就只有 7 个维护中的参考服务器，App 全量忠实渲染（Store 走 noCache 直连、无缓存陈旧问题；限流时是明确错误态而非残缺列表；7/7 详情解析有效）。「源价值不足」属产品决策，给出 3 个增强选项待用户拍板 |

**TODOS（v1.1）**

- [x] 实测 npm 单关键词过滤召回量（database 1053 / search 1055 / github 593 …），确定扇出策略
- [x] CJK 感知 tokenize + 中文判别词 + 子串匹配（双语分类）
- [x] 分类扇出并行查询 + 去重 + score 确定性排序（召回修复）
- [x] downloads 排序接入候选池路由（排序生效）
- [x] `mcp` 兜底类退回单池（避免误报 FETCH_FAILED）
- [x] 测试更新 + 新增（280 通过，较上版 +5）
- [x] QA 独立复核：编译产物黑盒探针 25/25、live npm 探针验证中文查询无召回、modelscope 无回归
- [x] Official 源端到端核查（列表/缓存/搜索/限流/详情五条链路）

**v1.1 遗留（QA minor，不阻塞）**

- `npm.ts:431-434` 非池路径 `mapListItem` 未过滤空包名对象（防御性健壮性，真实 API 不会返回无名对象）。
- `npm.ts:561-570` 传入未知 category id 时静默返回空列表，建议后续加注释/日志。
- Official 源增强三选项待用户决策：并入 npm `@modelcontextprotocol` 官方 scope 包 / GitHub API 可选 token / 保持现状。
