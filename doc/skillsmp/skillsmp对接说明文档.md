# SkillsMP 搜索接口 · 详细对接说明文档

> 版本：v1.0（2026-08-16） · 接口：`GET https://skillsmp.com/api/v1/skills/search`
> 文档性质：**实测对接手册**（全部结论经真实请求验证，含官方文档未写明的暗门）

---

## 〇、对接前必读（结论先行）

1. **`q` 是唯一必填参数**，且是"关键字搜索"而非过滤——`category`/`occupation`/`language` 只能在 q 的结果范围内做二次筛选，**不能脱离 q 单独使用**（实测缺 q / 空 q / `*` 均 400）。
2. **别信 `total`**：`totalIsExact=false` 时是近似值（同一关键字两轮请求实测 total 从 6 跳到 51），且**单查询结果窗口封顶 1000 条**（`isCapped:true, maxResults:1000`），超出会被"规范化"到最后一页。
3. **limit 有效上限是 50**：传 101/100 都会被静默钳到 50（官方文档写最大 100，实测不符）；传 0 被钳到 1。
4. **分类过滤只用"叶子 slug"**：官方文档示例 `category=data-ai`（组级）实测**恒返回 0 条**；叶子 slug（如 `debugging`、`frontend`）正常。
5. **限流严格**：匿名 50 次/天、10 次/分钟；带 API Key 500 次/天、30 次/分钟——只做关键字搜索。开发期务必缓存、节拍、错峰。

---

## 一、接口概览

| 项 | 值 |
| :--- | :--- |
| 协议 | HTTPS |
| 路径 | `https://skillsmp.com/api/v1/skills/search` |
| 方法 | `GET` |
| 鉴权 | 可选：`Authorization: Bearer sk_live_xxx`（匿名可读，限流更严） |
| 请求格式 | Query String |
| 响应格式 | `application/json` |
| 官方元数据 | OpenAPI：`https://skillsmp.com/openapi.json` · 目录：`https://skillsmp.com/api/llms.txt` |
| 附带服务 | MCP Server：`POST https://skillsmp.com/mcp`（工具：search_skills / get_skill / list_categories） |

---

## 二、请求参数（Query）· 含实测边界

| 参数 | 类型 | 必填 | 官方说明 | 实测行为 |
| :--- | :--- | :---: | :--- | :--- |
| `q` | String | ✅ | 搜索关键字 | 缺省/空串 → `400 MISSING_QUERY`；`*` → `400 INVALID_QUERY`；无命中 → `200` 空列表（不掺假） |
| `page` | Integer | 否 | 页码(默认1) | 超出可查询窗口会被**规范化到最后一页**（官方原话 canonicalized） |
| `limit` | Integer | 否 | 每页数量(默认20, **文档称最大100**) | **实测有效上限 50**，101/100 → 静默钳到 50；0 → 钳到 1 |
| `sortBy` | String | 否 | `stars`(默认) / `recent` | **真实生效**（两轮 id 列表不同）；非法值静默回退 `stars` |
| `category` | String | 否 | 分类 slug（文档示例 `data-ai`） | 叶子 slug **生效**；**组级 slug 实测恒 0**（文档示例有误导性） |
| `occupation` | String | 否 | SOC 职业 slug（如 `software-developers`） | 实测生效（结果集合改变） |
| `language` | String | 否 | ISO 语言码 / `mul` / `und` | 实测生效（按内容检测语言过滤） |

---

## 三、响应结构

- 信封：`{success, data: {skills / pagination / filters}, meta: {requestId, responseTimeMs}}`
- `data.pagination`：`page / limit / total / totalPages / hasNext / hasPrev / totalIsExact / isCapped / maxResults`
- `data.filters`：回显 `search / sortBy`；`meta` 仅含 `requestId` / `responseTimeMs`（请求追踪用）
- 单条 Skill（9 字段，**不含分类字段**——分类只作搜索范围过滤，不进结果）：

| 字段 | 说明 |
| :--- | :--- |
| `id` | 唯一 ID（形如 `github-user-repo-skills-name-skill-md`） |
| `name` | Skill 名称 |
| `author` | 作者/仓库归属 |
| `description` | 描述（多语言，见 `contentLanguage`） |
| `contentLanguage` | 内容检测语言（ISO 码 / mul / und） |
| `stars` | GitHub Star 数 |
| `skillUrl` / `githubUrl` | Skill 详情页 / 源码地址 |
| `updatedAt` | 更新时间 |

```json
{"success": true, "data": {"skills": [{"id": "...", "name": "seo", "author": "...", "stars": 239888, "contentLanguage": "ja", "skillUrl": "...", "githubUrl": "...", "updatedAt": "..."}], "pagination": {"page": 1, "limit": 5, "total": 6, "totalPages": 2, "totalIsExact": false}, "filters": {"search": "SEO", "sortBy": "stars"}}, "meta": {"requestId": "...", "responseTimeMs": 3}}
```
> ⚠ 分页信息在 **`data.pagination`**，不在 `meta` 下（`meta` 只含 `requestId`/`responseTimeMs`）。

---

## 四、错误码与异常处理（实测 body）

| HTTP | code | 触发条件 | 实测响应体示例 |
| :--- | :--- | :--- | :--- |
| 400 | `MISSING_QUERY` | 缺 q / q 为空串 | `{"success":false,"error":{"code":"MISSING_QUERY","message":"Query parameter \"q\" is required"}}` |
| 400 | `INVALID_QUERY` | q 不含字母数字（如 `*`） | `{"success":false,"error":{"code":"INVALID_QUERY","message":"Query must contain at least one letter or number"}}` |
| 401 | `INVALID_API_KEY` | Bearer 格式非法 | `{"success":false,"error":{"code":"INVALID_API_KEY","message":"Invalid API key format"}}` |
| 404 | `ENDPOINT_NOT_FOUND` | 路径不存在 | 响应 `meta.availableEndpoints` 会**列出全部可用端点**（排查神器） |
| 429 | 限流 | 超过速率/每日配额 | 按官方限流表节拍重试（指数退避 + 缓存） |

---

## 五、速率限制与配额管理

| 方式 | 每日配额 | 每分钟 | 可调用 |
| :--- | :--- | :--- | :--- |
| 匿名（无 key） | **50 次** | 10 次 | 仅关键字搜索 |
| API Key（`sk_live_*`） | **500 次** | 30 次 | 关键字搜索 |

- 平台自称收录 **2M+ Agent Skills**（llms.txt）；REST 无全量/分类端点，**不建议逐条爬取**。
- 实践：客户端本地建"采样索引 + 缓存"，把实时 API 当增量刷新源（本项目即此模式）。

---

## 六、分类枚举与中英文对照（13 组 + 62 叶）

> 来源：厂商官方分类列表（站点 UI 同源）。**组级 slug 实测过滤恒 0，务必只用叶子 slug**。
> 完整 JSON：`skillsmp_categories.json`（含英文显示名 / 中文名 / 数量 / 所属组）。

| # | slug | 英文名 | 中文名 | 数量 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `blockchain` | Blockchain | 区块链 | —（组级，实测过滤恒 0） |
| 2 | `business` | Business | 商业 | —（组级，实测过滤恒 0） |
| 3 | `content-media` | Content & Media | 内容与媒体 | —（组级，实测过滤恒 0） |
| 4 | `data-ai` | Data & AI | 数据与AI | —（组级，实测过滤恒 0） |
| 5 | `databases` | Databases | 数据库 | —（组级，实测过滤恒 0） |
| 6 | `development` | Development | 开发 | —（组级，实测过滤恒 0） |
| 7 | `devops` | DevOps | DevOps 运维 | —（组级，实测过滤恒 0） |
| 8 | `documentation` | Documentation | 文档与知识 | —（组级，实测过滤恒 0） |
| 9 | `lifestyle` | Lifestyle | 生活方式 | —（组级，实测过滤恒 0） |
| 10 | `research` | Research | 科研 | —（组级，实测过滤恒 0） |
| 11 | `testing-security` | Testing & Security | 测试与安全 | —（组级，实测过滤恒 0） |
| 12 | `tools` | Tools | 工具 | —（组级，实测过滤恒 0） |
| 13 | `system-admin` | System Admin | 系统管理 | —（组级，实测过滤恒 0） |
| 14 | `defi` | DeFi | DeFi 去中心化金融 | 1,376 |
| 15 | `smart-contracts` | Smart Contracts | 智能合约 | 9,657 |
| 16 | `web3-tools` | Web3 Tools | Web3 工具 | 7,347 |
| 17 | `business-apps` | Business Apps | 商业应用 | 2,965 |
| 18 | `ecommerce` | Ecommerce | 电子商务 | 8,799 |
| 19 | `finance-investment` | Finance Investment | 金融投资 | 71,840 |
| 20 | `health-fitness` | Health Fitness | 健康健身 | 7,950 |
| 21 | `payment` | Payment | 支付 | 7,898 |
| 22 | `project-management` | Project Management | 项目管理 | 82,938 |
| 23 | `real-estate-legal` | Real Estate Legal | 房地产与法律 | 45,221 |
| 24 | `sales-marketing` | Sales Marketing | 销售与营销 | 249,154 |
| 25 | `content-creation` | Content Creation | 内容创作 | 30,229 |
| 26 | `design` | Design | 设计 | 17,776 |
| 27 | `documents` | Documents | 文档处理 | 90,134 |
| 28 | `media` | Media | 媒体 | 15,581 |
| 29 | `data-analysis` | Data Analysis | 数据分析 | 16,405 |
| 30 | `data-engineering` | Data Engineering | 数据工程 | 38,705 |
| 31 | `llm-ai` | LLM AI | LLM 大模型 | 110,939 |
| 32 | `machine-learning` | Machine Learning | 机器学习 | 52,917 |
| 33 | `database-tools` | Database Tools | 数据库工具 | 14,278 |
| 34 | `nosql-databases` | NoSQL Databases | NoSQL 数据库 | 1,669 |
| 35 | `sql-databases` | SQL Databases | SQL 数据库 | 11,555 |
| 36 | `architecture-patterns` | Architecture Patterns | 架构模式 | 88,934 |
| 37 | `backend` | Backend | 后端开发 | 55,248 |
| 38 | `cms-platforms` | CMS Platforms | CMS 平台 | 15,338 |
| 39 | `ecommerce-development` | Ecommerce Development | 电商开发 | 8,072 |
| 40 | `framework-internals` | Framework Internals | 框架原理 | 18,038 |
| 41 | `frontend` | Frontend | 前端开发 | 46,777 |
| 42 | `full-stack` | Full Stack | 全栈开发 | 13,974 |
| 43 | `gaming` | Gaming | 游戏开发 | 29,256 |
| 44 | `mobile` | Mobile | 移动开发 | 27,265 |
| 45 | `package-distribution` | Package Distribution | 包分发 | 18,982 |
| 46 | `scripting` | Scripting | 脚本语言 | 22,886 |
| 47 | `cicd` | CI/CD | CI/CD 持续集成 | 45,522 |
| 48 | `cloud` | Cloud | 云服务 | 19,118 |
| 49 | `containers` | Containers | 容器 | 15,218 |
| 50 | `git-workflows` | Git Workflows | Git 工作流 | 111,760 |
| 51 | `monitoring` | Monitoring | 监控 | 9,991 |
| 52 | `education` | Education | 教育 | 50,241 |
| 53 | `knowledge-base` | Knowledge Base | 知识库 | 65,906 |
| 54 | `technical-docs` | Technical Docs | 技术文档 | 58,466 |
| 55 | `arts-crafts` | Arts & Crafts | 艺术手工艺 | 6,554 |
| 56 | `culinary-arts` | Culinary Arts | 烹饪艺术 | 2,082 |
| 57 | `divination-mysticism` | Divination & Mysticism | 占卜与神秘学 | 5,821 |
| 58 | `literature-writing` | Literature Writing | 文学写作 | 7,815 |
| 59 | `philosophy-ethics` | Philosophy & Ethics | 哲学伦理 | 8,370 |
| 60 | `wellness-health` | Wellness & Health | 健康养生 | 6,996 |
| 61 | `academic` | Academic | 学术研究 | 28,775 |
| 62 | `astronomy-physics` | Astronomy & Physics | 天文物理 | 7,317 |
| 63 | `bioinformatics` | Bioinformatics | 生物信息学 | 19,805 |
| 64 | `computational-chemistry` | Computational Chemistry | 计算化学 | 18,256 |
| 65 | `lab-tools` | Lab Tools | 实验室工具 | 19,882 |
| 66 | `scientific-computing` | Scientific Computing | 科学计算 | 7,551 |
| 67 | `code-quality` | Code Quality | 代码质量 | 120,401 |
| 68 | `security` | Security | 安全 | 72,042 |
| 69 | `testing` | Testing | 测试 | 80,826 |
| 70 | `automation-tools` | Automation Tools | 自动化工具 | 26,652 |
| 71 | `cli-tools` | CLI Tools | CLI 命令行工具 | 14,477 |
| 72 | `debugging` | Debugging | 调试 | 311,616 |
| 73 | `domain-utilities` | Domain Utilities | 领域工具 | 9,828 |
| 74 | `ide-plugins` | IDE Plugins | IDE 插件 | 23,767 |
| 75 | `productivity-tools` | Productivity Tools | 效率工具 | 88,256 |

### 6.1 分类使用说明
- **中英文对照**：`zh` 为本次对接补充的展示映射；调用 `category` 参数时一律传**英文叶子 slug**（已实测）。
- **组级 slug 陷阱**：官方文档示例 `category=data-ai` 实测返回 0 条——组级仅作站点导航，不作过滤键。若你的业务需要"数据与AI"全组，请分别传 4 个叶子 slug 后客户端合并。
- **数量口径**：各叶子 count 为该分类收录总量（站点展示值），非当前可查询窗口值；单查询实际窗口恒 ≤1000。

---

## 七、过滤 / 排序 / 语言 · 实测结论

| 参数 | 实测结论 |
| :--- | :--- |
| `q` | ✅ 必需且真实生效；无命中返回空列表（total=0, totalIsExact=true），不掺假 |
| `sortBy=stars/recent` | ✅ 真实生效（集合与顺序均变化）；非法值静默回退 stars |
| `category`（叶子 slug） | ✅ 生效（集合改变） |
| `category`（组级 slug） | ❌ 恒 0 条，勿用 |
| `occupation` | ✅ 生效（集合改变；SOC 职业 slug） |
| `language` | ✅ 生效（按内容检测语言过滤；en/zh/ja…/mul/und） |
| 未知参数 | 静默忽略（不影响结果） |

---

## 八、调用示例

### 8.1 curl
```bash
# 匿名（限流 50/天）
curl -s "https://skillsmp.com/api/v1/skills/search?q=SEO&page=1&limit=20&sortBy=stars"

# 带 key（500/天）—— 组合过滤
curl -s "https://skillsmp.com/api/v1/skills/search?q=SEO&category=debugging&language=zh&sortBy=recent" \
  -H "Authorization: Bearer sk_live_YOUR_KEY"
```

### 8.2 Python（限流感知）
```python
import json, time, urllib.parse, urllib.request

def search(q, category=None, language=None, sort_by="stars", page=1, limit=50, token=None):
    params = {"q": q, "page": page, "limit": limit, "sortBy": sort_by}
    if category: params["category"] = category
    if language: params["language"] = language
    url = "https://skillsmp.com/api/v1/skills/search?" + urllib.parse.urlencode(params)
    headers = {"Accept": "application/json"}
    if token: headers["Authorization"] = "Bearer " + token
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=40) as r:
        d = json.loads(r.read())
    if not d["success"]:
        raise RuntimeError(d.get("error"))
    pag = d["data"]["pagination"]
    if pag.get("isCapped"):
        print(f"[提示] 结果窗口封顶 1000，只取了前 {pag['totalPages']*pag['limit']} 条")
    return d["data"]["skills"], pag
# 使用：search("SEO", category="debugging", token="sk_live_xxx")
# 节拍：带 key 时两次调用间隔 ≥2s；匿名 ≥6s（10/min 上限）
```

### 8.3 增强查询 CLI（交付物）
```bash
# 实时模式
python query_skillsmp.py --q SEO --sortBy recent --limit 10
python query_skillsmp.py --q SEO --category debugging --language zh --token sk_live_xxx
# 离线模式（浏览采样索引，免配额）
python query_skillsmp.py --offline --category frontend --sort stars --page-size 10
```

---

## 九、交付物清单

| 文件 | 作用 |
| :--- | :--- |
| `probe_skillsmp.py` / `verify_skillsmp.py` | 接口探测与集合比对脚本 |
| `skillsmp_openapi.json` | 官方 OpenAPI 规范快照 |
| `sample_skillsmp.py` | 采样爬虫（18 组关键字×分类，节拍 3.5s） |
| `skillsmp_index.jsonl` | 采样索引（约 250+ 条） |
| `skillsmp_categories.json` | 分类枚举（13 组+62 叶，中英对照） |
| `skillsmp_compact.json` | 压缩数据集（内嵌浏览器用） |
| `skillsmp_explorer.html` | 自包含示例浏览器（双语分类/搜索/排序/分页） |
| `query_skillsmp.py` | 增强查询 CLI（实时+离线双模式） |
| `skillsmp对接说明文档.md` | 本文档 |

---

## 十、最佳实践 & 对接 Checklist

- [ ] `q` 必填并做非空/去通配符校验（`*` 会被 400）
- [ ] `limit` 不超过 50；按 `meta.pagination.limit` 回读真实值
- [ ] 分页循环：读 `totalPages`/`hasNext`，遇 `isCapped` 停止（窗口 1000 封顶）
- [ ] 不信任 `total`（`totalIsExact=false`）；展示用计数以客户端聚合为准
- [ ] `category` 只传**叶子 slug**；组级 slug 已实测无效
- [ ] 限流节拍：带 key ≥2s/次、匿名 ≥6s/次；异常 429 指数退避
- [ ] 本地建采样索引 + 缓存，实时 API 仅作增量源
- [ ] 语言过滤用 `language`（en/zh/ja…/mul/und 全枚举见 OpenAPI）
- [ ] 复用 OpenAPI（`/openapi.json`）与 404 返回的 `availableEndpoints` 做自愈式排查

---

## 附录 · 语言枚举（官方 OpenAPI）

`en, zh, ja, ko, es, pt, de, fr, ar, afr, aka, amh, aze, bel, ben, bul, cat, ces, cym, dan, ell, epo, est, fin, guj, heb, hin, hrv, hun, hye, ind, ita, jav, kan, kat, kaz, khm, lat, lav, lit, mal, mar, mkd, msa, mya, nep, nld, nob, ori, pan, pes, pol, ron, rus, sin, slk, slv, sna, srp, swa, swe, tam, tel, tgl, tha, tuk, tur, ukr, urd, uzb, vie, yid, zul, mul, und`
