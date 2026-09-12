# plan-14.0 · 单一活动计划（百炼远程 MCP 安装 + 遗留项承接）

> 版本：2.0（2026-09-12 模块 A：百炼「不能安装」修复——远程 MCP 安装形态）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-13.0.md](archive/plan-13.0.md)（A10 百炼接线 + E2 退避 + electron:dev 修复 + C 空态美化 + D/E/F 商店源完善 + G 百炼哨兵值修复，AI 任务全绿后归档；遗留用户侧事项：统一提交，由川哥执行）。

## 规则（plan 管理铁律）
- `doc/` 下**同一时刻只保留一个活动 plan**（本文件）；新任务合并进本 plan，不另起 `plan-NN.N.md`。
- 任务**已执行完结** → 归档到 `doc/archive/`（plan 与 audit 一并归档）；**未执行** → 合并进活动 plan。
- 每次软件调整：细化进 plan → 确认 → 执行 → 归档检查。

---

## 跨版本遗留项

- [x] StoreFilterBar `hasActiveFilters` 硬编码 `sort !== 'relevance'` 为「未筛选」基准 → **已收敛（2026-09-12 实施 + 验证）**：提炼 `src/renderer/src/lib/store-filters.ts` 纯函数（`resolveSortDisplayValue` + `hasActiveStoreFilters`），基准改为「排序处于该源默认选项（sortOptions[0]，与下拉显示值一致）」。误判场景：用户在无 relevance 的源（百炼=calls/SkillsMP=stars）上选回首选项（= 回到该源默认序）被旧逻辑判为「有筛选」，清除按钮常驻；且点清除后 sort 变成下拉不存在的 'relevance'，显示又兜底回首选项——视觉矛盾。新逻辑与显示值一致；空选项集退化为旧语义；`Store.tsx` 的切源重置/清除行为（`setSort('relevance')`）不动（relevance 是跨源中立值，显示层兜底语义不变）。测试：`store-search.test.ts` 补 9 条（百炼/SkillsMP/smithery 三形态矩阵 + 空选项集退化）；全量 29 文件 / **433 passed**，双 tsc exit 0。

## 本次确认任务

- [x] 百炼 MCP 详情接线与外链纠正：旧 `api-connections:get-server-detail` resolver 委派已注册且实现 `fetchServerDetail` 的 adapter，使商店详情能取得 `source: 'bailian'` / `sourceUrl`；Source 卡片只为 ModelScope 展示其专属平台链接，百炼复用 `sourceUrl` 打开对应控制台服务详情；已补百炼详情 adapter 与旧 resolver 委派回归测试。

## 模块 A · 商店-MCP-百炼「不能安装」（2026-09-12，川哥反馈；已实施并验证，QA 放行）

### A.1 诊断结论（主理人已完成取证）
- **直接原因**：`bailian.ts` `fetchServerDetail` 返回 `install: null`（当初按「远程托管无需本地命令」处理）→ `PlatformServerDetail.tsx:284` `canInstall = !!detail.install` 为 false → 详情页显示灰色「无可用安装配置」，无安装入口。详情链路本身已通（`servers.ts:297-299` 委派 adapter）。
- **本质**：百炼是**远程托管 MCP**，安装 = 向客户端配置写入 `{url, type:'sse'|'streamable-http', headers:{Authorization: Bearer <DASHSCOPE_API_KEY>}}`，与本地 command/args 形态不同。
- **主进程能力已齐备（零改动）**：`McpServerConfig`（`electron.ts:59`、`config/types.ts:15`）含 `url`/`type`/`headers`；`config-manager.installServer` 纯透传；`format-adapters.ts` 对 openclaw/zcode/opencode 有显式 remote 分支，其余客户端整对象透传；`mcp:connect`（Inspector）支持 URL 连接。
- **上游事实（实测 + 官方文档，2026-09-12）**：
  - 接入 URL：`https://dashscope.aliyuncs.com/api/v1/mcps/{slug}/sse`（SSE）或 `/mcp`（Streamable HTTP），鉴权 Header `Authorization: Bearer ${DASHSCOPE_API_KEY}`（来源：help.aliyun.com《web-search-for-coding-plan》《official-and-third-party-mcp》）。
  - **slug ≠ 中文服务名**：官方示例 slug 为英文（`amap-maps`/`WebSearch`）；索引 251 条 serverName **全部含中文、0 条纯 ASCII**，且索引无 slug 字段 → 无法自动生成确定可用的 URL；匿名探测全 401（`InvalidApiKey`，鉴权先于路由），无法验证 slug 存在性。
- **诚实边界**：预填 URL 为**生成值**（dashscope 格式 + 中文名 URL 编码），部分服务 slug 不同 → UI 必须**可编辑**并明示「以百炼控制台接入地址为准」；codex-cli（TOML）读写均只支持 command 型，远程配置会被丢弃（既有局限，本次不扩，如实记录）。

### A.2 实施方案（工程师执行）
1. **类型**：渲染层 `PlatformServerDetail` 的 `install` 扩展为联合 `LocalInstall | RemoteInstall`（Remote = `{url: string; type: 'sse'|'http'|'streamable-http'}`）；`LocalInstall` 保持 `{command; args?; env?; cwd?}`。
2. **`bailian.ts`** `fetchServerDetail`：返回 `install: {url, type:'sse'}`（URL 按 dashscope 格式生成，中文名 encodeURIComponent）+ `envSchema`：`required: ['DASHSCOPE_API_KEY']`，description 指引「阿里云百炼 API Key（sk-…）」；readme 补接入说明（slug 以控制台为准）；`extra.mode:'remote'` 保留。
3. **`PlatformServerDetail.tsx`**：
   - `canInstall = !!detail.install`（自然放通）；
   - 远程型**跳过 runtime 检测**（无本地 Node/Python 依赖），不显示运行时警告；
   - 安装模态远程分支：接入 URL 输入框（预填可编辑）+ 复用 envSchema 表单输入 Key；handleInstall 构造 `{url, type, headers:{Authorization: 'Bearer '+key}}`；
   - `openInspector` 远程型传 `{url, type, headers}`。
4. **测试**（`platform-adapters.test.ts`）：bailian `fetchServerDetail` 返回远程 install 的断言（url 格式 / type / envSchema 必填）；全量回归。
5. **验证**：双 tsc + vitest 全量 + dist 产物直跑 fetchServerDetail 抽查。

### A.3 实施（工程师）与验证（QA 放行，2026-09-12）
实施落点（与 A.2 方案的差异：类型扩展落在 `src/main/platforms/types.ts` 而非渲染层——`PlatformServerDetail` 类型由该处 re-export，单一事实源）：
| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/main/platforms/types.ts` | 新增 `LocalInstall`/`RemoteInstall` 联合，`install?: LocalInstall \| RemoteInstall \| null`（旧 `args: string[]` 必征求窄为可选） |
| 2 | `src/main/platforms/bailian.ts` | `fetchServerDetail` 返回远程 install（`{url: dashscope 格式生成, type:'sse'}`）+ `envSchema.required: ['DASHSCOPE_API_KEY']` + readme 接入说明 |
| 3 | `src/renderer/src/pages/PlatformServerDetail.tsx` | 远程分支：跳过 runtime 检测、可编辑 URL 输入框、handleInstall 构造 `{url,type,headers:{Authorization:'Bearer '+key}}`、openInspector 远程传 URL 配置；本地命令型（ModelScope/npm）逐行保留 |
| 4 | `zh/en locale` | `detail.remoteUrlLabel` / `detail.remoteUrlHint` 成对新增 |
| 5 | 测试 | `platform-adapters.test.ts` bailian 详情断言（url 格式/type/envSchema）；`server-detail-resolver.test.ts` 过时断言同步（原断言 install:null） |

**验证证据**（QA 独立复跑，1 轮通过、零修复）：
- 双 `tsc --noEmit` exit 0；`vitest run` 全量 **29 文件 / 424 passed**，exit 0。
- **dist 产物级验证 15/15**：编译 dist 后直跑 `bailian.js` 的 `fetchServerDetail`，抽样「企业知识库」（纯中文）+「OA审批 2」（含空格数字）+ 未知 ID 异常路径——url 格式/type/envSchema/readme/异常文案全对（脚本 `.zcode/qa-dist-bailian-verify.cjs` 可复跑）。
- 回归走查：modelscope/npm/clawhub/servers.ts 的 install 赋值点 args 均有值（类型收窄不破坏）；渲染层 `detail.install.*` 访问全部在 `'url' in`/`'command' in` 收窄守卫内；本地分支 diff 核对逐行保留；i18n JSON 双语成对；落盘链路（installServer 透传 → mcpServers[serverId]）无 command 强校验。

**建议级遗留（QA 发现，川哥拍板「继续处理」，2026-09-12 已全部收敛）**：
1. ✅ **preload 类型同步**：`src/preload/index.ts` 本地旧形态 `McpServerConfig`（command 必填、缺 url/type/headers）删除，改为 re-export 主进程 `config/types.ts` 单一事实源，消除三端类型漂移。
2. ✅ **首帧状态稳定**：`PlatformServerDetail.tsx` 渲染期对远程型直接视为 `runtimeAvailable`（`isRemoteInstall || runtimeInfo?.available`）——runtimeInfo 由 effect 异步置位、首帧为 null，此前安装按钮晚一帧出现、警告横幅闪现一帧。
3. ✅ **远程 headers 通用化**：`RemoteInstall` 新增 `headersTemplate?: Record<string,string>`（`${KEY}` 占位符），百炼声明 `{'Authorization': 'Bearer ${DASHSCOPE_API_KEY}'}`；详情页 `buildRemoteHeaders` 按模板填充 `envInputs`（空值键值对剔除、全空不写 headers），`handleInstall`/`openInspector` 不再硬编码键名——未来接入其他远程平台由各源自行声明。
   - 测试同步：`platform-adapters.test.ts` 补 headersTemplate 断言；`server-detail-resolver.test.ts` 过时 toEqual 断言同步（新增字段使精确匹配失败）。
4. （已随本模块落地，报备）ModelScope 专属外链改为 `detail.source === 'modelscope'` 条件渲染，修复百炼详情页误显示 ModelScope 入口。

**验证**：双 `tsc --noEmit` exit 0；`vitest run` 全量 **29 文件 / 433 passed**，exit 0。

- [x] A 百炼远程 MCP 安装（类型扩展 + 详情远程分支 + 测试；实施 + 验证，QA 放行；建议级遗留 1~3 已收敛）

---

## TODOS（汇总）
- [x] A 百炼远程 MCP 安装（类型扩展 + 详情远程分支 + 测试；实施 + 验证，QA 放行；建议级遗留 1~3 已收敛）
- [x] StoreFilterBar hasActiveFilters 的 'relevance' 硬编码基准收敛（实施 + 验证，见跨版本遗留项）
- [x] 百炼 MCP 详情接线与外链纠正（本次确认任务）
