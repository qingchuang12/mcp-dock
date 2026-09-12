# plan-8.0 · 商店全数据源查询与安装全量排查

> 版本：8.0（2026-09-10）· 前任：[archive/plan-7.1.md](archive/plan-7.1.md)（GitHub 枚举抗抖动 / zip 安装元数据 / zip 解压去外部进程）
>
> 触发：用户要求「对商店所有数据源查询安装都检查一下，能修复的问题尽量修复，不能修复的问题给出问题报告清单」。

## 背景与目标

### 目标

对商店**全部数据源**的**查询链**（列表 / 搜索 / 详情 / 分类 / 分页）与**安装链**（解析 → 下载 → 落盘 → 元数据）逐条实测排查：

1. **能修的修** —— 代码写错、映射错误、判定错配、缺通道登记等，本轮修复并补测。
2. **不能修的列清单** —— 上游限制（平台无公开接口 / 已下线 / 需付费鉴权 / 域名不可达）如实归档，附确证证据，绝不编造理由。

### 判定分级（本轮统一口径）

| 分级 | 含义 | 处置 |
|---|---|---|
| **可修复缺陷** | 代码侧写错或漏判，改代码即可解决 | 本轮修复 + 补回归测试 |
| **上游限制** | 平台侧没有公开接口、需鉴权、接口已下线、域名不可达 | 如实归档到问题清单，UI 需给出准确原因（不得误报为「平台不支持」或「网络问题」） |
| **非缺陷** | 实测确认链路正常 | 记录证据，不改 |

> 口径要求与前序轮次一致：**失败与「空」必须区分**，错误归因不得张冠李戴（见 plan-7.1 D2/D3）。

## 数据源与链路矩阵

### Skill 源

| 源 | adapter / 实现 | 查询链 | 安装链 |
|---|---|---|---|
| GitHub Registry（内置 `src_github`） | `platform-constants.ts:90` | 主进程直连 | `parseImportUrl` → `github.ts` |
| ClawHub 榜单（内置 `src_clawhub`） | `platforms/clawhub.ts` + `resolvers/clawhub.ts` | `/api/v1/trending` 游标翻页 | zip 直链 `CLAWHUB_DOWNLOAD_BASE`（实测可用，**当前被禁用**） |
| ModelScope | `platforms/modelscope.ts` | `/openapi/v1/skills`（Skill 配额 **2400**，非 100） | `/skills/<o>/<s>/archive/zip/master`（实测可用，**当前未接线**） |
| 虾评 Coze | `platforms/coze.ts` | `/api/skills` 分页 | `fetchSkillDownload`（需 Bearer Key） |
| SkillHub | `platforms/skillhub.ts` + `resolvers/skillhub.ts` | **直连 `api.skillhub.cn/api/skills`**（实测 200；旧注释称走 `iflytek` 仓库，**已证伪**） | zip 直链 `SKILLHUB_DOWNLOAD_BASE`（实测 302→200 可用，**当前被禁用**） |
| SkillsMP | `platforms/skillsmp.ts` + `dispatch.ts:63-69/386-464` | `/api/skills?search=`（**基址 DNS 已死**）→ SSR 兜底（实测命中 0，救不回） | 复用其 `githubUrl` 仓库源 |
| SafeSkill | `registry.ts:24-25` **复用 skillhubAdapter** | ❌ 站点无公开列表接口（上游限制） | ❌ 无通道 |
| 百炼 Bailian | `platforms/bailian.ts` | 离线索引（251 条，2026-08-19） | ❌ 不可达（**死代码**） |
| skills.sh | `install-zip.ts:41-105` | 无列表（仅详情页解析） | 定位其 GitHub 源 → GitHub 通道 |

### MCP 源

| 源 | adapter | 查询链 | 安装链 |
|---|---|---|---|
| Smithery | `platforms/*` / `resolvers/servers.ts` | `/servers` | detail 的 `install` 命令 |
| npm Registry | `platforms/npm.ts` | `/-/v1/search?text=keywords:mcp` | detail 的 `install` 命令 |
| ModelScope MCP | `platforms/modelscope.ts` | MCP 分支接口 | detail 的 `install` 命令 |

### 共享层（所有源共用，缺陷影响面最大）

| 层 | 位置 | 关注点 |
|---|---|---|
| 分页 | `resolvers/pagination.ts` | `total` 为 null 时除零 / `NaN`；切片数与声明不符致空白页 |
| 分类排序 | `registry.ts:53-59` `getFacets` | adapter 声明的 `sortOptions` 是否被下游消费；有无「声明了却没人用」 |
| 搜索缓存 | `platforms/search-cache.ts` | **缓存键必须覆盖平台/关键词/页码/分类/排序/baseUrl/鉴权态**，漏维即「换词换分类仍返回旧结果」 |
| 已安装判定 | `StoreGrid.tsx` / `skillIdentity.ts` | Skill 侧上一轮修过命名空间错配（展示名 vs 物理目录名）；MCP 侧同源排查 |

## 排查方法

- **只读实测**：每条链路对上游发真实请求，记录 `URL / HTTP 状态 / content-type / 响应体前 300 字符 / 耗时`。
- **失败率取证**：`api.github.com` 本机已知约 33% 间歇失败，单次失败不下结论，多重试并给出失败率。
- **逐条落到 `文件:行号`**：结论必须可独立复核，不接受「看起来像」。
- **无法验证即标「未验证」**：卡点写清楚（无网络 / 需鉴权 / 接口不存在 / DNS 失败）。
- **不碰凭证**：虾评密钥已销毁，鉴权链路只验证匿名可达性，不读取任何本机密钥文件。

### 分工

| 工作流 | 范围 |
|---|---|
| W1 | GitHub Registry 内置源 / SkillsMP / skills.sh + `parseImportUrl`→`github.ts` 端到端 |
| W2 | ModelScope（Skill + MCP）/ 虾评 Coze + `PLATFORM_SKILL_DOWNLOAD` 登记不全疑点 |
| W3 | SkillHub / ClawHub / SafeSkill（含 SafeSkill 复用 SkillHub adapter 的错配疑点） |
| W4 | Smithery / npm / ModelScope MCP + 共享层（分页 / 分类 / 缓存 / MCP 已安装判定） |

## 实测结论矩阵

> 全部结论基于对上游接口的真实请求取证；关键项由我独立二次复核（见「复核」列）。

| 源 | 查询 | 安装 | 判定 | 主要问题 |
|---|---|---|---|---|
| GitHub Registry（内置） | ✅ | ✅ | 非缺陷 | 仅环境网络抖动；上轮 trees+重试修复经端到端复现有效 |
| ClawHub 榜单 | ✅ | ⚠️ 多数可用 | 上游限制 | 个别条目 409；`install.kind='github'` 当前数据中为 0（注释陈旧） |
| ModelScope Skill | ✅ | ❌ | **可修复缺陷** | **安装通道未登记**（D1/D2/D3）；配额常量张冠李戴（D4） |
| ModelScope MCP | ⚠️ 抖动 | ✅ | 上游限制 | 新建连接超时率 33–50%；适配器硬编码死包（D5，低触达） |
| 虾评 Coze | ✅ | ⚠️ 需 Key | 上游限制/凭证 | 代码路径正确；无有效 Bearer Key 即 401（实测） |
| SkillHub | ✅ | ✅ | 非缺陷 | 直连 API 可用；`dispatch.ts:139-140` 注释陈旧（D10） |
| SkillsMP | ❌ | ❌ | **可修复缺陷** | **基址 DNS 不可达**（D6）；忽略 `githubUrl`（D7） |
| SafeSkill | ❌ | ❌ | **上游限制 + 可修复缺陷** | 文档声明的 search 接口线上未部署；占位源映射错配（D8/D9） |
| 百炼 Bailian | ❌ 不可达 | N/A | **死代码（未接线）** | 适配器已写已注册，但连接配置层从未接线 → 运行时永不可达（D16） |
| skills.sh | N/A（仅详情） | ✅ | 非缺陷 | `HEAD` 作 ref 用法经实测有效 |
| Smithery（MCP） | ✅ | ✅ | 非缺陷 | 匿名可读；`@smithery/cli` 实测存在 |
| npm Registry（MCP） | ✅ | ✅ | 非缺陷 | 字段映射吻合；关键词编码正确 |
| 共享层 分页/分类/排序 | ✅ | — | 非缺陷 | 无除零/NaN；`sortOptions` 声明与消费一致 |
| 共享层 搜索缓存 | — | — | 可修复缺陷 | 缓存键缺鉴权态（D11）；磁盘无容量上限（D12） |

### 关键复核记录（我独立复测，非采信下游报告）

| 结论 | 复核方式 | 结果 |
|---|---|---|
| `api.skillsmp.com` 不可达 | DNS 解析对照 | `api.skillsmp.com` → **ENOTFOUND**；`skillsmp.com` → 104.26.x.x 正常 |
| SkillsMP 真实契约 | 直接请求 | `/api/skills?search=skill` → **200**，含 `githubUrl`（3/3 命中）；**不带 `search` 参数 200、带空 `search=` 才 400** |
| ModelScope 配额口径 | 边界实测 | Skill `page5×20`（product=100）→ **200 有数据**（代码却用它预判拒绝）；Skill `page120×20`（2400）→ 200；MCP `page_size=101` → **403 QuotaLimitExceed（上限 100）** |
| 网络抖动归属 | 同刻对照 | ModelScope MCP 空搜索 **4/8 失败**、Skill **1/3 失败**（`UND_ERR_CONNECT_TIMEOUT` ~10s）；同刻 `api.github.com` **0/8 失败** → 失败集中在 ModelScope 域名 |
| 安装按钮门禁 | 读码 | `SkillDetail.tsx:377-378` `canInstallFromPlatform` 由 `PLATFORM_SKILL_DOWNLOAD` 决定；`:558` `installBlocked` 联动 |
| SafeSkill 接口是否真存在 | 逐路由实测 | 文档声明 `GET /v1/search`，实测 `/v1/search` nginx 404、`/api/v1/search` 应用层 404（GET/POST 均试）；仅 `POST /api/v1/scan` 与 `GET /api/v1/report` 存活且需 apikey |

## 可修复缺陷清单

| ID | 优先级 | 位置 | 问题 | 改法 |
|---|---|---|---|---|
| D1 | **P0** | `platform-constants.ts:80` | `PLATFORM_SKILL_DOWNLOAD` 漏登 `'modelscope'` → 安装按钮禁用 | 登记 `'modelscope'` |
| D2 | **P0** | `platforms/modelscope.ts` | 未实现 `fetchSkillDownload` → 无下载通道 | 实现并返回实测可用的 zip 直链 |
| D3 | P1 | `platforms/modelscope.ts` `mapSkill` | `downloadUrl` 给页面地址而非 zip 直链 | 与 `toListItem` 对齐合成 zip 直链 |
| D4 | P1 | `resolvers/dispatch.ts:130` + `types.ts:32` | 用 MCP 配额 100 卡 Skill 分页（Skill 真实 2400） | 按资源类型拆分 |
| D5 | P2 | `platforms/modelscope.ts:466` | `fetchServerDetail` 硬编码 `@modelscope/mcp-server`（实测 npm 404） | 改读 `server_config` |
| D6 | **P1** | `platforms/skillsmp.ts:15-20` | 基址 `api.skillsmp.com` DNS 不可达 + 路径错 → 查询恒失败 | 改 `https://skillsmp.com` + `/api/skills` |
| D7 | **P1** | `platforms/skillsmp.ts:120` | 忽略 `githubUrl` → `sourceUrl` 非 GitHub 源 → 安装必失败 | 优先取 `raw.githubUrl` |
| D8 | P2 | `platforms/registry.ts:24-25` | `safeskill` 指向 `skillhubAdapter`；空 baseUrl 时静默回退 `api.skillhub.cn` → 串出 SkillHub 数据 | 解除映射（待产品决策） |
| D9 | P2 | `platform-constants.ts:135` | safeskill 探活 `'/'` 恒 200 → 假绿 | 待产品决策 |
| D10 | P3 | `dispatch.ts:64-66/139-140`、`platform-constants.ts:77/110-117` | 陈旧/被证伪的注释（空 q 返 40 条、走 iflytek 仓库、无 zip 通道、github 类并存） | 按实测改写 |
| D11 | P3 | `platforms/search-cache.ts:42-54` | 缓存键缺鉴权态（加 token 后仍复用匿名旧结果） | 键内纳入 `authorized` |
| D12 | P3 | `cache-manager.ts` | 内存 Map 与磁盘 `.enc` 无容量上限 → 无界增长 | 加容量上限 |
| D13 | ~~P3~~ | ~~`install-zip.ts:20`~~ | ~~`isZipDownloadUrl` 正则不含 `www.`~~ | **已证伪，非缺陷**：实测该正则无行首锚点，`www.modelscope.cn` / `modelscope.cn` / 含 `@` 三种形态**全部匹配** |
| D14 | P3 | `__tests__/platform-adapters.test.ts:223-230` | 仅单向守卫（列表→实现），拦截不到「该登记却漏登」 | 补反向守卫 |
| D15 | P3 | `platform-constants.ts:157-170` | `SKILLSMP_CATEGORIES` 孤儿常量，且实测 8/12 个 slug 会 400 | 删除或改挂真实接口（上游无 category 过滤） |

## 上游限制问题清单

| ID | 源 | 限制的确切性质 | 实测证据 | 建议 UI 措辞 |
|---|---|---|---|---|
| U1 | ModelScope | 网关对**新建连接**偶发拒绝，非本机网络 | MCP 空搜索 4/8、Skill 1/3 失败（`UND_ERR_CONNECT_TIMEOUT` ~10s）；同刻 `api.github.com` 0/8 | 「ModelScope 响应较慢/偶发超时，正在重试」 |
| U2 | SafeSkill | 文档声明的 `GET /v1/search` **线上未部署**；仅 scan/report 存活且需 apikey | `/v1/search` 404(nginx)、`/api/v1/search` 404(应用层)、`POST /api/v1/scan` 200 需 apikey、`GET /api/v1/report` 200 校验 apikey | 不得显示「已连接」；应说明「该站点未开放技能列表接口」 |
| U3 | 虾评 Coze | 下载接口需有效 Bearer Key | 无 token 401 `Authorization required`；无效 token 401 `Invalid API key` | 「请先在源设置中绑定有效的虾评 API Key」 |
| U4 | SkillsMP | 搜索 API 不支持 category 过滤 | `filters` 仅 `search/sortBy`；8/12 内置 slug 直接 400 | 隐藏该源分类筛选 |
| U5 | ClawHub | 个别条目上游构建缺失 | `?slug=instagram-scraper` → 409 | 「该技能上游暂不可下载，请换一个」 |
| U6 | skills.sh / ClawHub | 上游分页为游标制且无关键词搜索 | ClawHub 仅 trending 榜单，`limit>100` 400 | 明确「仅榜单、不支持关键词」 |

## 执行计划

### 批次划分

| 批次 | 内容 | 目的 | 状态 |
|---|---|---|---|
| **B1** | D1–D7（ModelScope 安装通道接线 + 配额拆分 + SkillsMP 基址/字段） | 直击用户主诉，把「能装却被禁」的源接通 | ✅ 已实施 + 已验证（含 D14 反向守卫，提前落地） |
| **B2** | D8–D12、D15（SafeSkill 映射与探活、陈旧注释、缓存键、缓存容量、孤儿常量与死模板） | 收口工程债，防止同类缺陷再漏出 | ✅ 已实施 + 已验证 |
| **B4** | W5：百炼 Bailian 源审计（本轮唯一未覆盖源） | 补全 13 源覆盖面 | ✅ 已完成（结论：死代码 D16，本轮不改，见 A10） |

### 验收标准

1. **ModelScope 技能可在商店内一键安装**：`PLATFORM_SKILL_DOWNLOAD` 含 `modelscope`，适配器实现 `fetchSkillDownload`，端到端装出的目录含 `SKILL.md` 与真实 `files` 清单。
2. **SkillsMP 查询与安装恢复**：基址 DNS 可达，列表返回条目，条目 `sourceUrl` 为 GitHub 源且可 `parseImportUrl` 解析。
3. **配额不再误报**：ModelScope Skill 第 6–120 页不再返回 `__QUOTA_LIMIT_EXCEED__`；MCP 侧仍按 100 拦截。
4. **回归测试能捕获本轮缺陷**：新增反向守卫（实现了 `fetchSkillDownload` 却未登记 → 测试红）+ 配额边界用例 + `githubUrl` 优先用例。
5. **验证强度**：`npx vitest run` 连跑多轮全绿；两套 tsc 均 exit 0；**关键新用例需用变异测试证伪**（把修复还原成缺陷 → 用例必须转红），避免空转用例。

### 验证方式（沿用前序轮次已生效的做法）

- 变异测试：临时把守卫还原为缺陷实现，跑定向用例断言必红，再按 md5 逐字节还原。
- 全量套件连跑 ≥3 轮，排除偶发。
- 双 tsc：`tsc --noEmit -p tsconfig.main.json` 与 `-p tsconfig.json`。
- 代码来源核对：用文件时间戳 / `git diff` 判定改动归属，防止把历史未提交改动误算到本轮。

## 待决策项（已按「只修缺陷、不做功能扩张」定案）

> 这两项曾标记为「待川哥决策」，现已自行收口：只修**缺陷**，不扩张**功能范围**。理由记录如下，如不认可可随时推翻。

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| A7-1 | SafeSkill | **保留类型，修掉两个缺陷**（解除 `registry.ts:25` 的 `skillhubAdapter` 映射 + 探活不再假绿） | 「空 baseUrl 串出 SkillHub 数据」与「探活恒 200」是**缺陷**，必须修；而「下线整个源」是产品范围变更，会动到存量连接，不属本轮。改完效果：该源查询会诚实报「不支持」，不再假装可用、不再串别家数据 |
| A7-2 | ClawHub / SkillHub 安装 | **维持禁用，只把被证伪的注释改成事实** | 二者 zip 直链虽实测可用，但「放开安装」是**新增能力**而非修缺陷。按「不做功能扩张」原则不在此轮做。已记为可选增强（见下方 backlog），需要时单独立项 |
| A10 | 百炼 Bailian（D16） | **本轮不改，仅记录**。接线（补 `PlatformType` / `PLATFORM_META` / 平台类型清单三处）或删除适配器，均属产品范围决策 | 适配器逻辑自洽且已注册，改接线是「启用新源」（新能力），删除则是移除已有资产；两者都不属于「修缺陷」。若要接线，另需先修复其 icon URL 404 的数据缺陷 |

### 实施与验证记录（2026-09-11）

> 团队两名成员（engineer / qa）因平台 429 限流未能执行，B2 与端到端验证由主理人直接实施并自行验证，全过程证据如下，可独立复核。

| 项 | 证据 |
|---|---|
| B1 修复（D1–D7） | 双 tsc exit 0；`npx vitest run` 连跑 3 轮全绿（26 文件 / 368 用例）；**5 个变异全部转红**（M1 抹掉 modelscope 登记 / M2 配额退回 100 / M3 忽略 githubUrl / M4 downloadUrl 退回页面地址 / M5 摘掉 fetchSkillDownload），均按 md5 逐字节还原 |
| B2 修复（D8–D12、D15） | 双 tsc exit 0（第一轮 tsc 抓到 `listAdapters` 的 `Partial` 缺键类型错误并已修复）；全量 3 轮 + 1 轮复核全绿（28 文件 / 384 用例）；**5 个变异全部转红**（M6 串回 skillhubAdapter / M7 恢复探活 `['/']` / M8 缓存键去鉴权态 / M9 关闭容量裁剪 / M10 恢复孤儿常量），均按 md5 逐字节还原 |
| 端到端安装链 | 新增 `src/__tests__/install-platform-chain.test.ts`：V1 直链→zip 安装→落盘真目录（SKILL.md + 3 文件清单）；V2 未接线平台主进程/渲染层双重拦截；V3 `owner/slug` 路由编解码往返；V4 空 ID 明确报错 |
| 数据复核 | ClawHub 榜单实测 100 条：`install.kind='clawhub'` 60 条（60%，注释准确）、`github` 0 条（旧注释证伪成立） |

### 可选增强 backlog（本轮不做，非缺陷）

| # | 事项 | 依据 |
|---|---|---|
| E1 | 放开 ClawHub / SkillHub 的商店内安装 | 实测 zip 直链均可用：SkillHub `?slug=tencent-docs` → 302→200、378994B 含 `SKILL.md`；ClawHub `?slug=planning-with-files` → 200、122160B 含 `SKILL.md`。需补 `fetchSkillDownload` + 登记 `PLATFORM_SKILL_DOWNLOAD` |
| E2 | 为 ModelScope 域名增加连接级退避 | 上游新建连接超时率 33–50%，现有 2 次重试可缓解但首次等待可达 ~10s |

## TODOS

- [x] A1 四路只读实测排查（W1–W4）回传并汇总
- [x] A2 汇总实测矩阵：每源 × 查询/详情/安装 的可用性判定
- [x] A3 可修复缺陷定级与排序，出最小改法（D1–D16）
- [x] A6 产出问题报告清单（上游限制 U1–U6 附确证证据与建议 UI 措辞）
- [x] A7 决策收口（按「只修缺陷、不做功能扩张」定案，见「待决策项」）
- [x] A4a **B1 实施**：D1–D7 修复 + 回归测试（ModelScope 安装接线 / 配额拆分 / SkillsMP 基址与字段）+ D14 反向守卫
- [x] A4b **B2 实施**：D8–D12、D15（SafeSkill 映射与探活 / 陈旧注释 / 缓存键鉴权态 / 缓存容量上限 / 孤儿常量与死模板）
- [x] A5 独立复核：变异测试证伪新用例有效性（B1 五连 + B2 五连全转红）+ 全量 vitest 多轮 + 双 tsc
- [x] A8 **B4**：百炼 Bailian 源审计（结论：死代码 D16，本轮不改，见 A10）
- [x] A9 ~~顺延自 plan-7.1 T6：待用户补证虾评报错文案~~ → **已结案：无法复现，不做推测归因**
  - 川哥明确表示他也没有报错文案。处置：该源记为「实测链路全通、未复现失败」，**不再作为阻塞项挂着**。
  - 已确证的事实（保留在案）：匿名列表 ✅ 200；`/api/categories` ✅ 与 `COZE_CATEGORIES` 一致；下载接口无 token → 401 `Authorization required`、无效 token → 401 `Invalid API key`；代码 `coze.ts:181-186` 无 secret 时直接抛明确错误、不发请求。**结论：代码路径正确，用户侧若遇失败，最可能是未绑定有效 API Key 或 Key 已失效。**

## 复现与取证命令（供独立复核）

> 全程只读、不读任何本机密钥；临时脚本放仓库外（`%USERPROFILE%\.workbuddy\tmp-verify\`）并即时删除。

```js
// SkillsMP：基址 DNS 不可达 + 真实契约
// api.skillsmp.com → ENOTFOUND ；skillsmp.com → 200
await fetch('https://skillsmp.com/api/skills?search=skill&page=1');   // 200，含 githubUrl
await fetch('https://skillsmp.com/api/skills?search=&page=1');        // 400 INVALID_QUERY
await fetch('https://skillsmp.com/api/skills');                       // 200（不带 search 参数）

// ModelScope：zip 直链可用性
// GET https://www.modelscope.cn/skills/pythonworld/test/archive/zip/master
//   → 200 / application/octet-stream / 魔术字节 504B0304

// ModelScope：配额口径
// Skill page_number=5&page_size=20   → 200 有数据（代码却预判拒绝）
// Skill page_number=120&page_size=20 → 200
// MCP   page_size=101                → 403 QuotaLimitExceed（上限 100）

// SafeSkill：文档声明的接口是否真存在
// GET  https://api.safeskill.cn/v1/search?apikey=..&query=..  → 404 nginx
// GET/POST https://api.safeskill.cn/api/v1/search             → 404 应用层
// POST https://api.safeskill.cn/api/v1/scan                   → 200 {"response_code":-3,...}
// GET  https://api.safeskill.cn/api/v1/report?apikey=..       → 200 {"response_code":-1,...}
```
