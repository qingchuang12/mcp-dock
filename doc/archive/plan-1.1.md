# 商店数据源优化计划 - Plan 1.1

> 版本：v1.1（2026-08-21）
> 依据：doc 目录下各平台对接文档 + 探针 HTML 示例 + 源码对比分析
> 范围：ClawHub / SkillHub / SkillsMP 的 Skill 列表查询 + ModelScope 的 Skill 详情

---

## 问题根因分析（基于文档 vs 代码对比）

### 问题 1：ClawHub Skill 列表查询 — API 端点与格式完全错误

**文档依据**：doc/clawhub/ClawHub对接说明文档.md

| 对比项 | 文档（真实 API） | 代码（当前实现） | 影响 |
|--------|-----------------|-----------------|------|
| 域名 | `wry-manatee-359.convex.cloud` | `api.clawhub.ai` | 端点不可达 |
| 路径 | `/api/action` | `/api/query/listSkills` 等 4 个猜测端点 | 全部 404/500 |
| HTTP 方法 | **POST**（Convex RPC） | POST | 方法对但格式错 |
| 请求格式 | `{"path":"search:searchSkills","format":"convex_encoded_json","args":[{"query":...}]}` | `{"query":"","page":1,"limit":20}` | 参数格式错误，API 不识 |
| 响应结构 | `{"status":"success","value":[...]}` | 期待裸数组 | 找不到数据 |
| 分类枚举 | 14 类（integrations/automation/research 等） | 9 类（devtools/coding/data 等） | 全错 |
| 排序 | API **不支持**排序（sortBy/order 导致 500） | 代码尝试多字段排序 | 排序参数无效 |
| 分页 | API **不支持**分页，单次上限 100 | 代码传 page/limit | 分页参数无效 |
| 详情接口 | `GET /api/v1/skills/<slug>` | 未实现 | 无法查看详情 |
| 下载接口 | `GET /api/v1/download?slug=<slug>` | 未接入列表 | 安装链路断裂 |

**涉及文件**：
- [clawhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/clawhub.ts) L88-L130 — convexQuery + endpoints 列表（全错）
- [clawhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/clawhub.ts) L19-L27 — CLAWHUB_CATEGORIES（9 类，应为 14 类）
- [clawhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/clawhub.ts) L29-L33 — CLAWHUB_SORTS（API 不支持排序）
- [clawhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/clawhub.ts) L55-L72 — mapEntry（字段映射需调整）
- [clawhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/clawhub.ts) L132-L158 — 客户端过滤/排序（方向对但字段名不对）

**修复方案**：
1. 重写 convexQuery 为 Convex RPC 格式：`POST https://wry-manatee-359.convex.cloud/api/action`，body 含 `path`/`format`/`args`
2. 更新 CLAWHUB_CATEGORIES 为文档 14 类（integrations/automation/research/development/productivity/communication/creative/knowledge/agents/operations/security/finance/lifestyle/other）
3. 移除 CLAWHUB_SORTS 中无效排序（API 不支持），仅保留客户端排序（按 score/downloads）
4. 更新 mapEntry 映射：`id` → `slug`，`name` → `displayName`，`description` → `native.skill.summary`，`category` → `native.skill.categories[0]`
5. 添加详情查询 `GET /api/v1/skills/<slug>` 与下载直链 `GET /api/v1/download?slug=<slug>`
6. 分类过滤改为客户端按 `native.skill.categories` 数组包含判断

---

### 问题 2：SkillHub Skill 列表查询 — 分类枚举完全错误

**文档依据**：doc/skillhub/skillhub对接说明文档.md

| 对比项 | 文档（真实 API） | 代码（当前实现） | 影响 |
|--------|-----------------|-----------------|------|
| 分类枚举 | 12 类：ai-agent / business-ops / content-creation / data-analysis / design-media / dev-programming / education / it-ops-security / knowledge-management / life-service / office-efficiency / professional | 12 类：development / data / search / productivity / design / cloud / writing / education / finance / health / social / other | 全错，分类过滤无效 |
| 子分类 | API 返回 `subCategories[{key,name}]`，中文名原生 | 代码硬编码子类（dev-coding/dev-review 等），与 API 无关 | 子类筛选无效 |
| 排序选项 | 5 档：score/stars/downloads/installs/updated_at | 5 档但错位：relevance/downloads/newest/updated/name，缺 installs 与 stars 两档，newest 映射 created_at 与文档 updated_at 不符 | 排序档位不全且字段错位 |
| 分类参数 | `category` 服务端真过滤 | 模板 `{category}` 正确但值不对 | 参数正确但枚举值错 |

**涉及文件**：
- [skillhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillhub.ts) L38-L131 — SKILLHUB_CATEGORIES（12 类全错 + 子类全错）
- [skillhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillhub.ts) L133-L139 — SKILLHUB_SORTS（5 项错位，缺 installs 与 stars 档）
- [skillhub.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillhub.ts) L23-L30 — SORT_MAP（缺 installs 映射；newest→created_at 需校准为 updated_at）

**修复方案**：
1. 重写 SKILLHUB_CATEGORIES 为文档 12 类（ai-agent/business-ops/content-creation/data-analysis/design-media/dev-programming/education/it-ops-security/knowledge-management/life-service/office-efficiency/professional）
2. 移除硬编码子类，改用 API 返回的 `subCategories` 字段（或文档中的子类枚举）
3. SKILLHUB_SORTS 按文档 5 档对齐（score/stars/downloads/installs/updated_at），增加 `installs` 与 `stars` 档位，删除文档不存在的 `name` 档
4. SORT_MAP 增加 `installs: 'installs'` 映射；校准 `newest` → `updated_at`（当前映射 `created_at` 与文档不符）

---

### 问题 3：SkillsMP Skill 列表查询 — 分类枚举与端点模板错误

**文档依据**：doc/skillsmp/skillsmp对接说明文档.md

| 对比项 | 文档（真实 API） | 代码（当前实现） | 影响 |
|--------|-----------------|-----------------|------|
| 分类枚举 | 62 个叶子分类（debugging/frontend/backend 等） | 22 个随意分类（development/code-generation 等） | 全错，分类过滤无效 |
| 端点模板 | 仅 `/api/v1/skills/search` 有效 | 3 个模板（后 2 个无效） | 多余探测浪费时间 |
| `q` 参数 | **必填**，空串 → 400 MISSING_QUERY | probeEndpoints 可能传空 q | 空搜索导致 400 |
| `limit` 上限 | **50**（非 100） | 直接透传 pageSize | 可能超限 |
| 分页信息 | `data.pagination`（含 totalIsExact/isCapped） | extractPageInfo 可解析但字段映射需确认 | 可能取错 total |
| 排序 | `sortBy=stars/recent` | 仅映射 stars/updated→recent | recent 映射正确 |
| 组级分类 | 组级 slug（如 data-ai）恒返回 0 | 分类列表中包含组级（如 development） | 组级分类无效 |

**涉及文件**：
- [skillsmp.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillsmp.ts) L22-L28 — SEARCH_TPLS（后 2 个模板无效）
- [skillsmp.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillsmp.ts) L31-L53 — SKILLSMP_CATEGORIES（22 类，应为 62 叶子类）
- [skillsmp.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillsmp.ts) L55-L59 — SKILLSMP_SORTS（缺少 name 排序）
- [skillsmp.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillsmp.ts) L107-L110 — sortBy 映射（仅映射 stars 和 updated）
- [skillsmp.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/skillsmp.ts) L62-L85 — RawSkillsmp 接口 + mapEntry（字段映射需验证）

**修复方案**：
1. 精简 SEARCH_TPLS 为仅 `/api/v1/skills/search?q={q}&page={page}&limit={size}&sortBy={sort}&category={category}`
2. 重写 SKILLSMP_CATEGORIES 为文档 62 个叶子分类（按 13 组归类）
3. q 为空时传递默认搜索词（如 `a`），避免 400 错误
4. limit 钳制到 50（API 上限）
5. 分类过滤只传叶子 slug，移除组级分类
6. 更新 RawSkillsmp 接口映射，匹配 API 返回字段（id/name/author/description/stars/skillUrl/githubUrl/updatedAt/contentLanguage）

---

### 问题 4：ModelScope Skill 详情 — 详情接口未接入

**文档依据**：doc/modelscope/对接说明文档.md 第一篇·第六节

| 对比项 | 文档（真实 API） | 代码（当前实现） | 影响 |
|--------|-----------------|-----------------|------|
| 详情端点 | `GET /api/v1/skills/<id>` | 未调用（走 README 探测） | 无法获取详情 |
| 详情字段 | `display_name/description/downloads/source_url` 等 | 未映射 | 描述/下载量等为空 |
| source_url | 多数为空，需兜底 | 未处理 | 安装链路断裂 |
| 安装通道 | source_url → GitHub raw SKILL.md | 仅 README 探测 | 安装失败 |

**涉及文件**：
- [modelscope.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/modelscope.ts) L293-L332 — fetchServerDetail（未调用 skill 详情 API）
- [modelscope.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/modelscope.ts) L76-L99 — mapSkill（字段映射正确但缺少详情补充）

**修复方案**：
1. 新增 `fetchSkillDetail` 方法，调用 `GET https://www.modelscope.cn/api/v1/skills/<id>`
2. 从详情响应中提取 `source_url`/`display_name`/`description`/`downloads` 等字段
3. source_url 为空时，使用 description 兜底
4. source_url 非空时，解析 GitHub raw SKILL.md 完成安装

> **更新（2026-08-21）**：列表搜索端已修复 — `search` 替代 `name`，`filter.category` 已接入服务端分类过滤。详情接口（`/api/v1/skills/<id>`）仍待接入。

---

### 问题 5：数据源分配与排序功能随接口能力变化

**根因分析**：各数据源的 API 能力差异大，当前代码未完全对齐：

| 平台 | 服务端分类 | 服务端排序 | 服务端分页 | 搜索 | 详情接口 |
|------|:---:|:---:|:---:|:---:|:---:|
| ClawHub | ❌（客户端做） | ❌（客户端做） | ❌（单次 100） | ✅ query | ✅ |
| SkillHub | ✅ category | ✅ 5 档 | ✅ 真分页 | ✅ keyword | ❌（无独立详情） |
| SkillsMP | ✅ category（叶子） | ✅ stars/recent | ✅ 窗口 1000 | ✅ q 必填 | ❌（skillUrl 外链） |
| ModelScope | ✅ filter.category | ❌（客户端做） | ✅ 配额 2400 | ✅ search | ✅ |

**需要统一的能力分配策略**：
- 服务端支持分类过滤 → 优先走服务端（减少数据传输）
- 服务端不支持 → 客户端本地过滤（需拉取全量数据）
- 服务端支持排序 → 优先走服务端
- 服务端不支持 → 客户端本地排序

---

## 修复优先级

| 优先级 | 问题 | 影响范围 | 用户感知 |
|:---:|------|------|------|
| P0 | ClawHub API 端点格式错误 | 整个 ClawHub 列表不可用 | 切换 ClawHub 源后无数据显示 |
| P0 | SkillsMP q 必填导致空搜索 400 | SkillsMP 列表不可用 | 切换 SkillsMP 源后报错 |
| P1 | SkillHub 分类枚举全错 | 分类筛选无效 | 选分类后数据不变 |
| P1 | SkillsMP 分类枚举全错 | 分类筛选无效 | 选分类后数据不变 |
| P1 | ModelScope 详情接口未接入 | 详情页描述为空 | 点击 skill 卡片无详情 |
| P2 | ClawHub 分类枚举错误 | 分类筛选无效 | 选分类后数据不对 |
| P2 | SkillHub 缺少 installs 排序 | 排序选项不完整 | 无法按安装量排序 |
| P2 | SkillsMP 多余端点模板 | 探测耗时增加 | 首次加载稍慢 |

---

## 补充核查（2026-08-21 复核：文档 vs 代码逐条比对后的遗漏补全）

> 下列条目为计划初版未覆盖、但按文档实测结论**上线版本必须处理**的缺口。已并入对应问题章节的修复项。

### 补充 B1（问题1 ClawHub）：请求头 + query 必填 + categorySlug 省略陷阱（P0）

对照 `ClawHub对接说明文档.md` §〇、§二、§六，初版方案漏了三个会直接导致"静默空结果"的硬约束：

1. **必需请求头**：Convex RPC 需带 `Convex-Client: npm-1.43.0`、`Origin: https://clawhub.ai`、`Referer: https://clawhub.ai/`，否则可能被拒/CORS 失败。当前 `convexQuery` 头缺失，需补齐。
2. **`query` 永远非空**：空串/缺失 → 静默返回空数组（不报错）。修复时分类浏览也必须传非空 query（如默认 `a`），不能依赖空串。
3. **`categorySlug` 全分类 = 省略字段**：传 `""` 会恒返回 0 条（陷阱）。客户端选型"全部"时必须**不传该键**，有分类才传 slug。
4. **args 只放四件套** `query/categorySlug/limit/highlightedOnly`，任何多余字段（page/sortBy/order）→ 500。

**涉及文件**：`clawhub.ts` L90-L113（`convexQuery` 头与 body 构造）、L127-L141（endpoints 替换为单一真实 RPC URL）。

### 补充 B2（问题1 ClawHub）：mapEntry 需补 `score` 字段（P2）

文档§三 `score` 是综合评分字段，客户端排序"按 score"需先映射。当前 `RawClawhub` 无 `score`，`mapEntry` 的 `extra` 也未带 `score`，排序分支只处理了 downloads/updated，缺 score 分支。修复时：
- `RawClawhub` 增加 `score?: number`。
- `mapEntry` 将 `raw.score` 存入 `extra.score`，并在 `sort==='relevance'`（默认）时按 score 降序（服务端顺序即 score，可不排；但显式按 score 更稳）。

### 补充 B3（问题2 SkillHub）：子类（subCategories）走 API 返回 + mapEntry 映射（P1）

文档§三每条含 `subCategories: [{key, name}]`（中文名原生），§五给出 12 类 × 子类枚举。当前 `SKILLHUB_CATEGORIES` 子类是**硬编码虚构 id**（dev-coding/dev-review 等，文档不存在），且 `mapEntry` 未取 `subCategories`。修复：
1. 保留 12 类 `id` 为文档 slug（ai-agent/business-ops/...），子类改从 API 返回提取（或按文档枚举预置 `children`）。
2. `mapEntry` 增加 `subCategories` 映射（取 key 数组），供详情/筛选使用。
3. 子类筛选为客户端行为（API 无子类过滤参数），保持 `supportsSubcategories: true`。

### 补充 B4（问题3 SkillsMP）：结果不含分类字段 + 默认词校验（P1）

对照 `skillsmp对接说明文档.md` §三、§〇：

1. **单条结果无分类字段**：文档明确"分类只作搜索范围过滤，不进结果"。当前 `RawSkillsmp` 的 `category` 字段与 `mapEntry` 的 `category: raw.category` 取不到值——应改为**用请求时的 category 回填**（或置空由客户端补充），避免展示错乱。
2. **`q` 默认词不能是 `*` 或纯符号**：`*`→400 INVALID_QUERY，需保证默认兜底词含字母/数字（如 `a`），并拦截纯符号。
3. **组级 slug 必须排除**：分类枚举只收 62 个叶子 slug（文档表格 #14–#75），组级 #1–#13（blockchain/business/...）实测恒 0，枚举里必须剔除。
4. **total 不可信 + 窗口封顶 1000**：前端计数/分页展示应标注"约数"，遇 `isCapped` 提示窗口封顶。

**涉及文件**：`skillsmp.ts` L22-L47（类别枚举剔除组级）、L58-L92（RawSkillsmp/mapEntry 分类处理）、L105（默认 q 兜底）。

### 补充 B5（问题4 ModelScope）：详情不回传 SKILL.md，安装走 source_url（P1）

对照 `对接说明文档.md` 第一篇 §〇.3：
- 详情接口 `GET /api/v1/skills/<id>`（注意 `/api/v1/` 非 `/openapi/v1/`；`/openapi/v1/skill/<id>` 单数实测 404）。
- 详情**不直接回传 SKILL.md 文本或 zip 直链**；安装的 SKILL.md 来自 `source_url` → GitHub raw。
- `source_url` 多数为空 → 需兜底（如用 `id` 拼 GitHub 搜索或 description 占位）。

**涉及文件**：`modelscope.ts` L293-L332（`fetchServerDetail` 是 MCP 详情，Skill 详情需新增独立方法 `fetchSkillDetail`，路径区分 `/api/v1/skills/<id>`）。

### 补充 B6（问题5 能力分配）：ClawHub 不走 probeEndpoints + pagingMode 语义校正（P2）

- ClawHub 是 Convex RPC（`POST /api/action`），不应走 `probeEndpoints`（GET 探测），应独立 `convexQuery` 实现（初版 T1 已隐含，但需在能力表里标"不走 probe"）。
- SkillsMP/ClawHub 当前 `pagingMode: 'client'` 语义不准：ClawHub 实际是"单页上限 100、无分页"；SkillsMP 是"窗口 1000、分页为窗口内翻页"。建议：
  - ClawHub：`pagingMode: 'client'`，`pageInfo.total = null`（无 total），`hasMore=false`（无法翻页）。
  - SkillsMP：`pagingMode: 'server'` 但 `serverTotal` 标"约数"，`isCapped` 时提示。
- 统一策略新增一条：**"无 total / total 不可信的平台，前端分页器禁用跳页/总页数展示，仅保留上/下一页"**。

### 补充 B7（本轮复核修正：初版 T1/T2 的端点 URL 写错，必须按文档实测修正）（P0）

逐条比对文档后发现初版 TODOS 里两处 URL 已修正为正确值，执行时以此为准：

1. **ClawHub 不是 `https://clawhub.ai/api/action/skills/listSkills`**。
   正确：`POST https://wry-manatee-359.convex.cloud/api/action`（Convex 标准域名），**RPC 方法名写在 body 的 `path` 字段，实测仅 `search:searchSkills` 可用（其余猜测路径一律 500）**，不是 URL 路径段。详见 `ClawHub对接说明文档.md` §〇/§二。
2. **SkillsMP 不是 `https://skillsmp.ai/api/v1/skills`**。
   正确：`GET https://skillsmp.com/api/v1/skills/search`（域名 `skillsmp.com`、路径 `/api/v1/skills/search`）。详见 `skillsmp对接说明文档.md` §〇/§一。
3. **SkillHub** 域名为 `https://api.skillhub.cn/api/skills`（初版 T3 未写错，保持）。
4. **ModelScope** Skill 列表为 `https://modelscope.cn/openapi/v1/skills`（列表走 `/openapi/v1/`，T0 已修）；Skill 详情为 `https://modelscope.cn/api/v1/skills/<id>`（详情走 `/api/v1/`，B5 已列）。**两处前缀不同，勿混**。

> ⚠ 这四处基址是 4 个平台对接的"锚点"，执行 T1–T4 时必须严格对照上述文档域名，不要凭记忆拼 URL。

### 补充 B8（范围说明：bailian 不在本轮范围，明确排除）（P0）

`doc/bailian/bailian对接说明文档.md` + `src/main/platforms/bailian.ts` + `src/main/platforms/bailian/data/bailian-index.json` 已存在且**与文档一致**（离线索引优先、8 分类 slug 正确、9 source、调用/用户/名称三档排序正确）。本次 `git status` 改动文件**不含 bailian 相关文件**，故：
- **bailian 不纳入本轮 T1–T6 范围**，不在本次修复清单内。
- 执行者切勿把 T3（SkillHub）的"子类/分类"改动误套到 bailian（两者结构不同：bailian 是 MCP Server 列表、8 分类；SkillHub 是 Skill 列表、12 类+子类）。

### 补充 B9（排序字段名复核：避免 T2/T3 排序列错）（P1）

- **SkillHub** 排序参数 `sortBy` 支持 `score`/`downloads`/`installs`/`updated`（文档 §三单条含 `score/downloads/stars/installs`）；初版 T3 加 `installs` 排序正确。注意排序映射（`SORT_MAP`）的 `field` 必须与服务端字段名一致（`installs` 不是 `stars`）。
- **SkillsMP** 排序参数 `sortBy` 实测为 `stars`/`recent`（文档 §三示例），**没有 `installs`**；初版 T2 仅传 `stars` 正确，不要画蛇添足加 `installs`。
- **ClawHub** 服务端按 `score` 排序（B2 已列），无独立 `sortBy` 参数（Convex args 无 sort 字段），纯客户端按 `extra.score` 排。

### 补充 B10（端到端验证 + 空参处理复核）（P1）

1. **SkillsMP 空 sort 省略参数**：`sortBy` 为空时模板应**省略该字段**（实测空值可能触发非法值回退），与 B4 的 q 兜底一起在 `fillTpl` 统一处理（并入 T2）。
2. **ClawHub 详情/下载端到端验证项**：fix 后必须实测 `GET /api/v1/skills/<slug>` 与 `GET /api/v1/download?slug=<slug>` 的返回结构与安装链路（问题 1 表第 6、7 行的"接入"不能只写代码，要有验证记录）。
3. **ModelScope 参数与分页复核**：`MS_SKILL_TPLS` 加 `filter.category` 后，`page_number`/`page_size` 参数名与响应 `data.pagination` 的字段映射需对照文档复核（`extractPageInfo` 已支持 `data.pagination`）。

---

## TODOS

- [x] **T0**：修复 ModelScope Skill 列表搜索端点，服务端分类过滤（合并 B7 锚点修正）
  - `MS_SKILL_TPLS`（L23-L25）模板直接带 `filter.category={category}`（当前缺该参数，靠 msSearchImpl 二次请求补过滤）→ 去掉二次请求，一次到位
  - 端点基址 `/openapi/v1/skills`（列表非 `/api/v1/`，后者仅用于详情）

- [x] **T1**：修复问题 1（ClawHub API 端点格式）— 合并 B1+B2+B7
  - 重写 `convexQuery` 为 Convex RPC，补齐必需请求头（Convex-Client / Origin / Referer）
  - 替换 4 个猜测 endpoints（L127-L132）为单一真实 RPC URL：base=`https://wry-manatee-359.convex.cloud/api/action`（Convex 标准路径），**RPC 方法名写在 body 的 `path` 字段，仅 `search:searchSkills` 可用**，不是 URL 路径段
  - `query` 永远非空（分类浏览传默认 `a`），全分类时**省略** `categorySlug` 字段（传空串=0 条）
  - args 仅放四件套 `query/categorySlug/limit/highlightedOnly`，剔除多余字段
  - `mapEntry` 补 `score` 字段映射（raw.score → extra.score），relevance 排序按 score 降序
  - `getFacets`（L255-L279）现会优先聚合离线索引 tags 作为分类（9 类兜底失效），需改为以 14 类 CLAWHUB_CATEGORIES 为准，离线 tags 仅作补充/合并，避免分类过滤与列表结果不一致

- [x] **T2**：修复问题 3（SkillsMP q 必填 + 端点精简）— 合并 B4
  - 空 q 传默认词（含字母数字，非 `*`/纯符号，避免 400 INVALID_QUERY），兜底统一落在 `probeEndpoints`/`fillTpl`（shared.ts）
  - 精简端点模板为 `https://skillsmp.com/api/v1/skills/search?q={q}&page={page}&limit={limit}&category={category}`（域名 `skillsmp.com`，路径 `/api/v1/skills/search`，非 `skillsmp.ai`）
  - **limit 钳制在 `probeEndpoints`/`fillTpl` 处 `Math.min(pageSize, 50)`**（API 上限 50，当前透传 pageSize 会超限）
  - 空 sort 时**省略 `sortBy` 参数**，避免非法值回退
  - 更新 62 叶子分类枚举（剔除组级 #1–#13 slug，仅收 #14–#75）
  - 修正 `mapEntry`：单条结果无分类字段，改用请求时 category 回填；total 不可信时标"约数"、isCapped 提示窗口封顶

- [x] **T3**：修复问题 2（SkillHub 分类枚举 + 排序档位）— 合并 B3+B9
  - 重写 12 类（id 用文档 slug：ai-agent/business-ops/...）
  - 子类从 API 返回 `subCategories[{key,name}]` 提取（剔除硬编码虚构 id），`mapEntry` 映射 subCategories
  - 排序补齐：`SKILLHUB_SORTS` 按文档 5 档对齐（score/stars/downloads/installs/updated_at），增补 `installs` 与 `stars` 档、删除 `name` 档；`SORT_MAP` 补 `installs: 'installs'`、校准 `newest → updated_at`（现映射 created_at 与文档不符）；子类筛选保持客户端行为

- [x] **T4**：修复问题 4（ModelScope 详情接口）— 合并 B5，补调用链
  - 新增 `fetchSkillDetail` 方法，路径 `GET /api/v1/skills/<id>`（非 `/openapi/v1/`）
  - 安装 SKILL.md 走 `source_url` → GitHub raw，`source_url` 为空时兜底
  - **调用链**：现有 `platforms:server-detail` IPC 只调 `adapter.fetchServerDetail`（MCP 详情）；skill 详情渲染层实际走 `skills:get-remote-detail`（GitHub 解析通道）。`fetchSkillDetail` 需明确：返回值结构（对齐 `PlatformSkillDetail`）、复用 `skills:get-remote-detail` 通道或新增 IPC handler + 渲染层 SkillDetail.tsx 消费点，二选一并写明

- [x] **T5**：修复问题 5（数据源能力分配策略）— 合并 B6，补渲染层落点
  - ClawHub 不走 `probeEndpoints`（Convex RPC 独立实现），标"不走 probe"
  - pagingMode 语义校正：ClawHub 单页上限100无分页（total=null/hasMore=false）；SkillsMP 窗口1000（serverTotal 标约数）
  - 统一策略新增：total 不可信平台前端分页器禁用跳页/总页数，仅保留上/下一页
  - **渲染层落点**：`src/renderer/src/hooks/useSkillsData.ts` / `useMcpData.ts` 的 `total = pageInfo.total ?? serverTotal ?? items.length` 处，total=null 时 `hasMore=false` 并透出"约数"标记；`Store.tsx` + `Pagination` 组件按标记禁用跳页/总页数展示；`useStore.ts` 的 pagingMode 硬编码 'server' 分支需按平台修正
  - 统一各平台服务端/客户端过滤排序策略

- [x] **T6**：全量编译验证 + 回归测试（tsc --noEmit + vitest）
