# plan-1.8 · 内置客户端：TRAE SOLO CN（TraeWork 桌面端）

## 背景与目标

用户反馈「trae work 客户端没有自动识别」。经本机核实（2026-09-05，非推测）：

| 项 | 结论 | 来源 |
|---|---|---|
| 用户口中的 TraeWork 桌面端 | 即本机安装的 **TRAE SOLO CN**（VS Code fork） | 应用语言包含 "TraeWork" 品牌字样（`out/nls.zh-cn.messages.json`）；本机 AppData/Roaming 与 AppData/Local/Programs 下唯一 Trae 系产品 |
| 官方产品名 | `nameShort`/`nameLong` = "TRAE SOLO CN"，`applicationName` = "trae-solo-cn"，`dataFolderName` = ".trae-cn"，版本 1.107.1 | `<安装目录>/resources/app/product.json` |
| MCP 配置路径 | VS Code 标准的 `User/mcp.json`（`out/main.js` 中 `mcpResource: ... : lt(i, "mcp.json")`）；本机 `AppData/Roaming/TRAE SOLO CN/User/` 存在但尚未生成 mcp.json（未添加过 server） | 主进程代码 + 本机目录实测 |
| 配置键 | `mcpServers`（非 VS Code 官方的 `servers`）——走 mcp-dock 默认读写分支 | `out/main.js` 中 `{mcpServers: ...}` mixin 代码 |
| 本机可执行文件 | `AppData/Local/Programs/TRAE SOLO CN/TRAE SOLO CN.exe` 已确认存在 | 本机 `ls` 实测 |
| MCP 运行证据 | `AppData/Roaming/TRAE SOLO CN/logs/*/mcp-servers-*.log` 存在（McpConfigService / PluginMcp） | 本机日志实测 |

目标：`trae-solo-cn` 加入内置客户端注册表——装了就自动识别（exe 探测），配置可读写（写 `User/mcp.json`）。

## 范围与边界

**做**

1. `types.ts`：`ClientType` + `ALL_BUILTIN_CLIENTS` 加 `trae-solo-cn`（排在 `trae-cn` 后）。
2. `client-probe.ts`：三平台配置路径、显示名 `TRAE SOLO CN`、三平台安装探测路径。
3. 图标：复用 `trae.png`（与 trae-cn / marscode 同款做法）。
4. `electron.ts` 浏览器 mock 兜底：mock 客户端列表 + `getAllServers.byClient` 两处。
5. 单测：三平台路径 / 显示名 / 本机 exe 探测命中断言。
6. 文档：`doc/README.md` 与 `doc/软件介绍.md` 客户端清单补 TRAE SOLO CN。

**不做**（理由）

- Skills 支持：TRAE 系（trae / trae-cn）均不在 `SKILL_SUPPORTED_CLIENTS`，SOLO 亦然，不加。
- `format-adapters.ts` 适配：`mcpServers` 标准键，默认分支天然覆盖，零改动。
- 国际版 TRAE SOLO：本机未安装，数据目录名无法核实，不臆测；待有实证再加。
- `~/.trae-cn` 目录标记（config marker）：不加。`dataFolderName=.trae-cn` 与经典 Trae CN 的点目录可能撞名，会造成误判；exe 探测（`TRAE SOLO CN.exe`）已足够准确。

## 触点清单

| 文件 | 改动 |
|---|---|
| `src/main/config/types.ts` | `ClientType`、`ALL_BUILTIN_CLIENTS` 两处加 `trae-solo-cn` |
| `src/main/config/client-probe.ts` | `getDefaultClientPaths` 三平台加 `User/mcp.json` 路径；`getClientDisplayName` 加 `TRAE SOLO CN`；`getClientAppPaths` 三平台加探测路径 |
| `src/renderer/src/components/ClientIcon.tsx` | `ClientIconMap` 加 `'trae-solo-cn': traeIcon` |
| `src/renderer/src/lib/electron.ts` | mock 客户端列表（trae 后）、`getAllServers.byClient` 两处 |
| `src/__tests__/client-probe.test.ts` | 三平台路径 / 显示名 / 本机 exe 命中断言 |
| `doc/README.md`、`doc/软件介绍.md` | 客户端清单补 TRAE SOLO CN |

> `config-manager.ts` / `skills-manager.ts` / `history-manager.ts` / `format-adapters.ts` / `client-paths.ts` 均无需改动：遍历取自 `ALL_BUILTIN_CLIENTS`，Skills 由 `SKILL_SUPPORTED_CLIENTS` 派生，配置读写走默认分支。

## 风险与验证

- **风险**：纯 additive；`trae-solo-cn` 只在新分支/新表项中读写，既有 19 个客户端行为不变。
- **验证**：本机已装 TRAE SOLO CN——exe 探测应命中 → 客户端列表显示「已安装（未配置）」；加一个 server 后落盘 `AppData/Roaming/TRAE SOLO CN/User/mcp.json`。
- **回滚**：删掉 `trae-solo-cn` 相关表项即可，无数据迁移。

## TODOS

- [x] `types.ts`：`ClientType` + `ALL_BUILTIN_CLIENTS`
- [x] `client-probe.ts`：三平台配置路径 + 显示名 + 三平台探测路径
- [x] `ClientIcon.tsx`：图标映射
- [x] `electron.ts`：mock 两处
- [x] 单测：路径 / 显示名 / 本机探测
- [x] 文档：README + 软件介绍
- [x] typecheck + test 全绿

## 实施记录（2026-09-05）

验证：`npm run test` 13 文件 / 176 用例全绿（新增 4 例）；`npm run typecheck` 退出码 0。
本机 exe 探测断言命中（`AppData/Local/Programs/TRAE SOLO CN/TRAE SOLO CN.exe` 在探测表内），
即 TRAE SOLO CN 装机即显示「已安装（未配置）」，加 server 后落盘 `AppData/Roaming/TRAE SOLO CN/User/mcp.json`。

### 顺带修正（文档漂移）

plan-1.7 加 ZCode 时两份文档未同步：`doc/软件介绍.md` 客户端数停在 19/11、清单缺 ZCode；
`doc/README.md` 支持矩阵缺 ZCode 行。本次一并修正（21 个 MCP 客户端 / 12 个 Skills 客户端）。

### 遗留说明

国际版 TRAE SOLO（非 CN）未收录：本机未安装，其数据目录名无法核实，不臆测路径；
待拿到实证（安装一份或在官方文档确认目录名）后按本 plan 同样套路补充即可。
