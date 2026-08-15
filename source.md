# Modelscope技能列表查询接口文档

## 1. 接口概述
* **接口名称**：获取技能列表 (Get Skills List)
* **接口描述**：分页获取平台上的技能（Skills）列表，支持按名称进行关键字搜索与过滤。
* **请求路径**：`/openapi/v1/skills`
* **完整URL**：`https://www.modelscope.cn/openapi/v1/skills`
* **请求方式**：`GET`

---

## 2. 请求参数 (Query)

| 参数名 | 类型 | 必填 | 默认值 | 描述说明 | 示例 |
| :--- | :--- | :---: | :--- | :--- | :--- |
| `name` | String | 否 | `""` | 技能名称或关键字，用于模糊搜索过滤 | `skill-creator` |
| `page_number` | Integer | 否 | `1` | 当前请求的页码 | `1` |
| `page_size`| Integer | 否 | `20` | 每页返回的数据条数 | `20` |

---

## 3. 响应参数 (Response)

### 3.1 基础响应结构

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `success` | Boolean | 请求是否成功（`true` / `false`） |
| `request_id`| String | 唯一请求追踪ID（UUID格式），用于问题排查 |
| `data` | Object | 返回的业务数据主体 |

### 3.2 `data` 数据主体

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `skills` | Array\<Skill\>| 技能列表数组（结构详见 3.3） |
| `total` | Integer | 符合条件的技能总条数 |
| `page_number` | Integer | 当前返回的页码 |
| `page_size` | Integer | 当前每页返回的条数 |

### 3.3 `skills` 技能对象字段说明

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `_id` | String | 系统内部唯一标识符（Base64编码） |
| `id` | String | 技能全局唯一标识符（如 `@anthropics/skill-creator`） |
| `display_name`| String | 技能展示名称 |
| `description` | String | 技能默认语言的描述信息 |
| `owner` | String | 技能所有者/所属组织（可为空） |
| `license` | String | 开源许可证协议（如 `Apache-2.0`，可为空） |
| `developer` | String | 开发者名称 |
| `source_url` | String | 源代码仓库地址（如 GitHub 链接，可为空） |
| `category` | String | 技能主分类标识（如 `skill-management`, `developer-tools`） |
| `tags` | Array\<String\>| 系统标签列表（如 `category:skill-management`） |
| `logo_url` | String | 技能图标/封面图片的 URL（可为空） |
| `view_count` | Integer | 浏览量/阅读量 |
| `downloads` | Integer | 下载量/安装量 |
| `locales` | Object | 多语言国际化配置对象（详见下方） |
| `private` | Boolean | 是否为私有技能 |
| `custom_tag` | Array\<String\>/Null| 用户自定义标签列表 |
| `last_modified`| String | 技能元数据最后修改时间（ISO 8601格式） |
| `file_last_modified`| String| 技能配置文件最后修改时间（ISO 8601格式） |

### 3.4 `locales` 多语言对象说明
包含不同语言的描述和分类映射，目前主要支持 `en` (英文) 和 `zh` (中文)。

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `en` | Object | 英文配置节点 |
| └─ `description` | String | 英文描述 |
| └─ `category` | String | 英文分类名称 |
| `zh` | Object | 中文配置节点 |
| └─ `description` | String | 中文描述 |
| └─ `category` | String | 中文分类名称 |

---

## 4. 请求与响应示例

### 4.1 请求示例
```http
GET /openapi/v1/skills?name=&page=1&page_size=20 HTTP/1.1
Host: www.modelscope.cn
```

### 4.2 响应示例
```json
{
  "success": true,
  "request_id": "75d7aa36-c9e5-4605-9db2-d515aad76670",
  "data": {
    "skills": [
      {
        "_id": "FVA80usrezHtdfEq7GEFxA==",
        "id": "@anthropics/skill-creator",
        "display_name": "skill-creator",
        "description": "创建新技能，修改和改进现有技能，并衡量技能表现。当用户希望从零开始创建一个技能、更新或优化现有技能、运行评估以测试技能、通过方差分析来基准化技能表现，或者优化技能描述以提高触发准确性时使用。",
        "owner": "",
        "license": "",
        "developer": "anthropics",
        "source_url": "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator/skills/skill-creator",
        "category": "skill-management",
        "tags": [
          "category:skill-management",
          "developer:anthropics",
          "custom_tag:skill-creation",
          "custom_tag:skill-discovery"
        ],
        "logo_url": "https://resources.modelscope.cn/skill-cover/0df6ab15-9f62-43f2-811c-4bcb7ab0525f.png",
        "view_count": 48882,
        "downloads": 12671,
        "locales": {
          "en": {
            "description": "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, update or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.",
            "category": "Skills"
          },
          "zh": {
            "description": "创建新技能，修改和改进现有技能，并衡量技能表现。当用户希望从零开始创建一个技能、更新或优化现有技能、运行评估以测试技能、通过方差分析来基准化技能表现，或者优化技能描述以提高触发准确性时使用。",
            "category": "Skills管理"
          }
        },
        "private": false,
        "custom_tag": [
          "skill-creation",
          "skill-discovery"
        ],
        "last_modified": "2026-08-07T06:37:46Z",
        "file_last_modified": "2026-06-23T17:59:54Z"
      }
    ],
    "total": 76649,
    "page_number": 1,
    "page_size": 20
  }
}
```


# ModelScope MCP 广场 API：获取 MCP 服务列表

## 1. 接口概述
本接口用于分页查询和搜索 ModelScope MCP 广场中的 MCP Server（MCP 服务）列表，支持关键字检索及多维度过滤。适用于开发者在自己的应用中构建 MCP 服务发现、展示或集成页面。

## 2. 请求说明

### 2.1 基础信息
- **接口地址 (Endpoint)**: `https://www.modelscope.cn/openapi/v1/mcp/servers`
- **请求方法 (Method)**: `PUT`
- **数据格式 (Content-Type)**: `application/json`

### 2.2 请求头 (Headers)
| 参数名 | 必填 | 类型 | 描述 | 示例值 |
| :--- | :---: | :--- | :--- | :--- |
| `Authorization` | 是 | String | 访问令牌认证。需携带 `Bearer` 前缀 | `Bearer ms-xxxxxxxxxxxxx` |
| `Content-Type` | 是 | String | 请求体数据类型 | `application/json` |

### 2.3 请求参数 (Body)
| 参数名 | 必填 | 类型 | 描述 | 示例值 |
| :--- | :---: | :--- | :--- | :--- |
| `page_number` | 否 | Integer | 当前页码，默认为 `1` | `1` |
| `page_size` | 否 | Integer | 每页返回数量。建议范围 `1-100`，默认 `20` | `30` |
| `search` | 否 | String | 搜索关键字（支持服务名、中文别名、发布者名等），空字符串表示不限制搜索 | `"地图"` |
| `filter` | 否 | Object | **高级过滤条件对象**（注：结合SDK底层补充） | `{"category": "search"}` |
| ↳ `filter.category` | 否 | String | 按服务分类精确过滤（见附录分类字典） | `"search"` |
| ↳ `filter.tag` | 否 | String | 按服务标签过滤 | `"PPT"` |
| ↳ `filter.is_hosted`| 否 | Boolean | 是否仅查询魔搭官方托管的服务 | `true` |

**请求体 JSON 示例：**
```json
{
  "page_size": 30,
  "page_number": 1,
  "search": "",
  "filter": {
    "category": "search"
  }
}
```

---

## 3. 响应说明

### 3.1 响应参数说明
响应数据为标准的 JSON 格式，包含状态标识、追踪 ID 及核心业务数据。

#### 根节点参数
| 参数名 | 类型 | 描述 |
| :--- | :--- | :--- |
| `success` | Boolean | 请求是否成功 (`true` / `false`) |
| `request_id` | String | 请求的唯一追踪 ID (Trace ID)，用于排查问题时提供给官方 |
| `data` | Object | 核心业务数据对象 |

#### `data` 对象参数
| 参数名 | 类型 | 描述 |
| :--- | :--- | :--- |
| `total_count` | Integer | 符合当前查询/过滤条件的 MCP 服务**总数** |
| `mcp_server_list`| Array | MCP 服务对象列表 |

#### `mcp_server_list` 数组项参数 (MCP Server Object)
| 参数名 | 类型 | 描述 |
| :--- | :--- | :--- |
| `id` | String | 服务的**唯一标识** (格式通常为 `@publisher/server_name` 或 `username/server_name`) |
| `publisher` | String | 发布者/作者标识 |
| `name` | String | 服务主名称（通常为英文或拼音标识） |
| `chinese_name` | String | 服务中文名称（若为空则与 `name` 相同） |
| `description` | String | 服务默认/主描述信息 |
| `tags` | Array[String]| 服务标签列表 (如: `"PPT"`, `"企业信息"`) |
| `logo_url` | String | 服务 Logo 图片的 CDN 链接 |
| `view_count` | Integer | 服务的浏览量/热度统计 |
| `locales` | Object | **多语言国际化配置**，包含不同语言环境下的展示信息 |
| `categories` | Array[String]| 服务所属分类列表（支持多分类，见附录字典） |

#### `locales` 对象参数
包含不同语言环境（如 `zh`、`en`）下的展示信息，客户端可根据当前语言环境读取对应字段。
| 子参数名 | 类型 | 描述 |
| :--- | :--- | :--- |
| `name` | String | 该语言下的服务名称 |
| `description` | String | 该语言下的服务描述 |

---

## 4. 请求与响应示例

### 4.1 cURL 请求示例
```bash
curl -X PUT \
  -H 'Authorization: Bearer ms-xxxxxxxx' \
  -H "Content-Type: application/json" \
  -d '{
    "page_size": 30,
    "page_number": 1,
    "search": ""
  }' \
  --url "https://www.modelscope.cn/openapi/v1/mcp/servers"
```

### 4.2 JSON 响应示例
```json
{
  "success": true,
  "request_id": "527bf034-0e0c-4756-8a7a-6d2fa0803072",
  "data": {
    "total_count": 9888,
    "mcp_server_list": [
      {
        "id": "@modelcontextprotocol/fetch",
        "publisher": "@modelcontextprotocol/fetch",
        "name": "Fetch网页内容抓取",
        "chinese_name": "Fetch网页内容抓取",
        "description": "该服务器使大型语言模型能够检索和处理网页内容，将HTML转换为markdown格式...",
        "tags": [],
        "logo_url": "https://resources.modelscope.cn/studio-cover-pre/studio-cover_761f7bfe...",
        "view_count": 574718,
        "locales": {
          "zh": {
            "name": "Fetch网页内容抓取",
            "description": "该服务器使大型语言模型能够检索和处理网页内容..."
          },
          "en": {
            "name": "fetch",
            "description": "This server enables LLMs to retrieve and process content from web pages..."
          }
        },
        "categories": [
          "browser-automation"
        ]
      },
      {
        "id": "@amap/amap-maps",
        "publisher": "@amap/amap-maps",
        "name": "高德地图",
        "chinese_name": "高德地图",
        "description": "高德地图是一个支持任何MCP协议客户端的服务器...",
        "tags": [],
        "logo_url": "https://resources.modelscope.cn/studio-cover-pre/studio-cover_982efeea...",
        "view_count": 389017,
        "locales": {
          "zh": { "name": "高德地图", "description": "..." },
          "en": { "name": "amap-maps", "description": "Amap Maps is a server..." }
        },
        "categories": [
          "location-services"
        ]
      }
    ]
  }
}
```

---

## 5. 附录：常见分类 (Categories) 字典
根据广场实际数据整理的 `categories` 分类枚举值，供前端筛选或后端 `filter.category` 传参使用：

| 分类标识 (Category ID) | 中文含义 | 代表服务示例 |
| :--- | :--- | :--- |
| `browser-automation` | 浏览器自动化 | Fetch网页抓取, Chrome开发者工具 |
| `search` | 搜索服务 | 必应搜索, 智谱联网搜索, Jina AI |
| `location-services` | 位置/地图服务 | 高德地图, 百度地图, 酒店查询 |
| `developer-tools` | 开发者工具 | 图表生成, 模型选型, 记忆系统 |
| `finance` | 金融/商业 | 天眼查, 银联支付, 支付宝订阅 |
| `knowledge-and-memory`| 知识与记忆 | 微信读书, OpenMemory, DeepWiki |
| `travel-and-transportation`| 出行交通 | 12306查票, 飞常准 |
| `communication` | 沟通协作 | 钉钉 MCP |
| `entertainment-and-media`| 娱乐媒体 | 抖音小助手, 八字MCP |
| `aigc` / `AIGC` | 生成式AI | 图像生成, 歌者PPT |
| `calendar-management` | 日历与时间管理 | 麦当劳, 飞常准 |

# 技能列表查询接口文档 (SkillHub Skills)

## 1. 接口概述
* **接口名称**：获取技能列表/排行榜 (Get SkillHub Skills)
* **接口描述**：分页获取 SkillHub 平台上的技能（Skills）列表，支持按综合评分（score）等字段排序，常用于技能市场首页、排行榜与分类浏览。
* **请求路径**：`/api/skills`
* **完整URL**：`https://api.skillhub.cn/api/skills`
* **请求方式**：`GET`

---

## 2. 请求参数 (Query)

| 参数名 | 类型 | 必填 | 描述说明 | 示例 |
| :--- | :--- | :---: | :--- | :--- |
| `page` | Integer | 否 | 当前请求的页码（从 1 开始） | `1` |
| `pageSize` | Integer | 否 | 每页返回的数据条数 | `20` |
| `sortBy` | String | 否 | 排序字段（如 `score` 综合评分） | `score` |
| `order` | String | 否 | 排序方向：`desc` 降序 / `asc` 升序 | `desc` |

---

## 3. 响应参数 (Response)

### 3.1 基础响应结构

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `code` | Integer | 业务状态码（`0` 表示成功） |
| `message` | String | 状态描述信息（如 `"success"`） |
| `data` | Object | 返回的业务数据主体 |

### 3.2 `data` 数据主体

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `skills` | Array\<Skill\> | 技能列表数组（结构详见 3.3） |
| `total` | Integer | 符合查询条件的技能总条数 |

### 3.3 `Skill` 技能对象字段说明

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `name` | String | 技能展示名称（如 `腾讯文档 TENCENT DOCS`） |
| `slug` | String | 技能 URL 标识符（如 `tencent-docs`） |
| `description` | String | 技能描述（原始/英文） |
| `description_zh` | String | 技能中文描述 |
| `category` | String | 主分类标识（如 `knowledge-management`, `office-efficiency`, `content-creation`, `ai-agent`, `dev-programming`, `data-analysis`, `design-media`, `professional`） |
| `subCategories` | Array\<Object\> | 子分类列表（详见 3.6） |
| `score` | Double | 综合评分（用于排行榜排序） |
| `downloads` | Integer | 累计下载量 |
| `installs` | Integer | 累计安装量 |
| `stars` | Integer | 收藏/Star 数 |
| `version` | String | 当前版本号（如 `1.0.2`） |
| `source` | String | 来源类型：`community`（社区）/ `enterprise`（企业） |
| `verified` | Boolean | 技能是否通过官方认证 |
| `ownerName` | String | 所有者用户名 |
| `namespace` | Object | 命名空间信息（详见 3.4） |
| `publisher` | Object | 发布方/企业信息（仅企业来源存在，详见 3.5） |
| `homepage` | String | 技能主页/详情页 URL |
| `iconUrl` | String | 技能图标 URL |
| `labels` | Object | 属性标签，如 `requires_api_key`（`"true"`/`"false"`，是否需要 API Key） |
| `tags` | Array/Null | 自定义标签列表 |
| `claim_state` | String | 认领状态（如 `unclaimed` 未认领） |
| `claimable` | Boolean | 是否可被认领 |
| `claimed_user_handle` | String/Null | 认领该技能的用户 Handle |
| `isServiceized` | Boolean | 是否已服务化（SaaS 化托管） |
| `created_at` | Long | 创建时间（毫秒级时间戳） |
| `updated_at` | Long | 最后更新时间（毫秒级时间戳） |
| `last_synced_at` | Long/Null | 最后同步时间 |
| `upstream_owner_login` | String/Null | 上游源码仓库所有者 |
| `upstream_url` | String/Null | 上游源码仓库 URL |

### 3.4 `namespace` 命名空间对象说明

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `canonicalName` | String | 规范全名（如 `@tencent-adm/ima-skills`） |
| `displayName` | String | 展示名称（如 `tencent-adm`） |
| `handle` | String | 用户/组织 Handle |
| `publicSlug` | String | 公开 Slug 标识 |

### 3.5 `publisher` 发布方对象说明 *(可选，企业来源时返回)*

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `name` | String | 发布方名称（如 `腾讯文档团队`, `QQ邮箱`） |
| `logoUrl` | String/Null | 发布方 Logo URL |
| `verified` | Boolean | 是否通过企业认证 |
| `certifiedName` | String | 认证主体名称（公司全称，如 `腾讯科技（深圳）有限公司`） |
| `orgId` | String | 组织 ID（如 `org-bv6b8qcb`） |

### 3.6 `subCategories` 子分类对象说明

| 参数名 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `key` | String | 子分类标识（如 `office-doc`, `knowledge-retrieval`） |
| `name` | String | 子分类中文名称（如 `文档处理`, `信息检索`） |

---

## 4. 请求与响应示例

### 4.1 请求示例
```http
GET /api/skills?page=1&pageSize=20&sortBy=score&order=desc HTTP/1.1
Host: api.skillhub.cn
```

### 4.2 响应示例 (精简版)
```json
{
  "code": 0,
  "data": {
    "skills": [
      {
        "category": "knowledge-management",
        "claim_state": "unclaimed",
        "claimable": false,
        "claimed_user_handle": null,
        "created_at": 1774842724122,
        "description": "",
        "description_zh": "MANDATORY before calling web_search, web_fetch, browser, or opencli. Contains required error-handling procedures...",
        "downloads": 206435,
        "homepage": "https://api.skillhub.cn/user_ec205dbb/web-tools-guide",
        "iconUrl": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/7422abc7-fa86-4505-a723-0575c56e7a2d.png",
        "installs": 3459,
        "isServiceized": false,
        "labels": { "requires_api_key": "false" },
        "last_synced_at": null,
        "name": "web-tools-guide",
        "namespace": {
          "canonicalName": "@user_ec205dbb/web-tools-guide",
          "displayName": "user_ec205dbb",
          "handle": "user_ec205dbb",
          "publicSlug": "web-tools-guide"
        },
        "ownerName": "user_ec205dbb",
        "score": 100000,
        "slug": "web-tools-guide",
        "source": "community",
        "stars": 189,
        "subCategories": [
          { "key": "knowledge-retrieval", "name": "信息检索" }
        ],
        "tags": null,
        "updated_at": 1786180485951,
        "upstream_owner_login": null,
        "upstream_url": null,
        "verified": false,
        "version": "1.0.2"
      },
      {
        "category": "knowledge-management",
        "claim_state": "unclaimed",
        "claimable": false,
        "created_at": 1773798184610,
        "description_zh": "ima skills，支持对笔记、知识库的读取、写入和检索等操作...",
        "downloads": 198421,
        "homepage": "https://api.skillhub.cn/tencent-adm/ima-skills",
        "iconUrl": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a78375f1-773e-4817-b4f3-0557b6afd777.png",
        "installs": 11831,
        "isServiceized": false,
        "labels": { "requires_api_key": "true" },
        "name": "ima-skills",
        "namespace": {
          "canonicalName": "@tencent-adm/ima-skills",
          "displayName": "tencent-adm",
          "handle": "tencent-adm",
          "publicSlug": "ima-skills"
        },
        "ownerName": "u_1742680f",
        "publisher": {
          "name": "tencent-ima",
          "logoUrl": null,
          "verified": true,
          "certifiedName": "腾讯科技（深圳）有限公司",
          "orgId": "org-bv6b8qcb"
        },
        "score": 98651.85643269986,
        "slug": "ima-skills",
        "source": "enterprise",
        "stars": 448,
        "subCategories": [
          { "key": "knowledge-base-qa", "name": "知识库问答" },
          { "key": "knowledge-organize", "name": "资料整理" },
          { "key": "knowledge-notes", "name": "笔记整理" }
        ],
        "tags": null,
        "updated_at": 1786180542090,
        "verified": false,
        "version": "1.1.9"
      }
    ],
    "total": 109176
  },
  "message": "success"
}
```

---

## 5. 备注与差异说明
* **时间戳格式**：`created_at` / `updated_at` 均为 **13 位毫秒级** Unix 时间戳。
* **可选对象**：`publisher` 字段仅在 `source` 为 `enterprise`（企业来源）时返回；社区来源（`community`）的技能无此字段。
* **排序逻辑**：默认示例按 `score`（综合评分）降序排列，`score` 由平台根据下载量、安装量、Star 数等指标综合计算。
* **标签语义**：`labels.requires_api_key` 为字符串类型的布尔值（`"true"` / `"false"`），用于提示该技能运行时是否需要用户自备 API Key。
