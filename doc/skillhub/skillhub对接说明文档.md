# SkillHub 技能接口 · 详细对接说明文档

> 版本：v1.0（2026-08-16） · 接口：`GET https://api.skillhub.cn/api/skills`
> 文档性质：**实测对接手册**（全部结论经真实请求验证，含官方文档未写明的隐藏参数）

---

## 〇、对接前必读（结论先行）

1. **无配额墙，可全量拉取**：`total=114986` 真实可信，`page=1150` 仍正常返回（86 条），`page=2000` 只返回空列表（不是 403）——这是三个接口里唯一一个能放心全量爬的。
2. **`pageSize` 上限 100**：传 200+ 报 400 `pageSize 超出范围（1~100）`；`page` 必须 ≥1（`page=0` 报 400）。
3. **官方参数表之外还有 3 个真过滤参数**：`keyword`（模糊搜索，支持中文）、`category`（分类精确过滤，大小写/空格不敏感）、`source`（来源过滤）。`search`/`q`/`name` 等**全是摆设**（传了 total 不变）。
4. **平台原生双语**：每条自带 `description_zh` 中文描述 + `subCategories` 中文子类名（如「信息检索」「摘要总结」），对接中文产品零翻译成本。
5. **排序真实生效**：`sortBy` 支持 `updated_at/downloads/stars/installs/score` 五档（非法值直接 400 并把合法列表回显给你），`order=desc|asc` 也真实生效。

---

## 一、接口概览

| 项 | 值 |
| :--- | :--- |
| 协议 | HTTPS |
| 路径 | `https://api.skillhub.cn/api/skills` |
| 方法 | `GET` |
| 鉴权 | 无（公开接口） |
| 请求格式 | Query String |
| 响应格式 | `application/json` |
| 数据规模 | `total=114986`（约 11.5 万条） |

---

## 二、请求参数（Query）· 官方 + 隐藏参数全表

### 2.1 官方参数（文档列出的）

| 参数 | 类型 | 必填 | 描述 | 实测行为 |
| :--- | :--- | :---: | :--- | :--- |
| `page` | Integer | 否 | 页码(默认1) | 必须 ≥1；`0/-1/abc` → 400 `page 必须 >= 1` |
| `pageSize` | Integer | 否 | 每页条数(默认20) | **上限 100**；`0/-5/200+` → 400 `pageSize 超出范围（1~100）` |
| `sortBy` | String | 否 | 排序字段 | 支持 `updated_at/downloads/stars/installs/score`；非法值 → 400 且**回显合法列表** |
| `order` | String | 否 | `desc`/`asc` | 真实生效（同字段两方向序列不同） |

### 2.2 隐藏参数（官方未列，实测生效！）

| 参数 | 说明 | 实测 |
| :--- | :--- | :--- |
| `keyword` | **模糊搜索**（名称/描述等），支持中文 | `news`→1153，`excel`→1480，`地图`→1809；无命中 → `total=0`（真过滤，不掺假） |
| `category` | **分类精确过滤**（见第 5 节枚举） | `data-analysis`→8320；大小写/空格不敏感（`Data-Analysis`、` data-analysis` 同结果） |
| `source` | 来源过滤 | 仅 `clawhub` 有数据（63545）；`skillhub`/`github`/`official` → 0 |

### 2.3 组合过滤 = 交集 ✅

`category=data-analysis`(8320) + `source=clawhub`(63545) → **5123**；`category` + `keyword=bid` → 48。可放心叠加。

### 2.4 摆设参数（传了等于没传，total 恒 114986）

`search`、`q`、`name`、`categories`、`subCategory(s)/subcategory/sub_category`、`verified/isVerified`、`tag(s)`、`owner/ownerName`、`namespace`、`isServiceized`、`claimable`、`foo` —— **全部静默忽略**。

---

## 三、响应结构

- 信封：`{code, message, data: {skills, total}}`，`code=0` 表示成功。
- `data.total`：**真实总数**（114986），可用于分页计算（与 ModelScope 的假 total 完全不同）。
- 单条 Skill 共 27 字段，关键字段：

| 字段 | 说明 |
| :--- | :--- |
| `slug` / `name` | 唯一标识 / 展示名（如 `dev-expert` / `编程专家.Skill`） |
| `category` | 顶层分类 slug（12 类之一，见第 5 节） |
| `subCategories` | 子类数组 `[{key, name}]`，**name 为中文**（如 文档处理/表格处理） |
| `description_zh` | **原生中文描述** |
| `source` | 来源（`clawhub`/`enterprise`/`community` 等） |
| `score` / `downloads` / `stars` / `installs` | 综合评分 / 下载 / Star / 安装量 |
| `ownerName` / `namespace` | 作者名 / 命名空间（`@clawhub_joargp/xxx`） |
| `updated_at` / `created_at` / `last_synced_at` | 时间戳 |
| `upstream_url` / `homepage` / `iconUrl` | 源地址 / 主页 / 图标 |
| `verified` / `claimable` / `claim_state` | 认证与认领状态 |

```json
{"code": 0, "message": "success", "data": {"total": 114986, "skills": [{"slug": "news-summary", "name": "News Summary", "category": "knowledge-management", "subCategories": [{"key": "knowledge-retrieval", "name": "信息检索"}, {"key": "knowledge-summary", "name": "摘要总结"}], "description_zh": "当用户询问新闻更新…", "source": "clawhub", "score": 5602.9, "downloads": 63973, "stars": 140, "installs": 5466}]}}
```

---

## 四、错误码与异常处理（实测 body）

| HTTP | code | 触发条件 | 响应示例 |
| :--- | :--- | :--- | :--- |
| 200 | 0 | 成功 | `{"code":0,"message":"success","data":{...}}` |
| 400 | 400 | page<1 / 非整数 | `{"code":400,"message":"参数错误：page 必须 >= 1"}` |
| 400 | 400 | pageSize 越界 | `{"code":400,"message":"参数错误：pageSize 超出范围（1~100）"}` |
| 400 | 400 | sortBy 非法 | `{"code":400,"message":"参数错误：sortBy 不支持（updated_at/downloads/stars/installs/score）"}` |
| 400 | 400 | category 不存在 | `{"code":400,"message":"参数错误：…"}`（`total` 返回 `None`） |

> 错误信息是中文的，且 sortBy 报错时**直接回显合法枚举**——排查零成本。

---

## 五、分类枚举与中英文对照（12 类，计数精确）

> 来源：`filter.category` BFS 全量发现并收敛（12 类闭集），count 为**全库精确值**（过滤 total），非采样统计。
> 子分类中文名来自平台原生（`subCategories[].name`），非翻译。完整 JSON：`skillhub_categories.json`。

| # | category (slug) | 中文名 | 全库数量 | 典型子类（key · 中文名） |
| :--- | :--- | :--- | ---: | :--- |
| 1 | `ai-agent` | AI 智能体 | 17,515 | `agent-tool-use` 工具调用, `agent-task-automation` 任务自动化, `agent-workflow` 工作流编排, `agent-context` 上下文管理, `agent-memory` 记忆增强 |
| 2 | `business-ops` | 商业运营 | 15,462 | `biz-growth` 增长分析, `biz-project-management` 项目管理, `biz-ecommerce` 电商运营, `biz-sales` 销售助手, `biz-user-ops` 用户运营 |
| 3 | `content-creation` | 内容创作 | 8,412 | `content-article` 文章写作, `content-rewrite` 内容改写, `content-short-video-script` 短视频脚本, `content-marketing-copy` 营销文案, `content-social-media` 自媒体运营 |
| 4 | `data-analysis` | 数据分析 | 8,320 | `data-insight` 数据洞察, `data-web-scraping` 网页抓取, `data-report` 报表生成, `data-competitor` 竞品分析, `data-visualization` 数据可视化 |
| 5 | `design-media` | 设计与媒体 | 7,473 | `design-image-gen` 图片生成, `design-visual-asset` 视觉素材, `design-video` 视频处理, `design-audio` 音频处理, `design-image-edit` 图片编辑 |
| 6 | `dev-programming` | 开发编程 | 13,638 | `dev-code-gen` 代码生成, `dev-script` 脚本工具, `dev-code-review` 代码审查, `dev-frontend` 前端开发, `dev-git` Git 辅助 |
| 7 | `education` | 教育培训 | 4,256 | `edu-teaching-aid` 教学辅助, `edu-tutoring` 学习辅导, `edu-course-design` 课程设计, `edu-exam-prep` 考试备考, `edu-question-gen` 题目生成 |
| 8 | `it-ops-security` | IT 运维与安全 | 7,672 | `itops-server` 服务器运维, `itops-troubleshooting` 故障排查, `itops-security-scan` 安全扫描, `itops-config` 配置生成, `itops-monitoring` 监控告警 |
| 9 | `knowledge-management` | 知识管理 | 5,982 | `knowledge-retrieval` 信息检索, `knowledge-organize` 资料整理, `knowledge-summary` 摘要总结, `knowledge-base-qa` 知识库问答, `knowledge-notes` 笔记整理 |
| 10 | `life-service` | 生活服务 | 7,872 | `life-personal-plan` 个人计划, `life-travel` 旅行规划, `life-consumption` 消费决策, `life-health` 健康管理, `life-local` 本地生活 |
| 11 | `office-efficiency` | 办公效率 | 6,355 | `office-doc` 文档处理, `office-ppt` PPT 生成, `office-spreadsheet` 表格处理, `office-pdf` PDF 处理, `office-automation` 流程自动化 |
| 12 | `professional` | 专业领域 | 12,210 | `pro-legal` 法律合规, `pro-industry-research` 行业研究, `pro-finance` 金融分析, `pro-research` 科研学术, `pro-tax-accounting` 财税处理 |

---

## 六、排序 / 过滤 / 语言 · 实测结论

| 项 | 实测结论 |
| :--- | :--- |
| `sortBy` 五档 | ✅ 全部真实生效（两两比较序列均不同） |
| `order` | ✅ 真实生效（desc/asc 序列互逆） |
| `keyword` | ✅ 真过滤（支持中文，无命中 → total=0） |
| `category` | ✅ 真过滤（大小写/空格不敏感） |
| `source` | ✅ 真过滤（仅 clawhub 有数据） |
| `search`/`q`/`name` 等 | ❌ 摆设（total 恒 114986） |
| 组合过滤 | ✅ 交集（category+source / category+keyword 均精确） |

---

## 七、客户端架构建议

- **可全量爬**：无配额墙、无速率限制（实测 270+ 连续请求全 200，单请求 ~0.6s）→ 全量 1150 页可行。
- 本工程采样 250 页（前 25% 高分，24,990 条）建本地索引，HTML 内嵌 Top 6,000，CLI 离线可查全部 24,990 条。
- 生产建议：首次全量建索引 → 按 `updated_at` 增量同步（每天一次即可）。

---

## 八、调用示例

### 8.1 curl
```bash
# 基础列表（综合评分降序）
curl -s "https://api.skillhub.cn/api/skills?page=1&pageSize=100&sortBy=score&order=desc"

# 隐藏参数：关键字 + 分类 + 来源 组合过滤
curl -s "https://api.skillhub.cn/api/skills?keyword=地图&category=data-analysis&source=clawhub&pageSize=20"
```

### 8.2 Python
```python
import json, urllib.parse, urllib.request

def search(keyword=None, category=None, source=None, sort_by="score", order="desc", page=1, page_size=20):
    params = {"page": page, "pageSize": page_size, "sortBy": sort_by, "order": order}
    if keyword: params["keyword"] = keyword
    if category: params["category"] = category
    if source: params["source"] = source
    url = "https://api.skillhub.cn/api/skills?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        d = json.loads(r.read())
    if d["code"] != 0:
        raise RuntimeError(d["message"])
    return d["data"]["skills"], d["data"]["total"]
```

### 8.3 增强查询 CLI（交付物）
```bash
# 实时模式（真过滤参数齐活）
python query_skillhub.py --keyword 地图 --category data-analysis --sortBy score --order desc --page-size 20
# 离线模式（浏览 24,990 条采样，免请求）
python query_skillhub.py --offline --category ai-agent --sortBy downloads --page-size 10
```

---

## 九、交付物清单

| 文件 | 作用 |
| :--- | :--- |
| `probe_skillhub.py` / `probe_skillhub2.py` | 两轮边界/语义探测脚本 |
| `collect_skillhub.py` | BFS 分类枚举 + 采样爬取脚本 |
| `skillhub_categories_raw.json` | BFS 原始枚举（含子类中文名与计数） |
| `skillhub_categories.json` | 12 类枚举（中英对照 + 精确计数 + 子类） |
| `skillhub_index.jsonl` | 24,990 条采样索引 |
| `skillhub_compact.json` | Top 6,000 压缩数据集（浏览器内嵌） |
| `skillhub_explorer.html` | 自包含双语浏览器（分类/子类筛选/搜索/五档排序/分页） |
| `query_skillhub.py` | 增强查询 CLI（实时+离线双模式） |
| `skillhub对接说明文档.md` | 本文档 |

---

## 十、最佳实践 & 对接 Checklist

- [ ] `pageSize` 恒 ≤100；分页循环以 `data.total` 为总长，读到空列表即止
- [ ] 搜索用 `keyword`（真过滤，支持中文），别用 `search`/`q`（摆设）
- [ ] 分类过滤用 `category` + 第 5 节 slug；子类过滤客户端侧做（`subCategories[].key`）
- [ ] 排序用 `sortBy` 五档 + `order`，两者都真实生效
- [ ] 组合过滤放心叠加（交集语义已验证）
- [ ] 中文展示直接用 `description_zh` + `subCategories[].name`，零翻译
- [ ] 可全量爬：1150 页 / 每页 100，约 10~15 分钟；增量按 `updated_at` 同步
