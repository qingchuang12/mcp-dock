# plan-4.0 · 移除 Official Registry 数据源

> 版本：4.0（2026-09-09） · 前任：[archive/plan-3.1.md](archive/plan-3.1.md)（Skill 附属文件编辑，代码已完成并归档）

## 背景与目标

商店的「Official」MCP 数据源抓取 GitHub `modelcontextprotocol/servers` 仓库 `src/` 目录，当前上游仅维护 7 个参考服务器（everything / fetch / filesystem / git / memory / sequentialthinking / time），其余官方已归档，源价值过低（用户确认）。npm 数据源落地后，官方包可经 `@modelcontextprotocol` scope 从 npm 源覆盖，Official 源失去存在必要。

目标：**完整移除** Official 源的全部代码路径（用户已确认「完整移除」档位），不留死代码。

## 范围与边界

**做**

1. renderer：`api/registry.ts` 删 `fetchOfficialServers` / `fetchOfficialServerDetail` / `Official*` 类型与守卫、`DataSource` 收窄；`Detail.tsx` / `Library.tsx` / `Store.tsx` / `ServerCard.tsx` / `McpSourceManager.tsx` 的 official 分支；删除专用组件 `OfficialConfigForm.tsx`；`useMcpData` / `useStore*` 系列 official 处理与默认值。
2. shared/main：`platform-constants.ts`、`connections-store.ts` 种子连接、`index.ts`、`cache-manager.ts`、`platforms/types.ts` 的 official 触点。
3. i18n zh/en 移除 official 源文案；preload/electron.ts 类型面同步。
4. 测试同步 + `pnpm typecheck` / `pnpm test` 全绿。

**不做**（理由）

- 不动 npm / smithery / modelscope 等其余数据源。
- 已安装的官方旧条目不清理：安装配置是真实的 npx/uvx/docker 命令，继续可用；仅 Library 归属判定退化为通用显示（无法再对照已删除的官方列表）。

## 实现思路

- 触点按 `grep -i official src` 清单逐文件处理：先删数据供给端（registry.ts），typecheck 会暴露全部下游断点，逐个消解。
- `DataSource` 由 `'official' | 'smithery'` 收窄为 `'smithery'`；store 默认值 / 回退链同步改。
- 修订：`fetchReadmeFromGitHub` 经核实仅 Detail.tsx official README 链路使用（README 机制整体是 official 专属），已随 official 一并移除，与原计划「保留」的预判相反。
- 新增存量迁移：official 种子用标记文件落库，光删种子不够——`connections-store.migrate()` 增加 `id !== 'mcpsrc_official'` 过滤，旧用户 `connections.json` 中的 official 内置连接在启动时自动清除并持久化。
- 风险回滚：改动集中且未提交，整体 `git checkout` 可回退；typecheck + 280 基线测试兜底。

## TODOS

- [x] ① registry.ts：删 official 抓取/详情/类型/守卫，`DataSource` 收窄
- [x] ② renderer 页面与组件：Detail / Library / Store / ServerCard / McpSourceManager / OfficialConfigForm（删文件）
- [x] ③ renderer hooks 与 store：useMcpData / useStore* / useStoreFacets / useStoreSourceSelection / useStoreData / useStoreAttribution / electron.ts
- [x] ④ shared + main：platform-constants / connections-store / index.ts / cache-manager / platforms/types
- [x] ⑤ i18n zh/en + preload
- [x] ⑥ 测试同步；typecheck + pnpm test 全绿（280/280，与移除前基线一致）

## 跨版本遗留

- 来自 3.1：手动验证清单过一遍（对照弹窗 / banner / 云同步手动项）；P7 求证（cloud 是否保留技能安装目标）。
- 工作树累积未提交改动建议拆分提交：license / npm Phase1-2 / Phase3-6 / Phase7 / Official 源移除（本次）。
