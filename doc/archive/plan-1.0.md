# 商店问题修复计划 - Plan 1.0

> 版本：v1.1（2026-08-21）
> 依据：doc 目录下各平台对接文档 + 探针 HTML 示例（实测验证），非猜测。

---

## 问题根因分析（基于文档 vs 代码对比）

### 问题 1：MCP ModelScope 查询不到数据

**文档依据**：doc/modelscope/对接说明文档.md MCP 篇（L390-L414）
**探针验证**：doc/modelscope/modelscope-mcp-explorer.html（真实拉取 100 条，total_count=9959）

| 对比项 | 文档（真实 API） | 代码（当前实现） | 影响 |
|--------|-----------------|-----------------|------|
| HTTP 方法 | **PUT** | etch(url) 默认 GET | 方法不对 |
| 参数格式 | JSON Body | Query String | 参数全被忽略 |
| 响应数组路径 | data.mcp_server_list | locateArray() 没有 mcp_server_list | 找不到数据 |
| 分页字段 | data.total_count | extractPageInfo 不查 	otal_count | 总数取不到 |
| 字段名 | 
ame、chinese_name、categories(数组) 等全小写 | RawMS 接口：Name/Description/Stars（大写+虚构） | 字段全 undefined |
| 分类过滤 | ilter.category 服务端真生效 | 代码自己做客户端过滤 | 数据都没拿到 |

**涉及文件**：
- modelscope.ts L28-L30 — MS_SERVER_TPLS（GET + Query String）
- modelscope.ts L53-L70 — RawMS 接口（字段名全错）
- modelscope.ts L102-L123 — mapServer（字段映射全错）
- modelscope.ts L190-L249 — msServerSearchImpl（复用 GET 探测）
- shared.ts L175-L274 — probeEndpoints（只支持 GET）
- shared.ts L65-L81 — locateArray（缺少 mcp_server_list 路径）
- shared.ts L97-L144 — extractPageInfo（缺少 	otal_count 字段）

**修复方案**：
1. 为 msServerSearchImpl 单独实现 PUT 请求（不经过 probeEndpoints），JSON Body 传参
2. 新建 RawMCP 接口，使用真实字段名
3. locateArray 增加 data.mcp_server_list 路径
4. extractPageInfo 增加 	otal_count 字段识别
5. 服务端过滤 ilter.category 直接在请求 body 中传入

---

### 问题 2：Smithery 分类和排序切换无效

**根因**：useMcpData.ts smithery 分支只调了 searchServers，完全没调 ilterServersByCategory 和 sortServers。

对比 Official 分支（三者都调了）：
`	ypescript
// Official 分支（正常）
const filtered = searchServers(list, debouncedSearch);
const categorized = filterServersByCategory(filtered, category || '');
const sorted = sortServers(categorized, sort || '');

// Smithery 分支（缺两步骤）
const items = res ? searchServers(res.items, debouncedSearch) : [];
`

**涉及文件**：useMcpData.ts L124-L147

**修复方案**：在 smithery 分支的 searchServers 之后，补上 ilterServersByCategory 和 sortServers 调用。

---

### 问题 3：Skill ModelScope 描述全部为空 + 分类/排序无效

**文档依据**：API 返回的 Skill 字段全部是**小写/蛇形命名**：
`json
{
  "_id": "FVA80usrezHtdfEq7GEFxA==",
  "id": "@anthropics/skill-creator",
  "display_name": "skill-creator",
  "description": "创建新技能...",
  "category": "skill-management",
  "tags": ["category:skill-management", "developer:anthropics"],
  "developer": "anthropics",
  "view_count": 51281,
  "downloads": 13517,
  "logo_url": "https://..."
}
`

**代码 RawMS 接口**（全用大写 + 虚构字段）：
`	ypescript
interface RawMS {
    Name?: string;        // 不存在，应为 display_name
    Id?: string;          // 大写，API 是 id（小写）
    Description?: string; // 大写，API 是 description（小写）
    Summary?: string;     // 不存在
    Stars?: number;       // 不存在，应为 view_count
    Author?: ...;         // 不存在，应为 developer
    Tags?: string[];      // 大写，API 是 tags（小写）
}
`

**mapSkill 函数**（取不到任何值）：
`	ypescript
description: raw.Description || raw.Summary || '',  // 全 undefined
stars: raw.Stars,                                    // undefined
category: raw.Tags ? raw.Tags[0] : undefined,        // undefined
`

**分类枚举也全错**：代码用 cv/nlp/audio 等 9 类，实际 API 返回 developer-tools/ai-media/marketing-seo 等 18 类。

**涉及文件**：
- modelscope.ts L53-L70 — RawMS 接口
- modelscope.ts L76-L99 — mapSkill 函数
- modelscope.ts L32-L42 — MS_CATEGORIES 分类枚举
- modelscope.ts L167-L183 — 客户端分类/排序（用错字段）

**修复方案**：
1. 重写 RawMS 接口，使用真实字段名（全小写/蛇形）
2. 重写 mapSkill 函数，正确映射所有字段
3. 更新 MS_CATEGORIES 为文档中实际的 18 个分类
4. 客户端分类/排序逻辑已有，但要用正确的字段名关联

---

### 问题 4：ClawHub 分类和排序无效

**文档依据**：API 不支持分页与排序，sortBy/order 等参数全部导致 500 Server Error。

**根因**：clawhub.ts 的 searchSkills 忽略了 category 和 sort 参数。

**修复方案**：在 searchSkills 拿到数据后，客户端做 category 过滤和 sort 排序。

---

### 问题 5：Official 内置源分类过滤依赖关键词推断

**根因**：search.ts 的 ilterServersByCategory 使用 inferSkillCategoryId(displayName) 做关键词推断，而非使用 categories 字段。

**修复方案**：优化 ilterServersByCategory 优先使用 categories 字段，不存在时再 fallback 到关键词推断。

---

### 问题 6：Smithery 数据缺少 categories 字段映射

**根因**：egistry.ts 的 SmitheryServer 接口没有 categories 字段，etchSmitheryServersPaged 也没有映射。

**修复方案**：确认 Smithery API 是否返回 categories 字段。如有则补充映射；如无则配合问题 5 的 fallback 关键词推断。

---

## TODOS

- [x] **T1**：修复问题 3（Skill ModelScope 描述为空）— 重写 RawMS 接口、mapSkill、分类枚举
- [x] **T2**：修复问题 1（MCP ModelScope 查询不到数据）— PUT 请求 + RawMCP 接口 + locateArray/extractPageInfo 增强
- [x] **T3**：修复问题 2（Smithery 分类/排序无效）— 补齐过滤/排序调用
- [x] **T4**：修复问题 4（ClawHub 分类/排序无效）— 客户端过滤排序
- [x] **T5**：修复问题 5（Official 分类过滤关键词推断）— 优先 categories 字段
- [x] **T6**：修复问题 6（Smithery 缺少 categories）— 字段映射
- [x] **T7**：全量编译验证 + 回归测试
