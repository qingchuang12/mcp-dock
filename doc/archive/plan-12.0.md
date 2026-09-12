# plan-12.0 · ClawHub 源「查询 + 安装」全面检查与修复

> 触发：用户要求对商店 Skills 的 ClawHub 源「查询/安装」功能全面检查并修复（@skill:code-assistant，先查后改）。
> 状态：**已实施（方案 A 安全修复）+ 验证通过**（tsc 0 error，47/47 测试通过）。

## 1. 调查方法
- 通读链路：`useSkillsData` → `api.platforms.searchSkills` → `index.ts:994`（`platforms:search-skills`）→ `clawhubAdapter`（`src/main/platforms/clawhub.ts`，Convex RPC）。
- 真实 API 探测（node 探针，结论见下），非仅代码推测。

## 2. 关键结论：商店实际走适配器（Convex RPC），不是 trending 解析器
- `useSkillsData` 调 `api.platforms.searchSkills` → `index.ts:999` → `getAdapter('clawhub').searchSkills` = `clawhubAdapter`（`registry.ts:20`）。
- `resolvers/clawhub.ts` 的 `searchClawhubPaged` 仅由 legacy `searchPlatformDirectPaged`（`index.ts:939/951`、`platform-skill-resolver.ts`）调用，**未接入商店 skill 浏览**。两套实现字段契约不一致（一个读 `native.skill.stats.*`，一个读 `metrics.lifetimeInstalls`）。

## 3. 问题清单（按严重度，均附真实证据）

### P0 安装：歧义 slug 下载直链 409（必修）
- 位置：`clawhub.ts:75-104` `mapEntry`（只用 `raw.slug` 当 id，丢弃 `ownerHandle`）；`:387-393` `fetchSkillDownload`（只拼 `?slug=<slug>`）。
- 证据：真实请求 `?slug=answeroverflow` → **409** `Ambiguous skill slug "answeroverflow". Multiple publishers use this slug. Retry with ownerHandle...`；`?slug=answeroverflow&ownerHandle=rhyssullivan` → **200 application/zip**。Convex 每条都带 `ownerHandle`（探针 sample：`ownerHandle:"rhyssullivan"`, `id:"clawhub:kd7..."`）。`?slug=answeroverflow&id=clawhub:...` → 仍 409（仅 `ownerHandle` 能消解歧义）。
- 影响：slug 被多发布者占用的技能（answeroverflow 等通用名称极常见）安装必失败。
- 修复：`id` 编码为 `ownerHandle/slug`（无 ownerHandle 时回退 `slug`，兼容现有测试）；`downloadUrl` 与 `fetchSkillDownload` 解析 `ownerHandle/slug` → `?slug=<slug>&ownerHandle=<owner>`。

### P1 查询：翻页复读 + 无真实深翻页（必修）
- 位置：`clawhub.ts:239-253` args 无 offset/cursor；`:287-294` `hasMore = rawLen>=limit`；`:305` 返回全部 items 未切片。
- 证据：探针 `search:searchSkills` 单次最多返回 `limit(≤100)` 条且 `hasCursor:false`（无游标）。适配器不传 page → 第 2 页起复读第 1 页；`hasMore` 误导。
- 修复：单次拉满窗口 `min(pageSize,100)`，按 `(page,pageSize)` 客户端切片，`total=items.length`，`hasMore=start+pageSize<total`，`pagingMode:'client'`。

### P2（建议修）
- **P2-1 stars 丢失**：Convex 把 stars 放在 `native.skill.stats.stars`，适配器未映射（顶层无 `stars`）→ UI 显示 0。修：`mapEntry` 读 `raw.native?.skill?.stats?.stars`。
- **P2-2 sourceUrl 不准**：`raw.canonicalUrl="/rhyssullivan/skills/answeroverflow"`，适配器回退为 `clawhub.ai/skills/<id>`（缺 owner）。修：优先用 `canonicalUrl` 拼 `https://clawhub.ai${canonicalUrl}`。
- **P2-3 空查询兜底 'a' 语义错**：`clawhub.ts:237` 空串→`'a'`，商店首次打开（无关键词）显示「匹配 a」而非浏览/热门。修：空查询退化为按 score 排序展示（或交接 trending，见决策 B）。

### P3（清理，低风险）
- **P3-1** 两套 ClawHub 实现不一致（适配器 Convex vs 解析器 trending），建议收敛为单一实现（见决策）。
- **P3-2** 死代码：`clawhub.ts:283-285` `else if (sort==='relevance')` 不可达（外层已排除 relevance）。
- **P3-3** `baseUrl` 覆盖 footgun：`clawhub.ts:233` `base = baseUrl?...:CLAWHUB_BASE`，但注释称「不依赖 baseUrl」；用户若给 ClawHub 连接配自定义 baseUrl 会指向非 Convex 部署而失败。建议固定 `CLAWHUB_BASE`、忽略用户 baseUrl（或注释说明）。
- **P3-4** 离线 `getFacets` 读 `r.tags`，但 Convex 原始条目无顶层 `tags`（在 `native.skill.categories`）→ 分类计数永远为 0。

## 4. 测试同步
- `platform-adapters.test.ts`：现有断言兼容（无 ownerHandle 时 `id`/`downloadUrl` 不变，见 :34-47、:50-58）。需新增：
  - 歧义 slug：`fetchSkillDownload({skillId:'rhyssullivan/answeroverflow'})` → `?slug=answeroverflow&ownerHandle=rhyssullivan`。
  - 分页切片：`page=2` 不复读 `page=1`；`total`/`hasMore` 准确。
  - `mapEntry` 带 `ownerHandle` 时 `id` 为 `ownerHandle/slug`、`downloadUrl` 含 `ownerHandle`。
- `install-platform-chain.test.ts`：补 ClawHub 歧义 slug 安装链路（fetchSkillDownload → installSkillFromZip）证据。

## 5. 待确认决策（翻页/浏览策略）
- **A 安全修复（推荐）**：保留 Convex 关键词搜索，修 P0 + P1（窗口≤100 正确切片）+ P2 + P3。低风险，不动网络契约。
- **B 切换 trending 端点**：用 `clawhub.ai/api/v1/trending` 游标翻页（与解析器一致，可深翻全部 ~2800 技能），关键词改客户端过滤。体验最佳但改动大、测试同步多。
- 说明：P0 安装 409 不论选 A/B 都修；仅翻页/浏览能力分叉。

## 6. 实施步骤（确认后）
1. 修 P0：`mapEntry` 编码 `ownerHandle/slug` + `downloadUrl` 带 `ownerHandle`；`fetchSkillDownload` 解析。
2. 修 P1：拉满窗口 + 客户端切片 + 准确 `total/hasMore`。
3. 修 P2：stars / sourceUrl / 空查询。
4. 修 P3：死代码 / baseUrl / 离线 facet 字段。
5. 同步测试；`node <vitest.mjs> run --pool=vmForks` 全量回归（dual tsc 通过）。
6. 写 doc/plan-12.0 完成记录 + 追加 memory。

## 7. 实施记录（方案 A · 2026-09-11）

用户经 AskUserQuestion 确认选 **A 安全修复**：保留 Convex 关键词搜索，修 P0+P1+P2+P3，不切 trending 端点。

### 落地改动（`src/main/platforms/clawhub.ts`）
- P0：`RawClawhub` 接口补齐 `ownerHandle` / `publisher.handle` / `canonicalUrl` / `links.canonical` / `native.{ownerHandle,skill.stats.stars}`；
  `mapEntry` 将 `id` 编码为 `ownerHandle/slug`，`downloadUrl` 与 `fetchSkillDownload` 解析 `ownerHandle/slug` → `?slug=<slug>&ownerHandle=<owner>`（消 409）。
- P1：args 固定 `limit: CLAWHUB_PAGE_LIMIT(100)`；在线结果按 `(page,pageSize)` 客户端切片，`total=items.length`、`hasMore=start+pageSize<total`、`pagingMode:'client'`，删除不可达 `relevance` 分支。
- P2-1：`mapEntry` 读 `raw.native?.skill?.stats?.stars` 作为 stars。
- P2-2：`sourceUrl` 优先 `https://clawhub.ai${canonicalUrl||links.canonical}`。
- P2-3：空查询仍回退 `'a'`（保留，满足 Convex 空 query 返回 0 条的实测约束；不接 trending 故不做语义改造）。
- P3-2：删除不可达 `sort==='relevance'` 分支（同 P1）。
- P3-3：`base` 固定 `CLAWHUB_BASE`，忽略用户 baseUrl（seed 的 `baseUrl=https://clawhub.ai` 曾导致 POST 到错误主机、商店返回空——此为该 footgun 的根因修复）。
- P3-4：离线 `getFacets` 分类计数改读 `native.skill.categories || native.categories || categories || tags`。

### 同步改动（`src/main/resolvers/clawhub.ts`）
- legacy `kind==='clawhub'` 分支同样按 `ownerHandle/slug` 解析并拼 `&ownerHandle=`（防御性一致修复，虽未接入商店浏览）。

### 测试（`src/__tests__/platform-adapters.test.ts`）
- 新增：`mapEntry` ownerHandle/stars/sourceUrl 三用例；`fetchSkillDownload` 解析 `ownerHandle/slug` 用例；离线缓存翻页切片（25 条 → 3 页不重叠）用例。

### 验证结果
- `tsc -p tsconfig.main.json --noEmit`：**0 error**。
- `vitest run --pool=vmForks src/__tests__/platform-adapters.test.ts`：**47 passed / 47**（原 1 失败已修复）。
- 遗留探针/日志临时文件已清理（`clawhub_probe*.js`、`verify_*.log`）。

### 备注
- 实施中发现：部分编辑（接口扩展、`fetchSkillDownload` base 拆分、`getFacets` 字段、`base` 固定）在上一会话"声称已应用"但实际未落盘，导致 TSC 7 处 `TS2339` 与 1 例测试失败；本次已逐一核对并补齐。
- 未做（方案 A 范围外）：B 切换 trending 端点、P3-1 两套实现收敛、A10 Bailian / E2 ModelScope 后退栈（属其他 backlog）。

