# plan-5.0 · 新增商店 Skills 平台源：Coze（虾评 Skill）

> 版本：5.0（2026-09-10）· 前任：[archive/plan-4.0.md](archive/plan-4.0.md)（Official 源移除，已完成并归档）

## 背景与目标

商店 Skills 需新增数据源 `https://xiaping.coze.com`（站点名「虾评 Skill」，支持 OpenClaw 的 Skill 评测市场），作为**可添平台源**接入（与 SkillHub/ModelScope/SkillsMP 同构）。用户已确认：**仅列表浏览**，不涉及详情打开与安装下载。

已实测接口（2026-09-10，全部公开匿名可访问，无需凭证）：

- 列表：`GET /api/skills` → `{skills:[...], total, hasMore}`，全库 `total=2265`
- 分页：`page`（1-based）+ `limit`，服务端真分页，返回 `total` + `hasMore`
- 搜索：`?search=词`（匹配 name），`q`/`keyword` 无效
- 分类：`GET /api/categories` → 官方 **8 个中文分类**（效率工具/社交互动/学习教育/创意设计/数据分析/娱乐休闲/生活实用/其他），`?category=中文名` 服务端过滤（需 encodeURIComponent）
- 排序：pick **仅** `avg_stars` / `downloads` / `comment_count` 合法（实测 stars/rating/latest/hot/featured/trending/newest 等全部 500），服务端排序
- 字段：`id,name,description,trigger[],category[],tags[],owner_name,current_version,downloads,avg_stars(千分制,490=4.90),star_count,comment_count,requires_api_key,security_status,created_at,updated_at`
- 详情/下载需注册认证（POST /api/auth/register + Authorization），商城不实现

## 范围与边界

**做**

1. `shared/platform-constants.ts`：`PlatformType` 加 `'coze'`；`PLATFORM_META.coze`（label `虾评 Coze`、defaultBaseUrl `https://xiaping.coze.com`）；`SKILL_PLATFORM_TYPES` 加 `coze`；`PLATFORM_HEALTH_PATHS.coze`（`/api/skills?limit=1`、`/`）。
2. `main/platforms/types.ts`：`SupportedPlatform` 加 `'coze'`；`platformTypeToSupported` 加 `case 'coze'`。
3. `main/platforms/coze.ts`：`cozeAdapter`（searchSkills + getFacets），直连确定接口，无需候选探测。
4. `main/platforms/registry.ts`：注册 `coze: cozeAdapter`。
5. i18n zh/en 若有平台名引用补文案；测试；`pnpm typecheck` / `pnpm test`（280 基线）全绿。

**不做**（理由）

- 详情打开 / 安装下载：需注册认证，商城不做（用户确认）。
- 默认 seed 内置连接：以 SKILL_PLATFORM_TYPES 可添平台呈现（用户确认「可添平台源」）。
- MCP 端接入：该源为 Skill 平台源，仅 skills 商店。
- 排序其它候选值：实测均为 500，数据源不支持，仅暴露白名单三档。

## 实现思路

- `cozeAdapter.searchSkills` 直连 `GET {base}/api/skills?page=&limit=&search=&category=&sort=`；`sort` option 的 `id` 直接等同接口 `sort` 值（`avg_stars`/`downloads`/`comment_count`）。
- 分类 id 本就为中文名，`category`/`categoryName` 同值 → 卡片 tag 直接中文，无中英不一致问题（比 skillhub 简单）。
- `mapCozeSkill`：`downloads`→`downloads`、`avg_stars`→`stars`（千分，保持平台原生量纲），`requires_api_key`→`extra.requiresApiKey`（复用既有「需 API Key」徽标），`owner_name`→`extra.author`，`comment_count`/`security_status` 入 `extra`。
- `sourceUrl`：站点为 SPA 无稳定单一详情直链，列表浏览以站点根为打开地址。
- 风险回滚：改动集中未提交，整体 `git checkout` 可回退；typecheck + 测试基线兜底。

## TODOS

- [x] ① platform-constants：type / meta / SKILL_PLATFORM_TYPES / health
- [x] ② platforms/types：SupportedPlatform + platformTypeToSupported
- [x] ③ platforms/coze.ts：adapter（searchSkills + getFacets + mapCozeSkill）
- [x] ④ registry 注册 coze
- [x] ⑤ i18n 文案（平台名直接取自 PLATFORM_META.label，无需额外 key）+ 测试（coze 3 例）
- [x] ⑥ typecheck + pnpm test 全绿（284/284；main+render 0 错）