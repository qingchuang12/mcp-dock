# 商店 NPM 数据源 · Phase 3–6 增强 — 交付总结

> 计划：`doc/plan-npm-phase3-6.md`（v1.0, 2026-09-09）｜ 前置：`doc/plan-npm-mcp-marketplace.md`、`doc/plan-npm-source-impl.md`（Phase 1–2 已落地未提交）
> 验证：`pnpm typecheck` 0 错误；`pnpm test` 257 例全过（modelscope 9 例无回归）；npm 适配器单测 10 例。

## 一、回答你的问题：npm 是否支持 MCP 下的分类？
**搜索层：不支持真实子分类。** npm Registry Search API 没有分类维度，当前 npm 适配器把所有结果归入单一合成「MCP」桶（`getFacets` 仅返回 `categories:['mcp']`、`supportsSubcategories:false`）。
**详情层：可借官方 Registry 给真实子分类。** 当某个 npm 包能在官方 MCP Registry 快照里按「仓库地址」匹配到时，会回填该条目发布者自填的 `categories`（真实子分类）。所以本质结论：**分类能力来自官方 MCP Registry 的元数据，而非 npm 本身。**

## 二、Phase 3 — 官方 MCP Registry 可信层
- **关键事实修正（实测）**：官方 Registry 响应**不含 npm 包名**、**无可靠 `verified` 字段**，仅带 `repository.url` 与 `_meta` 里的 `categories`。
- **多键匹配落地为「仓库地址归一化匹配」**：`normalizeRepoUrl()` 统一 `git+` / `.git` / `github:user/repo` 简写 / 大小写 / `www.` / 末尾斜杠。命中即视为「已收录于官方 Registry」并打 `isVerified` 徽章（诚实的可信信号，非伪造 verified），同时回填真实 `categories`。
- **构建期聚合**：`scripts/aggregate-mcp-registry.mjs` 分页拉取（cursor，`?limit=100`，50 页上限=5000 条）→ `src/main/platforms/data/mcp-registry-snapshot.json`（1.9MB）。`copy-platform-data.mjs` 已扩展，把顶层 `platforms/data` 拷进 `dist`。
- **UI**：`ServerCard` 平台源分支 + `PlatformServerDetail` 均已渲染 `isVerified` 徽章与分类标签。

## 三、Phase 4 — 运行确定性（轻量方案：宿主探测 + 预缓存）
- `src/main/platforms/node-runtime.ts`：`detectNodeRuntime()` 探测内置 `resourcesPath/node`（占位，当前未随包）与宿主 `node`/`npx`（用 `getEnhancedPathEnv` 增强 PATH），结果缓存；详情附 `extra.hostNode` 可用性。
- `scripts/precache-npm-servers.mjs`：对 25 个热门包预缓存元数据 → `precache-npm-servers.json`；`fetchServerDetail` 在 live 拉取失败时回退预缓存（**离线兜底**）。
- **未触碰** `mcp-client.ts` 的通用 `resolveCommand`（保持 modelscope 零影响）。

## 四、Phase 6 — 安装时许可自动汇总
- `McpServerConfig` 在 4 处定义（main/config/types、preload/index.ts、preload/index.d.ts、renderer/lib/electron.ts）增可选 `license?` / `source?` / `homepage?`。
- `config-manager.installServer` 写盘成功后把 `{serverId, license, source, homepage, clients, installedAt}` 聚合进 `~/.ai-tools/installed-mcp-licenses.json`（幂等 upsert）；`uninstallServer` 按 `serverId` 删除。**仅当 `license` 存在才写**（modelscope 不传则跳过，隔离保证）。
- 详情页 `handleInstall` 透传 license/source/homepage，统计区展示 license。

## 五、隔离与回归
- 所有改动增量/早返回/数组增项；`modelscope.ts` 与其注册、调用链字节级未动（QA 已确认 Phase 1–2，本次延续）。
- 新增 `package.json` 脚本：`aggregate:registry`、`precache:npm-servers`（**不挂默认 build 链**，避免构建期强依赖网络；发布前手动跑或 CI 缓存）。

## 六、已知限制（如实告知）
- **匹配覆盖率有限**：基于 repository URL，要求「npm 包与 Registry 条目都填了可对齐的 repo」。实测 13 个预缓存热门包中仅 `exa-mcp-server` 命中（其余多为官方 `@modelcontextprotocol/server-*`——它们未在公开 Registry 索引，404）。命中主要发生在「同时在 npm 与 Registry 发布且 repo 一致」的第三方 server。
- 快照为字母序前 5000 条（官方 `io.github.modelcontextprotocol.*` 在其后未达 cap），机制正确、随快照重建自动扩展。

## 七、待办建议
- 工作树现含 3 组未提交改动（许可合规 / npm Phase1-2 / npm Phase3-6），建议分别独立提交以免混杂。
- 若需更高 Registry 覆盖率，可后续：放宽 aggregate 页上限、或改从 Registry 反查「官方 server 列表」注入。
