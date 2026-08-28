# 计划 1.2：ModelScope 数据源修复（商店 MCP 列表为空 + Skill「全部/部分分类」为空）

> 目标：修复商店中 ModelScope 两个数据源的查询缺陷——(1) MCP server 列表查不出数据；(2) Skill 列表「全部」及部分分类查不出数据。
> 范围：`src/main/platforms/modelscope.ts`、`src/main/index.ts`（facets IPC）、`src/preload/index.ts`、渲染层 `useStoreData` / `useStoreFacets` / `useStoreSourceSelection` / `Store.tsx`。不改动其它平台适配器。
> 状态：仅规划，未执行。
> 结论性质：以下 4 个根因均已由真实网络探针 + 源码逐行走读确认，**不含推测项**。

---

## 〇、探针实测证据（2026-08-21，本地直连，无 token）

### Skill 端点 `GET /openapi/v1/skills`
| 请求 | HTTP | 条数 | total |
|---|---|---|---|
| 无 `filter.category` 键 | 200 | 20 | 77296 |
| `filter.category=`（空值） | 200 | 20 | 77296 |
| **`filter.category=all`** | 200 | **0** | **0** |
| `filter.category=developer-tools` | 200 | 20 | 26840 |
| `filter.category=skill-management` | 200 | 20 | 4081 |
| `filter.category=ai-media` | 200 | 20 | 7655 |
| `filter.category=productivity` | 200 | **0** | **0** |
| `filter.category=coding-assistant` | 200 | **0** | **0** |

真实 `category` 分布（前 3 页 × 50 聚合）：
`developer-tools`(42)、`ai-media`(40)、`other`(20)、`frontend-development`(12)、`skill-management`(11)、`code-quality-testing`(8)、`marketing-seo`(7)、`cloud-devops`(6)、`mobile-development`(2)、`ai-automation`(1)、`doc-processing`(1)

分页约束：`page_size ≤ 100`（101 → 400 `InputParameterError`）；**无 page×size 配额**（3×50=150 → 200 正常）。

### MCP 端点 `PUT /openapi/v1/mcp/servers`
| 请求 | HTTP | 条数 | total_count |
|---|---|---|---|
| `filter: {}` | 200 | 20 | 9981 |
| **`filter: {category:'all'}`** | 200 | **0** | **0** |
| `filter: {category:''}` | 200 | **0** | **0** |
| `filter: {category:'developer-tools'}` | 200 | 20 | 3378 |
| page=1 size=20（积 20） | 200 | 20 | — |
| page=5 size=20（积 100） | 200 | 20 | — |
| **page=6 size=20（积 120）** | **403** | 0 | `QuotaLimitExceed` |
| page=1 size=100（积 100） | 200 | 100 | — |
| **page=1 size=101（积 101）** | **403** | 0 | `QuotaLimitExceed` |

响应结构：`{success, request_id, data:{mcp_server_list, total_count}}`
条目字段：`id, publisher, name, chinese_name, description, tags, logo_url, view_count, locales, categories`
真实 `categories[]` 取值样本：`browser-automation`、`developer-tools`、`location-services`、`search`、`finance`、`communication`、`knowledge-and-memory`

### baseUrl 对照
`https://www.modelscope.cn`（`PLATFORM_META.modelscope.defaultBaseUrl`）与 `https://modelscope.cn` 两端点均 200 且结构一致，`redirect: manual` 下 www 直接 200 无跳转。
→ **baseUrl 不是故障原因，本计划不改动它。**

### 已排除的假设（不再作为待查项）
- `locateArray`（`shared.ts` L99-116）候选第 2 项为 `json?.data?.mcp_server_list`，对实测响应结构必然命中。**不是根因。**
- `extractPageInfo`（`shared.ts` L153）已支持 `total_count`。**无需改动。**
- `msServerSearchImpl` L236-239 的客户端二次分类过滤：实测服务端 `filter.category` 生效且返回条目 `categories` 均非空并包含该分类，过滤不会误杀。**不是根因，但属冗余代码，按 T2 删除。**

---

## 一、四个确定根因

### R1（问题 1 主因）：MCP 查询传入的 `platformType` 取自 **Skill 源**连接，导致 IPC 抛错
`useStoreData`（`src/renderer/src/hooks/useStoreData.ts` L37）：

```37:37:src/renderer/src/hooks/useStoreData.ts
        platformType: params.selectedConn?.platformType,
```

`selectedConn` 由 `useStoreSourceSelection` L103 得出，来源是 `api.apiConnections.list('skill')` —— **只含 Skill 源**。
MCP 资源类型实际选中的连接是 `mcpConnId` / `mcpSources`（L60-65 加载 `list('mcp')`），与 `selectedConn` 无关。

因此 `useMcpData` L88-90 调用：

```88:90:src/renderer/src/hooks/useMcpData.ts
            const res = await api.platforms.searchServers(
                platformType || '', debouncedSearch, page, pageSize, category || 'all', sort || 'relevance', source || 'all'
            );
```

传入的是 Skill 源的 platformType（默认内置源即 `'github'`）。主进程 `platforms:search-servers`（`src/main/index.ts` L767-770）：`platformTypeToSupported('github')` → `null` → `getAdapter` → `null` → `throw '不支持的平台直连类型：github'`。
→ react-query 进入 error 态，`platform.data` 为 null，列表恒空。**这是 MCP 列表为空的主因。**

### R2（问题 1 次因）：`msServerSearchImpl` 缺 `page_number × page_size ≤ 100` 配额预判
`modelscope.ts` L201-211 直接把 `safePage`/`pageSize` 发出。实测积 >100 → 403，`fetchJson`（`shared.ts` L68 `if (!res.ok) return null`）返回 null → L226 空页返回，无任何提示。
商店页尺寸可选 10/20/50/100：`pageSize=20` 时第 6 页即 403，`pageSize=50` 时第 3 页即 403。
（Skill 端点无此配额，仅 `page_size ≤ 100`，商店最大档正好 100 → 无需处理。）

### R3（问题 2 主因）：`category='all'` 被原样拼进 `filter.category`，导致「全部」分类 0 条
`msSearchImpl`（`modelscope.ts` L136-149）把 `category || ''` 交给 `probeEndpoints` → `fillTpl`（`shared.ts` L93）→ `filter.category=all`。
渲染层固定传 `category || 'all'`（`useSkillsData` L79），故默认「全部」即命中 `filter.category=all` → 实测 0 条。
`msServerSearchImpl` L207 已有 `category !== 'all'` 守卫，故 MCP 侧不存在此问题。

### R4（问题 2 次因）：`MS_CATEGORIES` 硬编码 18 类与真实分类不符，且 Skill / MCP 共用一套
`modelscope.ts` L29-48 的 18 类中，仅 `skill-management`、`developer-tools`、`ai-media`、`marketing-seo`、`other` 与真实值对上；
`productivity`、`coding-assistant`、`data-analysis`、`content-creation`、`education`、`finance`、`health`、`gaming`、`social`、`security`、`devops`、`automation`、`science` 共 13 项在 Skill 端点均返回 0 条；
真实存在的 `frontend-development`、`code-quality-testing`、`cloud-devops`、`mobile-development`、`ai-automation`、`doc-processing` 6 类**未出现在枚举里**，用户看不到。
同时 `getFacets`（L273）被 Skill 与 MCP 共用，而 MCP 的 `categories[]` 是另一套取值（`browser-automation`/`location-services`/`search`/`knowledge-and-memory`…），共用必然失真。

### R5（附带缺陷，一并修）
- `useStoreFacets` L61 三元两支完全相同：`resourceType === 'mcp' ? selectedConn?.platformType : selectedConn?.platformType`，MCP 分类面同样错取 Skill 源 platformType（与 R1 同源）。
- `platforms:search-servers` / `search-skills` / `facets` 在主进程按 `c.platformType === platformType` 查连接（`index.ts` L761、L771、L782），未按 `kind` 区分。ModelScope 同时存在 MCP 源与 Skill 源两条连接时会取错条目（当前二者 baseUrl 相同故未暴露）。
- `msSearchImpl` L190 返回 `pagingMode: 'client'`，但该端点是真服务端分页（有真实 `total`），标记错误。
- `MS_SORTS`（L51-55）的 `downloads`/`updated` 仅对**当前页 20 条**做排序，是「假全量排序」。ModelScope Skill 端点是否支持服务端排序参数**未验证**，本计划不猜测。

---

## 二、修复方案（每项单一确定做法，无二选一）

### T0：修正 MCP 侧 platformType 取值（R1、R5 第 1 条）
- [ ] `useStoreSourceSelection.ts`：新增导出 `selectedMcpConn: ApiConnection | null`，取 `mcpSources.find(c => c.id === mcpConnId) ?? null`；写入接口 `StoreSourceSelection` 与 return 对象。
- [ ] `useStoreData.ts`：`UseStoreDataParams` 新增 `selectedMcpConn: ApiConnection | null`；L37 改为 `platformType: params.selectedMcpConn?.platformType`。
- [ ] `useStoreFacets.ts`：`UseStoreFacetsParams` 新增 `selectedMcpConn: ApiConnection | null`；L61 改为
      `const platformType = resourceType === 'mcp' ? selectedMcpConn?.platformType : selectedConn?.platformType;`
- [ ] `Store.tsx`：`useStoreData` / `useStoreFacets` 调用处补传 `selectedMcpConn: source.selectedMcpConn`。
- [ ] `useMcpData.ts`：`platformType` 为空时不发请求 —— `enabled` 追加 `&& !!platformType`，避免再次以空串打 IPC 抛错。

### T1：MCP 加配额预判与可翻页上限（R2）
- [ ] `modelscope.ts` 顶部新增常量 `const MS_MCP_QUOTA = 100; // 实测 page_number × page_size > 100 → 403 QuotaLimitExceed`。
- [ ] `msServerSearchImpl` 在发请求前：若 `safePage * pageSize > MS_MCP_QUOTA`，直接返回
      `{items: [], pageInfo: {page: safePage, pageSize, total: null, totalPages: Math.floor(MS_MCP_QUOTA / pageSize), hasMore: false}, message: 'ModelScope MCP 接口限制：页码 × 每页条数不得超过 100，请减小每页条数或返回前面的页。'}`
      并写入 `setDiagnostics` 记录该原因（不静默空白）。
- [ ] 正常返回路径：`extractPageInfo` 之后覆写
      `totalPages = Math.min(pageInfo.totalPages ?? Infinity, Math.floor(MS_MCP_QUOTA / pageSize))`，
      `hasMore = safePage < totalPages`，避免 UI 展示 500 页却在第 6 页起全空。

### T2：删除 MCP 冗余二次过滤（已证不是根因，但属死逻辑）
- [ ] 删除 `msServerSearchImpl` L236-239 的客户端 `categories/tags` 二次过滤（服务端 `filter.category` 已生效，实测条目 `categories` 必含该分类）。

### T3：Skill 修正 `all` 语义（R3）
- [ ] `msSearchImpl` L136 之后新增归一化：`const cat = !category || category === 'all' ? '' : category;`，L148 传 `cat` 替代 `category || ''`。
      —— 空值经 `fillTpl` 产出 `filter.category=`，实测等价于不传键，返回 20 条 / total 77296。
- [ ] `msSearchImpl` L190 `pagingMode` 由 `'client'` 改为 `'server'`，并删除 `complete: false`（该端点有真实 total，属服务端分页）。

### T4：分类枚举按真实值重建，且 Skill / MCP 分离（R4）
- [ ] 用探针实测值替换 `MS_CATEGORIES`，改名 `MS_SKILL_CATEGORIES`，仅保留 11 个已验证有数据的分类：
      `developer-tools` 开发工具、`ai-media` AI 媒体、`skill-management` 技能管理、`frontend-development` 前端开发、`code-quality-testing` 代码质量与测试、`cloud-devops` 云与 DevOps、`marketing-seo` 营销/SEO、`mobile-development` 移动开发、`ai-automation` AI 自动化、`doc-processing` 文档处理、`other` 其他。
- [ ] 新增 `MS_SERVER_CATEGORIES`，取值来自 MCP 端点实测 `categories[]`：
      `developer-tools`、`search`、`browser-automation`、`location-services`、`finance`、`communication`、`knowledge-and-memory`（后续如需扩充，以 `filter.category` 实测 `total_count > 0` 为准新增，禁止凭名称推测）。
- [ ] `PlatformAdapter.getFacets` 签名改为 `getFacets?(kind?: 'skill' | 'mcp'): PlatformFacets | Promise<PlatformFacets>`（`types.ts` L233）；`registry.ts` L47 `getFacets(platform, kind?)` 透传。
- [ ] `modelscopeAdapter.getFacets(kind)`：`kind === 'mcp'` 返回 `MS_SERVER_CATEGORIES`，否则返回 `MS_SKILL_CATEGORIES`。其它适配器不实现 `kind`（默认忽略参数，行为不变）。
- [ ] IPC `platforms:facets`（`index.ts` L788）增加第 2 参 `kind`；`preload/index.ts` L423 `facets(platformType, kind?)` 同步；`useStoreFacets` 调用处传 `resourceType === 'mcp' ? 'mcp' : 'skill'`，并把 `kind` 加进 `queryKey`。
- [ ] i18n：为新增的 6 个分类 id（`frontend-development`、`code-quality-testing`、`cloud-devops`、`mobile-development`、`ai-automation`、`doc-processing`）与 MCP 侧 7 个 id 补 `platformCategory.*` 词条；缺词条时 `translateCategoryTree` 已回退 `c.name`，但仍应补齐。

### T5：主进程按 kind 精确取连接（R5 第 2 条）
- [ ] `platforms:search-servers`（L771）改为 `connectionsStore.list().find(c => c.platformType === platformType && (c.kind ?? 'mcp') === 'mcp')`。
- [ ] `platforms:search-skills`（L761）与 `platforms:facets`（按 kind 参数）同理改为匹配 `'skill'` / 对应 kind。
- [ ] 未命中时保持现有行为（`baseUrl` 为空串 → adapter 内回退 `MS_BASE`），不新增异常路径。

### T6：清理不可靠排序档（R5 第 4 条）
- [ ] 从 `MS_SORTS` 移除 `downloads` 与 `updated` 两档，仅保留 `relevance`（服务端默认序），并在常量上方注释说明：「ModelScope Skill/MCP 端点是否支持服务端排序参数未经验证，页内排序会造成『全量已排序』的错觉，故不提供」。
- [ ] 同步删除 `msSearchImpl` L177-187 的客户端排序分支（随之成为死代码）。
- [ ] 服务端排序参数的调研与接入**不属本计划范围**，如需支持另开 plan-1.3。

### T7：编译 + 回归 + 手工联调
- [ ] `npx tsc --noEmit -p tsconfig.json` 与 `-p tsconfig.main.json` 均 0 error。
- [ ] `npx vitest run` 全绿（当前基线 66/66）。
- [ ] 手工验证 4 条：
      1. 商店 → MCP → ModelScope 源 → 「全部」有数据，`total_count` 约 9981；
      2. MCP 选 `developer-tools` 有数据，选 `search` 有数据；
      3. MCP 每页 20 条时可翻至第 5 页，第 5 页之后不再提供跳页且不出现空白无提示；
      4. 商店 → Skill → ModelScope 源 → 「全部」有数据（total 约 77296），逐一点击 11 个分类均非空。

---

## 三、明确不做的事
- 不改 `PLATFORM_META.modelscope.defaultBaseUrl`（www 实测正常）。
- 不改 `locateArray` / `extractPageInfo` / `fetchJson`（三者对 ModelScope 两个端点均正确）。
- 不合并新旧双通道：旧通道 `api-connections:search-servers-paged` → `searchPlatformServersPaged` 保持原样，本计划只修 Store 实际走的新通道 `platforms:search-servers`。合并属架构调整，另开计划。
- 不做分类在线聚合：会在每次打开筛选栏时额外打 API 且分布随分页波动，改用「实测校准过的静态枚举」（T4），新增分类须先用 `filter.category` 验证 `total > 0`。
- 不动 ClawHub / SkillHub / SkillsMP / 百炼适配器。

## 四、风险
- T4 改 `getFacets` 签名会触及 `types.ts` / `registry.ts` / `index.ts` / `preload` / `useStoreFacets` 五处，为本计划改动面最大项；因新增参数可选，其它适配器与调用点保持兼容。
- T6 移除两个排序档属功能收敛，UI 排序下拉将只剩「相关度」一项，需确认 `StoreFilterBar` 在单选项时的渲染不异常。
- Skill 真实分类清单来自 3 页 × 50 条抽样，长尾分类可能未被覆盖；T4 已规定新增须先实测，避免再次出现「枚举里有、查出来 0 条」。
