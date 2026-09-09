# 实施计划（Phase 3–6）：npm 数据源增强 · 可信层 / 运行确定性 / 许可汇总

> 版本：v1.0 (2026-09-09)
> 关联前置：`doc/plan-npm-mcp-marketplace.md`（Phase 1–6 总览）、`doc/plan-npm-source-impl.md`（Phase 1–2 实施，已落地未提交）
> 执行范围（已与产品确认）：**Phase 3 + Phase 4（轻量方案）+ Phase 6**。Phase 5 已借 seed 内置源完成，本次无新增。
> 隔离前提不变：所有改动增量/早返回/数组增项，绝不触碰 `modelscope.ts` 及其调用链。

---

## 0. 关键事实修正（影响 Phase 3 匹配策略）

经实测官方 MCP Registry（`registry.modelcontextprotocol.io/v0.1/servers`）真实响应：
- 每个 server 形如 `{ server: { name(反向DNS), description, repository?:{url}, remotes?, version, packages?[]:{registryType,version}, _meta?{<ns>/publisher-provided:{categories:[]}} } }`。
- **`packages[]` 不含 npm 包名**（仅 `registryType`/`version`），因此无法用包名直接映射。
- **无可靠 `verified` 字段**。
- 可用信号：`repository.url`（与 npm 包 metadata 的 `repository.url` 可对齐）、`_meta` 里的 `categories`（发布者自填，真实子分类）。

→ 结论：Phase 3 的「多键匹配」实际落地为 **repository URL 归一化匹配**（git+ / .git / github: 简写 / 大小写 / 末尾斜杠统一），匹配成功即视为「已收录于官方 Registry」并打 **registry-listed 徽章**（诚实的可信信号），同时把 Registry 的 `categories` 回填到详情，给 npm 包以**真实子分类**（直接回答「npm 是否支持 mcp 下的分类」——搜索层仍是扁平单一 `mcp` 桶，详情层在能匹配到 Registry 时给出真实子分类）。

---

## 1. 任务拆解

### T1 · 构建期快照聚合脚本（Phase 3 数据来源）
- 新增 `scripts/aggregate-mcp-registry.mjs`：GET `registry.modelcontextprotocol.io/v0.1/servers` → 抽取 `name/description/repository/remotes/categories(_meta)/packages` → 写入 `src/main/platforms/data/mcp-registry-snapshot.json`（含 `generatedAt`）。
- 容错：网络失败仅 `exitCode=1`，不破坏构建。
- `package.json` 增脚本 `aggregate:registry`。

### T2 · npm 适配器：Registry 可信增强（Phase 3 核心）
- 文件 `src/main/platforms/npm.ts` 增量：
  - `normalizeRepoUrl(raw)`：归一化仓库地址（处理 `git+https`、`*.git`、GitHub 简写、去 `www.`、小写 host+path）。
  - `buildRegistryIndex(servers)` / `enrichWithRegistry(detail, index, repoUrl)`：纯函数，便于单测。
  - 懒加载快照 `getRegistryIndex()`（从 `__dirname/data/...` 读，缺文件返回空 Map）。
  - `fetchServerDetail`：映射后做 Registry 匹配 → 命中则 `isVerified=true` + 回填 `categories`/`categoryNames`/`extra.registryName`/`registryCategories`；未命中则默认 `categories:['mcp']`。
  - 导出测试注入点（`__setRegistryIndexForTest` 等）。
- 类型：`PlatformServerDetail` 已有 `isVerified`、`categories`、`categoryNames` 字段，无需改 types。

### T3 · 宿主 Node 运行时探测 + 预缓存（Phase 4 轻量方案）
- 新增 `src/main/platforms/node-runtime.ts`：`detectNodeRuntime()`（探测内置 `process.resourcesPath/node` 占位 + 宿主 `node -v`/`npx -v`，用 `getEnhancedPathEnv()` 增强 PATH，结果缓存）。返回 `{available,version,nodePath,npxPath,bundled}`。
- 新增 `scripts/precache-npm-servers.mjs`：对一份精选热门 MCP server 包清单（~20 个），拉取 npm metadata 写入 `src/main/platforms/data/precache-npm-servers.json`（version/license/bin/engines/repository）。作为**离线兜底**。
- `npm.ts`：`fetchServerDetail` 先试 live npm；失败则回退 precache（离线可用）；并附 `extra.hostNode`（宿主 Node 可用性）供 UI/诊断。
- `package.json` 增脚本 `precache:npm-servers`。**不**自动挂到 `build`（避免构建期强依赖网络），由发布前手动跑或 CI 缓存。

### T4 · 安装时许可自动汇总（Phase 6）
- 扩展 `McpServerConfig`：4 处定义（main/config/types.ts、preload/index.ts、preload/index.d.ts、renderer/lib/electron.ts）均增可选 `license?`、`source?`、`homepage?`。
- `src/renderer/src/pages/PlatformServerDetail.tsx`：`handleInstall` 把 `detail.extra.license / source / sourceUrl` 一并写入 `config`；详情统计区展示 `license`。
- `src/main/config-manager.ts`：`installServer` 写盘成功后把 `{serverId, license, source, homepage, clients, installedAt}` 聚合进 `~/.ai-tools/installed-mcp-licenses.json`（map 结构，幂等 upsert）；`uninstallServer` 按 `serverId` 删除。仅当 `serverConfig.license` 存在时才写（modelscope 等不传则跳过，隔离保证）。

### T5 · UI 徽章与回归
- `src/renderer/src/components/ServerCard.tsx`：平台源分支补 `isVerified` 徽章渲染（仅在命中时显示，搜索层不命中故无副作用）。详情页 `PlatformServerDetail.tsx` 已有 `isVerified` 渲染（L321），无需改。
- 回归：`modelscope` 全链路字节级不动。

### T6 · 单测 + 类型检查 + 构建联调
- 扩展 `src/__tests__/npm-adapter.test.ts`：`normalizeRepoUrl` 多用例、`buildRegistryIndex`+`enrichWithRegistry` 命中/未命中、`fetchServerDetail` precache 离线兜底、hostNode 附值。
- `pnpm typecheck`、`pnpm test` 全绿；确认 `modelscope` 无回归。

---

## 2. 影响面与回归保障
- 新增：`scripts/aggregate-mcp-registry.mjs`、`scripts/precache-npm-servers.mjs`、`src/main/platforms/node-runtime.ts`、`src/main/platforms/data/*.json`（生成产物）。
- 修改：`src/main/platforms/npm.ts`、`src/main/config-manager.ts`、`src/renderer/src/pages/PlatformServerDetail.tsx`、`src/renderer/src/components/ServerCard.tsx`、`McpServerConfig` 4 处、`package.json`。
- 不触碰：`modelscope.ts` 及注册、`servers.ts` 的 modelscope 分支、mcp-client.ts 的 `resolveCommand`（保持通用，npm 仍走 `npx` 主干）、`useMcpData.ts`、`PlatformServerDetail.tsx` 的调用通道。
- 构建产物：`copy-platform-data.mjs` 已自动拷贝 `platforms/<name>/data`，快照/预缓存 JSON 自动随包。

## 3. 待确认/风险
- 官方 Registry 无 npm 包名字段 → 匹配覆盖率取决于「npm 包与 Registry 条目是否都填了可对齐的 repository.url」，覆盖率非 100%（已如实说明）。
- 预缓存为离线兜底，版本以构建期为准；live 优先，命中失败才用缓存，避免长期陈旧。
- 工作树现含 Phase 1–2（npm 适配器）与先前「许可合规」两组未提交改动；建议本次 Phase 3–6 也独立提交（或三者合并视评审而定）。
