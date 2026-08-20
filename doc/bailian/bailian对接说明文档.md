# 阿里云百炼 MCP 广场 · SquarePageList 接口 · 详细对接说明文档

> 版本：v1.0（2026-08-17）
> 接口：`POST https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.mcp-server.SquarePageList&_v=undefined`
> 文档性质：**实测对接手册**（全部结论经真实请求验证，含官方文档未写明的隐藏/摆设参数）

---

## 〇、对接前必读（结论先行）

1. **总库仅 251 条，无配额墙、无速率限制**：`pageSize=500` 一次可取回全部；深页越界只返回空列表，**从不 403**。`total` 真实可信，可直接用于分页。
2. **`serverName` 是真·模糊搜索**（跨 名称+描述 多字段，支持中文；无命中 → `total=0`）；空串等同于“全部”。
3. **`classification` 是真过滤**（8 个枚举 slug 精确匹配；非法值 → `total=0` 静默返回，**不报 400**）。
4. **`type` 与 `activated` 是摆设**（所有取值均返回 251，无差别）——`reqDTO` 里这俩字段可省略。
5. **`pageSize` 无强制上限**（实测 500 生效）；`pageNo` 为 1 基（0/溢出返回空列表，不报错）。
6. **分类枚举 8 类** + **来源枚举 9 个 source slug（→ 8 个中文 sourceName）**，详见第 5/6 节。

---

## 一、接口概览

| 项 | 值 |
| :--- | :--- |
| 协议 | HTTPS |
| 路径 | `https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.mcp-server.SquarePageList&_v=undefined` |
| 方法 | `POST` |
| 鉴权 | 会话 Cookie（阿里云控制台登录态；匿名/失效 Cookie 会 401/重定向到登录） |
| 请求格式 | `application/x-www-form-urlencoded`；正文 `params=<URL编码JSON>&region=cn-beijing` |
| 响应格式 | `application/json` |
| 数据规模 | 全库 `total=251`（可一次全量拉取） |

### 1.1 请求体结构（params 内 JSON）

```json
{
  "Api": "zeldaEasy.broadscope-bailian.mcp-server.SquarePageList",
  "V": "1.0",
  "Data": {
    "reqDTO": { "type":"OFFICIAL", "displayTools":false, "activated":2,
                "pageNo":1, "pageSize":20, "classification":"ALL", "serverName":"" },
    "cornerstoneParam": { "protocol":"V2", "console":"ONE_CONSOLE", "productCode":"p_efm",
                          "switchUserType":3, "domain":"bailian.console.aliyun.com",
                          "consoleSite":"BAILIAN_ALIYUN", "xsp_lang":"zh-CN",
                          "X-Anonymous-Id":"<匿名ID>" }
  }
}
```
表单字段：`params=<上述 JSON 的 URL 编码>` 与 `region=cn-beijing` 并列。

---

## 二、请求参数（reqDTO）· 全表 + 实测

| 参数 | 类型 | 必填 | 说明 / 实测 |
| :--- | :--- | :---: | :--- |
| `pageNo` | Integer | 否 | 页码，**1 基**；`0`/越界 → 返回空列表（不报错） |
| `pageSize` | Integer | 否 | 每页条数，**无强制上限**（实测 500 一次取回全部 251） |
| `serverName` | String | 否 | **模糊搜索**（名称+描述多字段，支持中文）；无命中 → `total=0`；空串＝全部 |
| `classification` | String | 否 | **精确过滤**，取 8 个枚举 slug 之一或 `ALL`；非法值 → `total=0`（静默） |
| `type` | String | 否 | ❌ **摆设**（OFFICIAL/ALL/CUSTOM/THIRD_PARTY 全部返回 251） |
| `activated` | Integer | 否 | ❌ **摆设**（0/1/2 全部返回 251） |
| `displayTools` | Boolean | 否 | ❌ **摆设**（true/false 结果一致） |

---

## 三、响应结构

- **信封**：`{code, data:{DataV2:{ret, data:{data:{total, pageNo, pageSize, mcpServerDetailList:[]}}}, success, errorCode, api, errorMsg}}, httpStatusCode, requestId, successResponse}`
- **列表路径**：`data.DataV2.data.data.mcpServerDetailList`
- **总数路径**：`data.DataV2.data.data.total`（真实可信）
- 单条 Server 关键字段（共 21 个）：

| 字段 | 说明 |
| :--- | :--- |
| `serverCode` | 唯一标识（如 `market-cmgjmcp00074947` / `kuaidi100-mcp`） |
| `serverName` | 展示名（多为中文，如 `快递100`） |
| `bizType` | 中文业务类型（如 `AI应用`/`企业服务`，56 种，仅展示用） |
| `classification` | 分类 slug（8 类之一，可能 `null`→未分类） |
| `source` / `sourceName` | 来源 slug / 中文来源（如 `PARTNER`/`三方伙伴`） |
| `description` | 描述（含换行，已清洗） |
| `callTotalCount` | **累计调用次数**（排序主指标，max≈7.97M） |
| `activateUserCount` | 激活用户数（max=47,077） |
| `icon` | 图标 URL |
| `installType` / `deployType` / `deployMode` | 恒为 `NPX` / `PRIVATE` / `DYNAMIC`（无区分度，仅展示） |
| `deployEnv` | `REMOTE`(186) / `FC`(65) |
| `streamable` / `hasFee` / `hasFreePlan` / `hasLogin` | 布尔开关（实测全为 false） |

```json
{"code":"200","data":{"DataV2":{"data":{"data":{"total":7,"pageNo":1,"pageSize":20,
"mcpServerDetailList":[{"serverName":"快递100","classification":"LIFE_SERVICE","source":"PARTNER",
"sourceName":"三方伙伴","callTotalCount":867,"activateUserCount":74,"icon":"https://...","deployEnv":"REMOTE"}]}}}},
"successResponse":true,"requestId":"b79ba8d8-..."}
```

---

## 四、错误码与异常处理

| HTTP | code | 触发条件 | 响应 / 应对 |
| :--- | :--- | :--- | :--- |
| 200 | 200 | 成功 | `successResponse:true`，列表在 `data.DataV2.data.data` |
| 200 | 200 | `classification` 非法 | `total=0`、空列表（**静默**，无错误码） |
| 200 | 200 | `serverName` 无命中 | `total=0`、空列表 |
| 401 / 302 | — | Cookie 失效/匿名 | 重定向到登录页；需有效控制台会话 Cookie |

> 与 REST 不同：本接口**不过载错误码**——非法 `classification` 与正常“无结果”表现完全一致（`total=0`），因此客户端必须**自行约束枚举取值**，不能依赖报错回显。

---

## 五、分类枚举（8 类 · 中英文对照 · 计数精确）

> 来源：全量 251 条统计（非 BFS，因 `classification` 非法值静默返回 0 无法回显枚举）。count 为各分类精确条数。完整 JSON：`bailian_categories.json`。

| # | classification (slug) | 中文名 | 数量 |
| :--- | :--- | :--- | ---: |
| 1 | `CORPORATE_SERVICE` | 企业服务 | 80 |
| 2 | `LIFE_SERVICE` | 生活服务 | 53 |
| 3 | `DATA_SEARCH` | 数据搜索 | 37 |
| 4 | `DEVELOPER_TOOL` | 开发者工具 | 26 |
| 5 | `CONTENT_GENERATION` | 内容生成 | 24 |
| 6 | `CLOUD_NATIVE` | 云原生 | 18 |
| 7 | `SEARCH_TOOL` | 搜索工具 | 12 |
| 8 | `UNCLASSIFIED` | 未分类（classification=null） | 1 |

---

## 六、来源枚举（source 9 slug → 8 中文 sourceName）

> `source`（英文 slug）与 `sourceName`（中文）非 1:1：`ONEKEY` 与 `ALIYUN_MARKET` 的 sourceName 同为“云市场”。过滤建议用 `source` slug。

| # | source (slug) | 中文 sourceName | 数量 |
| :--- | :--- | :--- | ---: |
| 1 | `ALIYUN_MARKET` | 云市场 | 77 |
| 2 | `PARTNER` | 三方伙伴 | 60 |
| 3 | `ONEKEY` | 云市场 | 53 |
| 4 | `ALIYUN` | 阿里云 | 21 |
| 5 | `OPEN_SOURCE_COMMUNITY` | 开源社区 | 16 |
| 6 | `TONGYI` | 通义 | 14 |
| 7 | `ANT` | 蚂蚁 | 7 |
| 8 | `DINGTALK` | 钉钉 | 2 |
| 9 | `AMAP` | 高德 | 1 |

---

## 七、过滤 / 排序行为实测

| 参数 | 实测结论 |
| :--- | :--- |
| `serverName / 关键词` | ✅ 生效（模糊搜索，跨 名称+描述 多字段；支持中文；无命中 → total=0） |
| `classification` | ✅ 生效（精确匹配 8 个枚举 slug；非法值 → total=0 静默返回，不报 400） |
| `type` | ❌ 摆设（OFFICIAL/ALL/CUSTOM/THIRD_PARTY 全部返回 251，无差别） |
| `activated` | ❌ 摆设（0/1/2 全部返回 251，无差别） |
| `displayTools` | ❌ 摆设（true/false 结果一致） |
| `空串 serverName` | ＝全部（等同不传，不是“匹配空”） |
| `total` | ✅ 真实可信（全量 251，过滤后随结果变化） |
| 组合过滤 | ✅ `classification` + `serverName` 为交集（classification 收窄范围，serverName 在范围内模糊搜） |
| 排序 | ⚠️ **服务端无排序参数**——返回顺序固定（按热度/上架），需客户端侧按 `callTotalCount`/`activateUserCount` 排序 |

---

## 八、客户端架构建议

- **实时模式**：组装 `params` JSON → `application/x-www-form-urlencoded` POST → 解析 `data.DataV2.data.data`。需有效控制台 Cookie（建议服务端代理持有，避免前端暴露会话）。
- **离线索引模式**：全库仅 251 条，`index.jsonl` 即可做全量客户端搜索/分类/来源/排序/分页，免 Cookie、免配额——**推荐默认走此模式**。
- **排序**：服务端不支持排序，浏览器按 `callTotalCount`（调用次数）或 `activateUserCount`（激活用户）降序。
- **枚举约束**：调用 `classification` 前用第 5 节 8 个 slug 白名单校验；非法值只会静默返回空，不会报错。

---

## 九、调用示例

### 9.1 curl（复刻原始请求）
```bash
# 1) 准备 params JSON（写入文件，避免转义）
cat > /tmp/params.json <<'EOF'
{"Api":"zeldaEasy.broadscope-bailian.mcp-server.SquarePageList","V":"1.0","Data":{"reqDTO":{"type":"OFFICIAL","displayTools":false,"activated":2,"pageNo":1,"pageSize":20,"classification":"ALL","serverName":"快递"},"cornerstoneParam":{"protocol":"V2","console":"ONE_CONSOLE","productCode":"p_efm","switchUserType":3,"domain":"bailian.console.aliyun.com","consoleSite":"BAILIAN_ALIYUN","xsp_lang":"zh-CN","X-Anonymous-Id":"anon"}}}
EOF
# 2) URL 编码后 POST
curl "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.mcp-server.SquarePageList&_v=undefined" \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Cookie: <控制台登录会话 Cookie>" \
  --data-raw "params=$(python -c 'import urllib.parse;print(urllib.parse.quote(open("/tmp/params.json").read()))')&region=cn-beijing"
```

### 9.2 Python
```python
import json, urllib.parse, urllib.request

def list_servers(server_name="", classification="ALL", page_no=1, page_size=500, cookie=""):
    params = {"Api":"zeldaEasy.broadscope-bailian.mcp-server.SquarePageList","V":"1.0",
        "Data":{"reqDTO":{"type":"OFFICIAL","displayTools":False,"activated":2,
            "pageNo":page_no,"pageSize":page_size,"classification":classification,
            "serverName":server_name},
            "cornerstoneParam":{"protocol":"V2","console":"ONE_CONSOLE","productCode":"p_efm",
                "switchUserType":3,"domain":"bailian.console.aliyun.com",
                "consoleSite":"BAILIAN_ALIYUN","xsp_lang":"zh-CN","X-Anonymous-Id":"anon"}}}
    body = "params=" + urllib.parse.quote(json.dumps(params)) + "&region=cn-beijing"
    req = urllib.request.Request(
        "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.mcp-server.SquarePageList&_v=undefined",
        data=body.encode(), headers={"Content-Type":"application/x-www-form-urlencoded","Cookie":cookie}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    blk = d["data"]["DataV2"]["data"]["data"]
    return blk["mcpServerDetailList"], blk["total"]

# 全量拉取（一次 251 条）
items, total = list_servers()
print("total:", total, "返回:", len(items))
```

---

## 十、交付物清单

| 文件 | 作用 |
| :--- | :--- |
| `bailian_api.py` | 接口封装（含 Cookie，可复现请求） |
| `probe_bailian_steps.py` | 边界/语义/枚举探测脚本 |
| `collect_bailian.py` | 全量采集 + 索引 + 枚举统计 |
| `index.jsonl` | 251 条本地索引（一行一条原始记录） |
| `bailian_categories.json` | 8 类分类枚举（中英对照 + 计数） |
| `bailian_compact.json` | 压缩数据集（浏览器内嵌） |
| `bailian_explorer.html` | 自包含双语浏览器（搜索/分类/来源/排序/分页） |
| `bailian对接说明文档.md` | 本文档 |

---

## 十一、最佳实践 & 对接 Checklist

- [ ] 用 `POST` + `application/x-www-form-urlencoded`，正文 `params=<URL编码JSON>&region=cn-beijing`
- [ ] 解析路径固定 `data.DataV2.data.data.{mcpServerDetailList,total}`
- [ ] 搜索用 `serverName`（真模糊搜索，支持中文）；别指望 `type`/`activated`（摆设）
- [ ] 分类过滤用 `classification` + 第 5 节 8 个 slug 白名单；非法值**静默返回空**，自行校验
- [ ] `pageSize` 直接取 500 一次全量；无需翻页循环（无配额墙）
- [ ] 排序客户端做：按 `callTotalCount` 或 `activateUserCount` 降序
- [ ] 来源过滤用 `source` slug（非 sourceName）
- [ ] Cookie 失效会 401/跳登录；生产环境由服务端代理持有会话
- [ ] 默认走离线索引模式（251 条），实时模式仅用于增量/搜索
