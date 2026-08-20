# ClawHub 技能搜索接口 · 详细对接说明文档

> 版本：v1.1（2026-08-16） · 接口：`POST https://wry-manatee-359.convex.cloud/api/action`（Convex RPC）+ 详情/安装 REST 直链
> 文档性质：**实测对接手册**（所有结论经真实请求验证，含官方未公开的边界行为）

---

## 〇、对接前必读（结论先行）

1. **这是 Convex RPC，不是 REST**：所有参数打包在 body 的 `args` 数组里，`path` 指定 action 名（`search:searchSkills`），`format` 用 `convex_encoded_json`。
2. **`query` 必填且非空**：空串或缺失 → 静默返回空数组（不报错！）。连"按分类浏览"也必须有非空 query（实测 `categorySlug=integrations + query=''` → 0 条）。
3. **`categorySlug` 空串是陷阱**：想"全部分类"必须**省略该字段**；传 `""` 会把结果过滤成 0。这是最容易踩的坑。
4. **无分页、无 total、单次上限 100 条**：`cursor/offset/page/skip/after` 全部 500（未知参数直接 Server Error）；`limit` 传 500 被静默钳到 100。只能取第一页最多 100 条。
5. **严格参数校验**：多加任何未知字段 → `{"status":"error","errorMessage":"[Request ID: xxx] Server Error"}`（HTTP 200）。与 REST 接口"静默忽略未知参数"完全相反。
6. **详情与安装走独立 REST 直链**（v1.1 整合 mcp-dock 方案）：`GET /api/v1/skills/<slug>` 拉完整 SKILL.md 元数据，`GET /api/v1/download?slug=<slug>` 直下 zip 安装；两者均无鉴权、CORS 放开，`slug` 直接用列表返回的 `slug` 字段。详情接口**偶发 500**（Convex 抖动，重试即过）；下载带 `Ratelimit-Limit: 1200` 限流头。

---

## 一、接口概览

| 项 | 值 |
| :--- | :--- |
| 端点 | `https://wry-manatee-359.convex.cloud/api/action` |
| 方法 | `POST` |
| 内容类型 | `application/json` |
| 调用形态 | Convex action RPC：`{"path": "search:searchSkills", "format": "convex_encoded_json", "args": [{...}]}` |
| 鉴权 | 无（公开接口；需携带浏览器同款头，见下） |
| 必需请求头 | `Content-Type: application/json`、`Convex-Client: npm-1.43.0`、`Origin: https://clawhub.ai`、`Referer: https://clawhub.ai/`（照抄浏览器即可） |
| 数据规模 | 未知（响应无 total 字段；单次最多 100 条） |
| 宿主站点 | https://clawhub.ai（技能市场） |
| 详情查询（补充） | `GET https://clawhub.ai/api/v1/skills/<slug>` · 无鉴权 · 返回完整 SKILL.md 元数据（偶发 500 重试即过） |
| 一键安装（补充） | `GET https://clawhub.ai/api/v1/download?slug=<slug>` · 无鉴权 · 返回 zip，`CORS: *` 前端可直连（限流 1200/窗口） |

---

## 二、请求体（Body）结构

```json
{"path": "search:searchSkills", "format": "convex_encoded_json",
  "args": [{"categorySlug": "integrations", "highlightedOnly": false, "limit": 25, "query": "tool"}]}
```

| 顶层字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `path` | String | action 路径，实测仅 `search:searchSkills` 可用（其他猜测全 500） |
| `format` | String | `convex_encoded_json`（`json` 亦可） |
| `args` | Array | 参数数组，**每个元素一个对象**（本次只有一个元素） |

### args 元素字段（实测）

| 字段 | 类型 | 必填 | 默认 | 实测行为 |
| :--- | :--- | :---: | :--- | :--- |
| `query` | String | ✅ | — | 搜索关键字；**空串/缺失 → 返回空数组**；无命中 → 空数组（不掺假） |
| `categorySlug` | String | 否 | 全部分类 | 分类过滤；**想全分类必须省略字段**，传 `""` → 结果恒 0（陷阱！） |
| `limit` | Integer | 否 | 10 | 每页条数；**上限 100**（传 500 静默钳到 100，不报错）；不传默认 10 |
| `highlightedOnly` | Boolean | 否 | false | 是否只看精选（本次未观察到差异，保持 false 即可） |

> ⚠ **禁止添加任何 args 表外的字段**（`cursor/offset/sortBy/order/page/skip/after` 等）→ 全部 500 Server Error。该接口**不支持分页与排序**，结果顺序由服务端综合评分决定（`score` 字段）。

---

## 三、响应结构

- 成功：`{"status": "success", "value": [{skill}, ...]}` —— `value` 是裸数组，**没有 total/分页元数据**。
- 单条 Skill 共 21 字段，关键字段：

| 字段 | 说明 |
| :--- | :--- |
| `id` / `slug` | 唯一 ID（如 `clawhub:kd70h…`）/ 展示 slug |
| `displayName` | 展示名（**原生中英混排**，如「小红书数据洞察与竞品分析助手」） |
| `canonicalUrl` | 站内路径（`/um-why/skills/xiaohongshu-tool`） |
| `source` | 来源（`clawhub` 原生 / `skills-sh` 等聚合源） |
| `score` / `downloads` | 综合评分（**同分大量重复**，如 5095.0）/ 下载量 |
| `metrics` | `{bookmarks, rolling60DayInstalls, updatedAt}` 短期指标 |
| `native.skill` | 嵌套详情：`categories[]`（**多分类数组**）、`summary`（中英混排）、`stats{downloads,installs,stars,versions}`、`tags`、`topics` |
| `native.owner` / `ownerHandle` / `publisher` | 作者信息（handle / 头像 / 组织或用户） |
| `install` | 安装指引：`{kind, reference, sourceUrl}` |
| `trust` | `{installability, visibility, sourceFreshness, upstreamScanners}` 可信度 |
| `updatedAt` | 更新时间（毫秒时间戳） |

---

## 四、错误处理（实测 body，全部 HTTP 200）

| 场景 | 响应 |
| :--- | :--- |
| 未知/多余 args 字段 | `{"status":"error","errorMessage":"[Request ID: xxx] Server Error"}` |
| 不存在的 action path | 同上（`search:searchCategories` 等 6 个猜测路径全 500） |
| query 空串/缺失 | 不是错误！返回 `{"status":"success","value":[]}`（静默空） |
| categorySlug 空串 | 同上（静默空，非报错） |

> 诊断技巧：`errorMessage` 里的 `[Request ID: xxx]` 是 Convex 服务端追踪号，可带去问平台。

---

## 五、分类枚举与中英文对照（14 类）

> 来源：站点 UI 分类列表 + 逐类实测验证。注意：**计数为"单次观测值"（query='a' + limit=100 的返回条数），非全库精确值**——接口无 total 字段，且无法翻页，真实规模不可知。
> 每条技能可挂**多个分类**（`native.skill.categories` 是数组）。

| # | categorySlug | 中文名 | 单次观测条数 |
| :--- | :--- | :--- | :---: |
| 1 | `integrations` | 集成连接 | 100 |
| 2 | `automation` | 自动化 | 100 |
| 3 | `research` | 研究检索 | 84 |
| 4 | `development` | 开发 | 60 |
| 5 | `productivity` | 效率提升 | 80 |
| 6 | `communication` | 沟通协作 | 57 |
| 7 | `creative` | 创意设计 | 91 |
| 8 | `knowledge` | 知识管理 | 59 |
| 9 | `agents` | 智能体 | 92 |
| 10 | `operations` | 运营管理 | 30 |
| 11 | `security` | 安全防护 | 49 |
| 12 | `finance` | 金融财务 | 100 |
| 13 | `lifestyle` | 生活方式 | 63 |
| 14 | `other` | 其他 | 100 |

### 5.1 分类使用说明
- `categorySlug` 直接传上表 slug；**全部分类 = 省略该字段**（不是传空串）。
- 分类浏览必须配非空 `query`（实测 `query=''` 时任何分类都返回 0）——前端分类页大概率走的是**另一个未公开 action**，本接口只能"关键字 + 分类范围"。
- 一条技能可属于多个分类（如 `["creative","research","integrations"]`），按分类筛选时做数组包含判断。

---

## 六、实测陷阱清单（务必照做）

| # | 陷阱 | 正确姿势 |
| :--- | :--- | :--- |
| 1 | `query=''` 静默返回空 | query 永远传非空字符串 |
| 2 | `categorySlug=''` 结果恒 0 | 全分类 → **省略字段**；有分类 → 传有效 slug |
| 3 | 未知 args 直接 500 | 只传 `query/categorySlug/limit/highlightedOnly` 四件套 |
| 4 | 以为能翻页 | 无分页，单次上限 100，只能拿第一页 |
| 5 | 传 `limit>100` 期望报错 | 不报错，静默钳到 100 |
| 6 | 依赖 total 做分页 | 没有 total，响应是裸数组 |

---

## 七、客户端架构建议

- **无分页 = 无法全量爬**：每查询固定返回 ≤100 条。建库策略：多关键字 × 多分类组合查询，做并集去重采样（本项目即此模式，1,154 条采样）。
- 实时查询体验好：单次 1 个请求拿 Top 100，适合做"推荐/搜索"场景，不适合做"全量同步"。
- 请求头照抄浏览器（`Origin`/`Referer`/`Convex-Client`），CORS 场景下保持站点身份。

---

## 八、调用示例

### 8.1 curl
```bash
curl -s -X POST "https://wry-manatee-359.convex.cloud/api/action" --compressed \
  -H "Content-Type: application/json" -H "Convex-Client: npm-1.43.0" \
  -H "Origin: https://clawhub.ai" -H "Referer: https://clawhub.ai/" \
  --data-raw '{"path":"search:searchSkills","format":"convex_encoded_json","args":[{"query":"tool","categorySlug":"integrations","highlightedOnly":false,"limit":25}]}'
```

### 8.2 Python
```python
import json, urllib.request

def search(query, category_slug=None, limit=25):
    arg = {"query": query, "highlightedOnly": False, "limit": limit}
    if category_slug:            # 全分类 = 不传该键（传空串会得 0 条！）
        arg["categorySlug"] = category_slug
    body = json.dumps({"path": "search:searchSkills", "format": "convex_encoded_json", "args": [arg]}).encode()
    req = urllib.request.Request("https://wry-manatee-359.convex.cloud/api/action", data=body, method="POST",
        headers={"Content-Type": "application/json", "Convex-Client": "npm-1.43.0",
                  "Origin": "https://clawhub.ai", "Referer": "https://clawhub.ai/"})
    d = json.loads(urllib.request.urlopen(req, timeout=40).read())
    if d.get("status") != "success":
        raise RuntimeError(d.get("errorMessage"))
    return d["value"]
```

### 8.3 增强查询 CLI（交付物）
```bash
# 实时模式（query 必填）
python query_clawhub.py --query tool --category integrations --limit 50
# 离线模式（浏览 1,154 条采样，免请求）
python query_clawhub.py --offline --category finance --sort downloads --page-size 10
```

---

## 九、详情查询 & 一键安装（实时链路）

> 来源：mcp-dock 项目已实现并端到端验证的安装方案（`D:\WorkSpace\mcp-dock\对接说明文档.md`），v1.1 整合进列表查询链路并**复测确认**（2026-08-16 实测：详情 5 连测 + 下载 3 连测全部通过）。

### 9.1 完整链路（列表 → 详情 → 安装）

```
列表接口（本文档第 二~三 章）返回 skill.slug（纯 slug，如 tavily）
   │
   ▼
详情（可选）: GET https://clawhub.ai/api/v1/skills/<slug>      ← 无鉴权，返回 { "skill": {...} }
   │              { displayName, summary, description(完整SKILL.md正文), stats, latestVersion, owner, ... }
   ▼
安装:         GET https://clawhub.ai/api/v1/download?slug=<slug>   ← 200 application/zip（CORS:*）
                → 解压 zip → 定位 SKILL.md → 解析 frontmatter(name / description) → 安装完成
```

### 9.2 详情接口（实测确认）

| 项 | 值 |
| :--- | :--- |
| 方法/地址 | `GET https://clawhub.ai/api/v1/skills/<slug>` |
| 鉴权 | 无（无需任何 header；带 `Accept: application/json` 亦可） |
| 响应 | HTTP 200 `{"skill": {...}}`；关键字段：`slug`、`displayName`、`summary`、`description`（**完整 SKILL.md 正文**）、`topics`/`tags.latest`、`stats{downloads,installs,stars,versions}`、`latestVersion{version,changelog,license}`、`owner{handle,displayName,image}`、`createdAt`/`updatedAt` |
| ⚠ 偶发 500 | 实测首次请求偶发 `A server error has occurred / INTERNAL_FUNCTION_INVOCATION_FAILED / [sin1::xxx]`（Convex 后端抖动），**重试即过**（重试 3 连测全通过） |

### 9.3 安装接口（实测确认）

| 项 | 值 |
| :--- | :--- |
| 方法/地址 | `GET https://clawhub.ai/api/v1/download?slug=<slug>` |
| 响应 | HTTP 200，`Content-Type: application/zip`，`Content-Disposition: attachment; filename="tavily-1.0.0.zip"` |
| CORS | `Access-Control-Allow-Origin: *`（renderer 可直连，无需走主进程代理） |
| 限流 | 响应带 `Ratelimit-Limit: 1200`（**1200 次/窗口**，实测新发现，官方文档未公开） |
| zip 内部 | `SKILL.md`（frontmatter: name/description）+ `references/` + `scripts/` + `skill-card.md` + `_meta.json`（实测 tavily 共 5 个文件，与 `extractSkillFromZip` 期望一致） |

### 9.4 slug 提取规则（mcp-dock 已验证 4 种 URL 形态）

`slug = URL pathname 最后一段`，以下 4 种形态均已端到端验证（提取 slug → 下载 zip → 解压 → 定位 SKILL.md → 解析 name/description 成功）：

1. `https://clawhub.ai/<owner>/skills/tavily`
2. `https://clawhub.ai/skills/<owner>/tavily`
3. `https://clawhub.ai/api/v1/skills/tavily`
4. `https://clawhub.ai/<owner>/skills/ai-video-generation`

列表接口返回的 `slug` 字段（如 `akshare-a-stock`）与 URL 最后一段完全一致，前端直接使用即可，无需再解析。

### 9.5 安装链路代码落点（mcp-dock 工程，供参考）

| 环节 | 文件 | 关键函数 / 常量 |
| :--- | :--- | :--- |
| slug 提取 | `src/main/platform-skill-resolver.ts` | `extractClawhubSlug(url)` |
| 下载直链分支 | 同上 | `resolvePlatformSkillUrl` 内 `platform === 'clawhub'` 分支 |
| zip 解析 | 同上 | `resolveZipSkill` → `extractSkillFromZip` |
| 下载基址 | `src/main/platform-constants.ts` | `CLAWHUB_DOWNLOAD_BASE = 'https://clawhub.ai/api/v1/download'` |
| 榜单卡片安装 | `src/renderer/.../mapClawhubEntry` | 已构造 `downloadUrl = CLAWHUB_DOWNLOAD_BASE + '?slug=' + slug` |

### 9.6 坑位提醒

- **slug 才是真主键**：趋势榜单里 `install.kind=clawhub` 的 reference 是 `owner/slug`，但那**不是** GitHub 仓库，拼 GitHub 地址必然 404。安装只认 `slug = pathname 最后一段`，不要从详情 URL 硬拆 owner。
- **详情与下载是两个独立接口**：详情看元数据（含完整 SKILL.md 正文），下载拿 zip 落地安装，两者共用同一个 `slug`。
- **改完 renderer 源码必须重新构建**：`npm run build:renderer`（或 dev 热更新）后 `dist/renderer` 才更新，否则应用加载的是旧打包产物。
- **网络出口差异（环境相关）**：mcp-dock 实测本机 Node `fetch` 直连 `clawhub.ai:443` 会超时（`UND_ERR_CONNECT_TIMEOUT`），PowerShell `Invoke-WebRequest` 可通；本次复测在 Git Bash curl 环境**直连全通**（无超时）。属环境出口/代理差异，非代码 bug；正式环境以浏览器/主进程 fetch 为准。
- **`tags.latest` 是版本号字符串，不是标签数组（已踩坑）**：详情响应里 `tags` 形如 `{"latest":"1.0.0"}`——`tags.latest` 是**版本号**（与 `latestVersion.version` 同源），并非话题标签数组；本批采样中 `topics` 字段多为缺失。渲染前务必先 `Array.isArray` 校验再 `.map`，否则 `tags.map is not a function` 直接导致详情面板崩溃。想要展示标签/分类，可改从 `metadata.openclaw.category` 取（explorer.html 的 `renderDetail` 已做防御：topics 数组 → tags 数组 → tags.latest 数组 → 兜底空数组，并补 `分类: <category>` 胶囊）。

---

## 十、交付物清单

| 文件 | 作用 |
| :--- | :--- |
| `probe_clawhub.py` | 端点/args/错误形态探测脚本 |
| `collect_clawhub.py` | 分类验证 + 组合采样脚本（1,154 条） |
| `clawhub_categories_raw.json` | 分类观测原始数据 |
| `clawhub_categories.json` | 14 类枚举（中英对照 + 观测计数） |
| `clawhub_index.jsonl` | 1,154 条采样索引 |
| `clawhub_compact.json` | 压缩数据集（浏览器内嵌） |
| `clawhub_explorer.html` | 自包含双语浏览器（分类/搜索/排序/分页 + **卡片「详情」弹窗实时拉取 & 「一键安装」下载**） |
| `query_clawhub.py` | 增强查询 CLI（实时+离线双模式） |
| `ClawHub对接说明文档.md` | 本文档 |

---

## 十一、最佳实践 & 对接 Checklist

- [ ] `query` 永远非空（空串静默返空，不是报错）
- [ ] 全分类 = 省略 `categorySlug`（空串是陷阱）
- [ ] args 只放 `query/categorySlug/limit/highlightedOnly`（多余字段 500）
- [ ] `limit ≤ 100`（超了静默钳制）
- [ ] 不做分页假设：单查询一次拿完 Top 100
- [ ] 多来源并存：结果里 `source` 有 `clawhub`/`skills-sh` 等，按需过滤
- [ ] 多分类技能：`categories` 是数组，筛选用包含判断
- [ ] 计数口径：无 total，分类数量是观测值不是全量值
- [ ] 详情接口偶发 500 → 客户端重试 ≥2 次（间隔 ~0.7s）
- [ ] 下载接口 `Ratelimit-Limit: 1200`/窗口 → 批量安装注意节拍，勿并发打满
- [ ] 安装用 `slug`（pathname 最后一段），勿用 `owner/slug` 拼 GitHub（必 404）
- [ ] 下载 zip 结构 = `SKILL.md + references/ + scripts/ + skill-card.md + _meta.json`，frontmatter 取 name/description
