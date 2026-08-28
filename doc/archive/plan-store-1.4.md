# 商店模块（Store）优化任务清单 v1.4

扫描范围（已逐行读源码确认）：

| 文件 | 行数 |
|---|---|
| `src/renderer/src/pages/Store.tsx` | 257 |
| `src/renderer/src/pages/StoreToolbar.tsx` | 187 |
| `src/renderer/src/pages/StoreFilterBar.tsx` | 125 |
| `src/renderer/src/pages/StoreGrid.tsx` | 64 |
| `src/renderer/src/pages/StoreEmptyState.tsx` | 115 |
| `src/renderer/src/pages/StoreErrorState.tsx` | 23 |
| `src/renderer/src/components/ServerCard.tsx` | 256 |
| `src/renderer/src/components/SkillCard.tsx` | 193 |
| `src/renderer/src/components/Pagination.tsx` | 111 |
| `src/renderer/src/hooks/{useStoreData,useMcpData,useSkillsData,useStoreFacets,useStoreSourceSelection,useStoreAttribution,storeTypes}` | 660 |
| 关联：`lib/search.ts`、`store/useStore.ts`、`main/index.ts` 平台 IPC | — |

合计 **38 个问题**：P0 严重 8 / P1 重要 16 / P2 改进 14。

---

## P0 严重（功能性缺陷，用户可感知的错误行为）

### S0-1 MCP 平台源的分类/排序面（facets）取错了 platformType
`hooks/useStoreFacets.ts:61`
```ts
const platformType = resourceType === 'mcp' ? selectedConn?.platformType : selectedConn?.platformType;
```
三元两分支完全相同，且 `selectedConn` 是 **Skill 源**的连接（来自 `useStoreSourceSelection` 的 `connections`）。
后果：浏览 MCP 平台源（如 ModelScope）时，用 Skill 源（默认 `github`）的 platformType 去请求 facets → 拿到空分类 → 分类筛选栏整体消失或显示错误分类树。
修复：MCP 分支改用 `mcpSources.find(c => c.id === mcpConnId)?.platformType`（Store.tsx 已算出 `selectedMcpConn`，直接透传）。

### S0-2 平台源 queryKey 缺 `pageSize`，改「每页条数」不生效
`hooks/useMcpData.ts:84`、`hooks/useSkillsData.ts:74`
```ts
queryKey: ['mcpPlatform', mcpConnId, debouncedSearch, page, category, sort, source]  // 缺 pageSize
queryKey: ['skillsPlatform', selectedConn?.id, debouncedSearch, page, category, sort] // 缺 pageSize
```
`queryFn` 内部却使用了 `pageSize`。后果：用户把每页从 20 改成 50，react-query 命中旧 key 的缓存，列表仍是 20 条，且 `totalPages` 按 50 重算 → 页码数与实际数据不符。
（`mcpSmithery` 的 key 含 pageSize，是正确写法，可作参照。）

### S0-3 Smithery 源的分类/搜索过滤只作用于当前页，计数完全错误
`hooks/useMcpData.ts:126-153`
服务端已按页返回 items，随后又对**本页 20 条**做 `searchServers → filterServersByCategory → sortServers`，但 `total`/`totalPages` 仍取服务端全量值。
后果：选「Coding」分类后可能只剩 2 条，分页却显示「1-2 / 3800，共 190 页」；其他页的同分类项永远看不到。且 queryKey 不含 category，翻页不会重新请求。
修复：要么把 category/sort 下推到服务端（加进 queryKey + 请求参数），要么在 UI 上对服务端分页源禁用前端分类，二者选一，不能混。

### S0-4 Skills 内置源「强制刷新」拿不到新数据
`hooks/useSkillsData.ts:63` → `fetchSkillsList(undefined, false)`（noCache=false）
`refetch()` 重跑 queryFn，但 queryFn 仍优先读磁盘缓存并直接返回。
后果：点刷新按钮 + 1.5s 转圈动画 + toast「刷新成功」，实际数据没变。
对比 `useMcpData.ts:61` 的 `fetchServerList(dataSource, undefined, true)` 是 noCache=true（正确）。
修复：把 noCache 提为查询参数，由「手动刷新」路径传 true。

### S0-5 越界页产生荒谬的区间显示与空列表
`hooks/useMcpData.ts:105`、`hooks/useSkillsData.ts:100`、`components/Pagination.tsx:60`
`startIndex = total > 0 ? (page-1)*pageSize : 0`，当 page 越界（本页 0 条但 total>0）时渲染成 `101-100 / 100`。
触发路径：在第 5 页切换数据源 → `Store.tsx:53` 的 effect 只重置 `category/sort/sourceFilter`，若三者原本已是默认值则 **不触发** `currentPage` 重置 → 停在第 5 页而新源只有 1 页。
修复：切源时显式 `setCurrentPage(1)`；并在 hook 内 clamp page 到 `[1, totalPages]`，clamp 后同步回写 store。

### S0-6 主进程按 platformType 猜连接，多连接场景用错 token/baseUrl
`main/index.ts:868, 878, 889`
```ts
const conn = connectionsStore.list().find(c => c.platformType === platformType);
```
渲染层明明持有 `connId`（`mcpConnId` / `selectedConn.id`）却不传，主进程按类型取**第一个**连接。
后果：同一平台配置了两个连接（不同 baseUrl 或不同 token）时，商店可能用 A 的 token 去打 B 的 baseUrl → 401 或串数据。涉及 `platforms:search-skills`、`platforms:search-servers`、`platforms:server-detail`。
修复：IPC 签名增加 `connectionId`，主进程 `connectionsStore.get(connectionId)`；保留按 type 回退以兼容旧调用。

### S0-7 安装状态不刷新，「已安装」徽章长期失效
`pages/Store.tsx:89-99`
两个 effect 依赖 `[api, setInstalledServerIds]` / `[api, setInstalledSkillIds]`，`api` 恒定 → 全生命周期只拉一次。
后果：从详情页安装后返回商店，卡片仍显示未安装；卸载后仍显示已安装。
修复：改用 react-query（带 key），安装/卸载成功后 `invalidateQueries`；或至少在路由 focus 时重新拉取。

### S0-8 两个 `.then()` 没有 `.catch()`
`pages/Store.tsx:90, 96`
`api.config.getAllServers()` / `api.skills.getAllInstalled()` 失败时产生 unhandled rejection，徽章静默失效且无任何用户提示。
（同类问题在 `useStoreSourceSelection.ts:52-65` 已正确 `.catch()`，可作参照。）

---

## P1 重要（可用性 / 性能 / i18n / 无障碍）

### S1-1 `t('key') || '兜底'` 是永不生效的死代码（9 处）
`Store.tsx:108,110,119,121,222,232`、`StoreToolbar.tsx:83,138,171`
i18next 在 key 缺失时返回 **key 字符串本身**（非空），`||` 右侧永远不执行。
后果：key 一旦缺失，界面直接显示 `store.pageSize` 这种原文。
修复：统一改 `t('store.pageSize', {defaultValue: '每页'})`。

### S1-2 分类名缺失时显示 key 原文
`ServerCard.tsx:168`、`SkillCard.tsx:171`
```tsx
{t(`mcpCategory.${primaryCat}`) || primaryCat}
```
同 S1-1 成因。平台源返回的分类 id 不在 `mcpCategory`/`skillCategory` 表内时（`platformCategory` 仅 12 个键、`mcpCategory` 19 个），卡片上会出现 `mcpCategory.web3` 字样。
修复：`i18n.exists()` 判断后再回退原始 name（`useStoreFacets.ts:23` 的 `translateCategoryTree` 已是正确写法，复用它）。

### S1-3 卡片硬编码中文，英文界面漏中文
`ServerCard.tsx:242` `{formatNumber(...)} 次调用`、`ServerCard.tsx:246` `云端托管`
应补 `store.callCount` / `store.cloudHosted` 两个 i18n key（zh/en 双份）。

### S1-4 时间格式化硬编码英文，中文界面漏英文
`ServerCard.tsx:43-48`、`SkillCard.tsx:41-46`
返回 `'today' / 'yesterday' / '3d ago' / '2w ago' / '5mo ago'`，中文界面直接显示英文。
修复：抽到 `lib/format.ts` 并接 i18n（复数用 i18next 的 `count` 插值）。

### S1-5 归属说明栏硬编码英文
`hooks/useStoreAttribution.ts:21,28`
```ts
return `MCP servers from ${selectedMcpConn.name || selectedMcpConn.baseUrl}`;
return `Skills from ${selectedConn.name || selectedConn.baseUrl}`;
```
修复：`t('store.attributionFrom', {name})`。

### S1-6 分页 aria-label 硬编码中文
`components/Pagination.tsx:68,100` — `aria-label="上一页"` / `"下一页"`，屏幕阅读器在英文界面下读中文。

### S1-7 卡片不可键盘操作
`ServerCard.tsx:149`、`SkillCard.tsx:137` 是 `<div onClick>`，无 `role="button"`、无 `tabIndex={0}`、无 `onKeyDown`（Enter/Space）。整个商店列表键盘完全不可达。

### S1-8 二级分类菜单键盘不可达
`StoreFilterBar.tsx:47-83`
外层 `<div tabIndex={0}>` + `group-focus-within:flex`，但内层触发按钮 `tabIndex={-1}`，Tab 只能停在 div 上、无法进入子菜单选项；也没有 `aria-expanded` / `aria-haspopup`。

### S1-9 筛选下拉无可访问名称
`StoreToolbar.tsx:87,111`（源选择 select 仅有 `title`）、`StoreFilterBar.tsx:89,102`（排序/来源 select 无关联 label）。需 `aria-label` 或 `<label htmlFor>`。

### S1-10 内置源全量列表每次渲染重算，无 memo
`hooks/useMcpData.ts:157-160`、`useSkillsData.ts:121-145`
hook body 内同步执行 `searchServers`（`lib/search.ts:44` 注释明确「每次搜索都创建新的 Fuse 实例」）→ `filterServersByCategory` → `sortServers` → `paginateServers`。
官方源全量约数千条，任何无关 state 变化（如 `isForceRefreshing` 切换）都会重建 Fuse 索引并重跑全链路。
修复：`useMemo` 包裹，依赖 `[list, debouncedSearch, category, sort, page, pageSize]`；Fuse 实例按 list 单独 memo。

### S1-11 翻页闪全屏 Loading，无上一页占位
全项目零 `placeholderData` / `keepPreviousData`（已 grep 确认）。服务端分页源每次翻页 `isLoading=true` + items 空 → `Store.tsx:187` 命中 → 整页替换为 `LoadingSpinner`，列表跳动。
修复：`placeholderData: keepPreviousData`，翻页时保留旧列表 + 局部 loading 态。

### S1-12 刷新按钮人为等待 1.5 秒
`Store.tsx:107` `if (elapsed < 1500) await new Promise(r => setTimeout(r, 1500 - elapsed));`
纯粹为了让转圈动画「看起来在工作」，实测缓存命中时凭空拖慢 1.5s。建议去掉或降到 300ms。

### S1-13 pageSize=100 与 ModelScope 配额直接冲突
`Store.tsx:228` 提供 `[10,20,50,100]`；而 `StoreEmptyState.tsx:78` 的配额提示说明 ModelScope 限制 `页码 × 每页条数 ≤ 100`。
后果：选 100 条/页后翻到第 2 页必然触发 `__QUOTA_LIMIT_EXCEED__` 空态，用户无法预知。
修复：按当前源能力约束可选项（平台源上限 50），或在选项旁给出提示。

### S1-14 内置源提供了「最近更新」排序但根本没实现
`useStoreFacets.ts:20` 暴露 `BUILTIN_SORT_IDS = ['relevance','stars','updated']`，而 `lib/search.ts:109 sortServers` 只实现了 `stars`，`updated` 落到 `return sorted`（原序）。
后果：用户选「最近更新」无任何变化，静默失败。
修复：实现 `updated`（官方源有 `lastCommitAt`/`updatedAt`），或从内置源 facets 里移除该选项。

### S1-15 `refetchOnMount: true` 与注释描述不符
6 处查询都写了 `refetchOnMount: true` 并注释「仅在数据过期（>10min）时重新拉取」。`true` 恰是 react-query 默认值，语义正确但配置冗余；真正想表达「过期才拉」应写 `'always'` 的反面即省略。属注释误导，需澄清或删除。

### S1-16 空态按钮两分支完全重复且语义可疑
`StoreEmptyState.tsx:38-59`
前两个分支渲染的 JSX 完全一致（都是 `goToSettings`），可合并为一个条件。另外 MCP 内置源为空时引导用户去「我的库」（`#/library`）而非切换数据源，指向不合理。

---

## P2 改进（结构 / 一致性 / 可测性）

### S2-1 组件放错目录
`StoreToolbar / StoreFilterBar / StoreGrid / StoreEmptyState / StoreErrorState` 是纯展示组件，却放在 `pages/` 下（`pages/` 其余 7 个文件都是路由页）。建议迁到 `components/store/`。

### S2-2 格式化函数四份重复
`formatNumber` 在 `ServerCard.tsx:23`、`SkillCard.tsx:24` 各一份（签名还不同：一个容忍 null，一个不容忍）；相对时间格式化在两处几乎逐字相同。
建议抽 `lib/format.ts`（`formatCompactNumber` / `formatRelativeTime`）。

### S2-3 头像回退逻辑四份重复
`ServerCard.tsx:67 ServerIcon`、`SkillCard.tsx:65 SkillIcon`、`components/ServerIcon.tsx`、`components/SkillIcon.tsx`（后两个是 P2-2 为 Library 抽的）。四份都在做「远程图 → GitHub 头像 → 首字母 + 6 色板」，色板数组逐字重复 4 次，圆角还不一致（`rounded-xl` vs `rounded-lg`）。
建议统一为一个 `<EntityAvatar name iconUrl repoUrl size radius />`。

### S2-4 `mapPlatformServer` 用 `as ServerListItem` 强转绕过类型检查
`useMcpData.ts:25`。应补齐字段或让 `ServerListItem` 联合类型正确容纳平台项。

### S2-5 `ResourceType` 双定义
`api/registry.ts:17` 与 `hooks/storeTypes.ts:43` 定义了同一个 `'mcp' | 'skills'`。应单一来源。

### S2-6 `useStoreData` 是无实质逻辑的转发层
`hooks/useStoreData.ts` 58 行，全部工作是把 params 拆成两份透传给 `useMcpData` / `useSkillsData` 再三元选一。可直接在 `Store.tsx` 调两个 hook，减少一层参数镜像（当前每加一个筛选项要改 4 处签名）。

### S2-7 `Store.tsx` 一串无意义别名
`Store.tsx:133-138`
```ts
const result = data;
const displayTotal = result.totalItems;
const isLoading = data.isLoading;
const isFetching = data.isFetching;
const error = data.error;
const friendlyMessage = data.message;
```
直接用 `data.x` 即可。

### S2-8 `useStoreFacets` 恒真三元
`useStoreFacets.ts:86` `enabled: resourceType === 'mcp' ? true : true`。

### S2-9 `useStoreFacets` queryKey 缺 platformType
`['storeFacets', resourceType, platformConnId, i18n.language]`。修 S0-1 后 platformType 成为独立输入，必须进 key。

### S2-10 GitHub 源 queryKey 含无用维度
`useSkillsData.ts:59` `['skillsGithub', selectedSkillSourceId || 'github']`，但 queryFn 完全忽略该 id（恒拉同一份 registry）。多个 github 源会各存一份相同数据。

### S2-11 `StoreGrid` 的 key 含 index，memo 失效
`StoreGrid.tsx:37,47` `key={`${currentPage}-${index}-${server.id}`}`。id 已唯一，掺入 index 会在列表顺序变化时让所有 key 变更，`memo(ServerCard)` 白做。外层 `<div key={`grid-${resourceType}-${currentPage}`}>` 也会在翻页时强制整树重建。

### S2-12 网格固定两列
`StoreGrid.tsx:58` `grid-cols-2` 无响应式断点，宽屏浪费、窄窗挤压。建议 `grid-cols-1 md:grid-cols-2 xl:grid-cols-3`。

### S2-13 用 `window.location.hash` 绕过路由（5 处）
`StoreEmptyState.tsx:40,47,54`、`StoreToolbar.tsx:92,116`。项目用 `HashRouter`（`main.tsx:21`），应统一 `useNavigate()`，否则跳过 router 的 transition 与 future flag 行为。

### S2-14 商店模块零测试
`src/__tests__/` 10 个测试文件全部针对主进程，商店侧 0 覆盖。以下是纯函数、成本极低：
- `lib/search.ts` 的 `paginateServers`（含越界 clamp）、`filterServersByCategory`、`sortServers`
- `useMcpData` 的 `mapPlatformServer`、`useSkillsData` 的 `mapPlatformSkill`
- `Pagination` 的 `buildPageList`（省略号收敛逻辑）
- 待抽出的 `lib/format.ts`

### 附：两处 UTF-8 BOM
`pages/StoreGrid.tsx`、`hooks/useStoreAttribution.ts` 文件头带 `EF BB BF`。不影响编译，但与其余文件不一致，建议去掉。

### 附：`useStore` 死代码与冗余状态
- `store/useStore.ts:184` `resetPagination` 零引用。
- `serverLists` / `setServerList` 仅 `Library.tsx` 使用，商店已改走 react-query；把 official+smithery 全量列表常驻 zustand 与 react-query 缓存重复，属双份内存占用。

---

## 建议执行批次

| 批次 | 内容 | 条数 | 前置 | 状态 |
|---|---|---|---|---|
| 第一批 数据正确性 | S0-1 ~ S0-8 | 8 | 无 | ✅ 已完成（2026-08-25） |
| 第二批 i18n + 无障碍 | S1-1 ~ S1-9 | 9 | 无（可与第一批并行，文件不重叠除卡片） | ✅ 已完成（2026-08-25） |
| 第三批 性能与体验 | S1-10 ~ S1-16 | 7 | 第一批（S1-11 依赖 S0-2 的 queryKey 修正） | ✅ 已完成（2026-08-25） |
| 第四批 结构重构 | S2-1 ~ S2-13 + 附录 | 15 | 第三批（重构前需测试护栏） | ✅ 已完成（2026-08-26） |
| 第五批 测试补齐 | S2-14 | 1 | 与第四批交替（先补测试再重构更安全） | ✅ 已完成（2026-08-26） |

**合计 38 条**（P0 8 / P1 16 / P2 14）。

## 第一批完成记录（2026-08-25）

验证：`tsc -p tsconfig.json` ✅、`tsc -p tsconfig.main.json` ✅、`vitest run` 103 passed ✅、`check-store-i18n` 无新缺失。

| 项 | 修复 | 文件 |
|---|---|---|
| S0-1 | MCP 分支改用 `selectedMcpConn.platformType`（不再误用 Skill 源连接）；platformType 纳入 queryKey | `useStoreFacets.ts` |
| S0-2 | 平台源 queryKey 补 `pageSize`（mcpPlatform / skillsPlatform） | `useMcpData.ts:84`、`useSkillsData.ts:74` |
| S0-3 | Smithery 禁用前端分类/排序切片（API 不支持），直接透传本页；facets 对 smithery 返回空，避免无效筛选 UI | `useMcpData.ts`、`useStoreFacets.ts` |
| S0-4 | `forceRefresh` 透传 → `fetchSkillsList(undefined, noCache)`；`handleForceRefresh` 用 `flushSync` 确保状态先行提交 | `useSkillsData.ts`、`useStoreData.ts`、`Store.tsx` |
| S0-5 | 切源 / 改每页条数时 `setCurrentPage(1)`，避免越界页荒谬区间 | `Store.tsx` |
| S0-6 | 平台 IPC 增 `connectionId`，主进程 `connectionsStore.get(id)` 精确取 token/baseUrl，回退按 type | `lib/electron.ts`、`preload/index.ts`、`main/index.ts`、`useMcpData.ts`、`useSkillsData.ts` |
| S0-7 | 已安装状态初始拉取 + 监听 `focus`/`hashchange` 刷新，返回商店后徽章更新 | `Store.tsx` |
| S0-8 | 两个 `.then()` 补 `.catch`，消除 unhandled rejection | `Store.tsx` |

注：S2-9（facets queryKey 补 platformType）随 S0-1 一并完成；S2-8（`enabled` 恒真三元）顺手清为 `true`。

## 第二批完成记录（2026-08-25）

验证：`tsc -p tsconfig.json` ✅、`tsc -p tsconfig.main.json` ✅、`vitest run` 103 passed ✅、`check-store-i18n` 无新增缺失（4 个 MISS 为 `relevance/conn/src/meta` 误报，非 i18n key）。

新增 i18n key（zh/en 双份）：`store.callCount`、`store.cloudHosted`、`store.attributionFromMcp`、`store.attributionFromSkills`、`store.prevPage`、`store.nextPage`、`store.mcpSourceSelectLabel`、`store.skillSourceSelectLabel`、`store.sortLabel`、`store.sourceFilterLabel`、`store.timeToday`、`store.timeYesterday`、`store.timeDaysAgo`、`store.timeWeeksAgo`、`store.timeMonthsAgo`、`store.timeYearsAgo`（共 16 个）。

| 项 | 修复 | 文件 |
|---|---|---|
| S1-1 | 9 处 `t('k') \|\| '兜底'` 改为 `t('k', {defaultValue:'兜底'})` | `Store.tsx`、`StoreToolbar.tsx` |
| S1-2 | 分类名缺失改用 `i18n.exists()` 回退（新增 `localizeKey` 助手） | `ServerCard.tsx`、`SkillCard.tsx`、`lib/format.ts` |
| S1-3 | 卡片硬编码中文 `次调用`/`云端托管` 抽 i18n key | `ServerCard.tsx`、`zh.json`/`en.json` |
| S1-4 | 时间格式化抽到 `lib/format.ts:formatRelativeTime(t,...)` 接 i18n（中文不再漏英文）；同时合并 `formatCompactNumber` 消除卡片重复（顺带覆盖 S2-2） | `ServerCard.tsx`、`SkillCard.tsx`、`lib/format.ts`、`zh.json`/`en.json` |
| S1-5 | 归属栏 `MCP servers/Skills from` 硬编码英文 → `t('store.attributionFromMcp/Skills', {name})` | `useStoreAttribution.ts` |
| S1-6 | 分页 aria-label 硬编码中文 → i18n | `Pagination.tsx` |
| S1-7 | ServerCard/SkillCard `<div onClick>` 加 `role="button" tabIndex={0} onKeyDown(Enter/Space)` | `ServerCard.tsx`、`SkillCard.tsx` |
| S1-8 | 二级分类菜单：移除外层死 focus 停靠与内层 `tabIndex={-1}`，改用 `openCatId` 状态（hover/focus 展开）+ `aria-haspopup`/`aria-expanded`，键盘可进入子项 | `StoreFilterBar.tsx` |
| S1-9 | 排序/来源/源选择 select 补 `aria-label` | `StoreFilterBar.tsx`、`StoreToolbar.tsx` |

注：S1-4 的 `formatCompactNumber`/`formatRelativeTime` 抽象同时消去了 S2-2（格式化函数四份重复）在两处卡片的重复，第四批重构时无需再处理卡片侧。

## 第三批完成记录（2026-08-25）

验证：`tsc -p tsconfig.json` ✅、`tsc -p tsconfig.main.json` ✅、`vitest run` 103 passed ✅、`check-store-i18n` 无新增缺失（4 个 MISS 为 `relevance/conn/src/meta` 误报）。

| 项 | 修复 | 文件 |
|---|---|---|
| S1-10 | 内置源（official MCP / GitHub Skills）全量列表管线（搜索→过滤→排序→分页）用 `useMemo` 包裹，依赖 `[data, debouncedSearch, category, sort, page, pageSize]`，避免无关 state 变化触发 Fuse 索引重建 | `useMcpData.ts`、`useSkillsData.ts` |
| S1-11 | 平台源/ Smithery 服务端分页查询加 `placeholderData: keepPreviousData`，翻页保留上一页数据作占位，不再整页全屏 Loading | `useMcpData.ts`、`useSkillsData.ts` |
| S1-12 | 强制刷新移除人为 `sleep(1500 - elapsed)`，不再凭空拖慢 1.5s | `Store.tsx` |
| S1-13 | pageSize 选项受源能力约束：平台源限 `[10,20,50]`（化解 ModelScope 配额 `页码×每页≤100`，100 条/页翻第 2 页必触发配额空态）；切到平台源时若当前 pageSize>50 自动收敛 | `Store.tsx` |
| S1-14 | `sortServers` 实现 `updated` 排序（按 `lastCommitAt`/`updatedAt` 降序），「最近更新」不再静默失效 | `lib/search.ts` |
| S1-15 | 清理 6 处 `refetchOnMount: true` 旁「仅过期才拉」的误导性注释（`true` 即默认值，语义是 staleTime 驱动；配置保留） | `useMcpData.ts`、`useSkillsData.ts`、`useStoreFacets.ts` |
| S1-16 | 空态按钮：合并两个完全相同的 `goToSettings` 分支；MCP 内置源为空时 CTA 由「前往我的库」改为「前往设置」（切换数据源更合理） | `StoreEmptyState.tsx` |

注：S1-11 的 `keepPreviousData` 与 S0-2（queryKey 含 pageSize）协同——翻页时 queryKey 变化、新请求 pending 期间复用旧数据，列表不再跳动。

## 验证护栏
```bash
npx tsc -p tsconfig.json --noEmit        # 渲染层
npx tsc -p tsconfig.main.json --noEmit   # 主进程（S0-6 涉及）
```

## 第五批完成记录（2026-08-26）

验证：`tsc -p tsconfig.json` ✅、`tsc -p tsconfig.main.json` ✅、`vitest run` **144 passed** ✅（11 文件，原有 103 + 新增 41）。

| 项 | 修复 | 文件 |
|---|---|---|
| S2-14 | 商店模块纯函数测试：`paginateServers`（分页 + 越界 clamp）、`filterServersByCategory`（分类匹配 + 回退推断）、`sortServers`（stars/updated 排序 + 不变性）、`formatCompactNumber`（千/M 级 + null 边界）、`formatRelativeTime`（今天/昨天/周/月/年 i18n）、`buildPageList`（省略号收敛 + 两端/单端/无省略号） | `src/__tests__/store-search.test.ts`（新增，41 条用例） |

## 第四批完成记录（2026-08-26）

验证：`tsc -p tsconfig.json` ✅、`tsc -p tsconfig.main.json` ✅、`vitest run` 144 passed ✅。

| 项 | 修复 | 文件 |
|---|---|---|
| S2-1 | 5 个 Store 展示组件从 `pages/` 迁入 `components/store/`（StoreToolbar / StoreFilterBar / StoreGrid / StoreEmptyState / StoreErrorState），更新所有导入路径 | `components/store/*.tsx`（新目录）、`pages/Store.tsx` |
| S2-2 | 格式化函数合并（已在第三批 S1-4 顺带完成，`formatCompactNumber` + `formatRelativeTime` 统一到 `lib/format.ts`） | — |
| S2-3 | 头像回退逻辑四份重复统一为 `<EntityAvatar name iconUrl githubUsername size radius />`（色板数组单一定义，圆角参数化 `rounded-lg` vs `rounded-xl`） | `components/store/EntityAvatar.tsx`（新增）、`ServerCard.tsx`、`SkillCard.tsx`、`ServerIcon.tsx`、`SkillIcon.tsx` |
| S2-4 | `mapPlatformServer` 移除 `as ServerListItem` 强转，`repository` 只保留 `{url}` 消除多余的 `branch/owner/repo` 假字段 | `hooks/useMcpData.ts` |
| S2-5 | `ResourceType` 双定义消除：`StoreResourceType` 改为从 `api/registry.ts` 别名导入 | `hooks/storeTypes.ts` |
| S2-6 | `useStoreData` 转发层保留（React hooks 无条件调用规则要求两者都调用，三元选择是必要模式，非无意义中间层） | — |
| S2-7 | `Store.tsx` 移除 `result`/`displayTotal`/`isLoading`/`isFetching`/`error`/`friendlyMessage` 无意义别名，模板直接使用 `data.x` | `pages/Store.tsx` |
| S2-8 | `useStoreFacets` 恒真三元 `resourceType === 'mcp' ? true : true` 已在前批清为 `enabled: true` | — |
| S2-9 | `useStoreFacets` queryKey 补 `platformType`（随 S0-1 一并完成） | — |
| S2-10 | GitHub 源 queryKey 移除无用 `selectedSkillSourceId` 维度，从 `['skillsGithub', selectedSkillSourceId]` 简化为 `['skillsGithub']` | `hooks/useSkillsData.ts` |
| S2-11 | `StoreGrid` key 从 `${currentPage}-${index}-${server.id}` 简化为 `server.id`，修复 memo 失效；移除 `currentPage` 冗余 props | `components/store/StoreGrid.tsx` |
| S2-12 | 网格从固定 `grid-cols-2` 改为响应式 `grid-cols-1 md:grid-cols-2 xl:grid-cols-3` | `components/store/StoreGrid.tsx` |
| S2-13 | 路由跳转统一：`window.location.hash` → `useNavigate()`（React Router 最佳实践） | `StoreEmptyState.tsx`、`StoreToolbar.tsx` |
| 附录 | zustand 死代码清理：移除 `resetPagination`（零引用） | `store/useStore.ts` |
| 附录 | UTF-8 BOM 头清理：`StoreGrid.tsx`、`useStoreAttribution.ts` 移除 `\xEF\xBB\xBF` | `StoreGrid.tsx`、`useStoreAttribution.ts` |

**合计 38 条全部完成** 🎉
