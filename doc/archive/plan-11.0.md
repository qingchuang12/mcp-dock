## plan-11.0 · 移除 GitHub Registry 内置源 + 新建连接移除「自定义」(2026-09-11)

### 请求
川哥：(1)「移除商店 skills 的内置数据源 GitHub Registry」；(2) 续作并追加「移除设置 → Skill 源管理 → 新建连接 → 平台类型 → 自定义类型」。

### 范围（两件事）
1. **移除 GitHub Registry 内置 Skill 列表数据源**：所有 Skill 源改走平台直连 `api.platforms.searchSkills`。
   - `registry.ts`：删 `fetchGithubSkills`/`fetchSkillsList`/`revalidateSkillsList`/`forceRefreshSkillsList`/`clearSkillsCache` + `SKILLS_*` 常量 + `GithubContentEntry`；清理因此产生的未用 import。
   - `useSkillsData.ts`：删 `github` useQuery、`builtinPaginated` memo、`noCacheRef`；兜底 return 改用 `platform` 查询态；`forceRefresh` 保留于接口但从解构移除。
   - `useStoreSourceSelection.ts`：去 `BUILTIN_SKILL_SOURCE_IDS` 导入、`gh` 回退；`isDirectSkillSource = !!selectedConn`。
   - `connections-store.ts`：`builtinSkillSeeds()` 去 github seed（留 clawhub）。
   - `platform-constants.ts`：`PlatformType`/`PLATFORM_META`/`BUILTIN_SKILL_SOURCE_IDS`/`PLATFORM_HEALTH_PATHS` 全去 `github`。
   - `ConnectionManager.tsx`：`builtinIds=[BUILTIN_SKILL_SOURCE_IDS.clawhub]`。
   - 注释/文案：`useStoreFacets.ts`、`electron.ts`(注释)、`zh.json`/`en.json`、`StoreEmptyState.tsx`。
2. **新建 Skill 源连接移除「自定义」选项**：仅 `SKILL_PLATFORM_TYPES` 删末位 `'custom'`；`custom` 仍留 `PlatformType`/`PLATFORM_META`（存量自定义连接经 `unknownPlatformFallback` 只读展示），与 MCP 现有「仅存量可编辑」模式一致。

### 必须保留（与本次无关，误删会塌）
通用 GitHub 集成 `src/main/github.ts` 及引用方；`preload` `getRemoteDetail` + `main` `skills:get-remote-detail` IPC；`registry.ts` `inferSkillCategoryId`/`fetchReadmeFromGitHub`/`getJson`/`SkillListItem`。

### 验证（我独立执行，非采信子代理）
- 双 tsc：`tsconfig.main.json`、`tsconfig.json` 均 **exit 0**。
- `vitest --pool=vmForks --no-cache`：用 node 直拉 `vitest.mjs` → **28 files / 392 passed (392)**。
- 残留 grep：`fetchGithubSkills|fetchSkillsList|...|GithubContentEntry`、`BUILTIN_SKILL_SOURCE_IDS.github` 均 **无匹配**。
- 保留项 grep：`getRemoteDetail`/`inferSkillCategoryId`/`fetchReadmeFromGitHub` 均在。
- 说明：子代理某次经 `npx` 报「391/392，1 个 env-manager 失败」系该沙箱 PATH 无 npx 的**假失败**；直跑 node 为 392/0。
