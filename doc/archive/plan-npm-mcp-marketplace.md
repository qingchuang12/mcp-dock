# npm/MCP 桌面端接入 · 技术可执行方案

> 目标：回答三个问题——(1) npm 生态/MCP 是否有「列表查询 / 详情查看 / 安装」接口；(2) 你提出的 `Electron/Tauri + Node.js + child_process 拉起 npx + JSON-RPC(STDIO)` 架构是否可行；(3) 有没有更好的方案。最终整理成一个可在本仓库直接落地的可执行方案。

---

## 0. 结论先行（Verdict）

| 你的提问 | 结论 |
|---|---|
| npm/MCP 有「列表 / 详情 / 安装」接口吗？ | **有，但三者形态不同**：列表=Registry Search API；详情=包元数据 API；「安装」= `npx -y <pkg>`（npm 没有 install RPC，靠拉起 npx 进程完成）。另有一个官方 **MCP Registry**（仅元数据索引，不是包仓库）。 |
| 你提的架构可行吗？ | **不仅可行，而且本仓库已经把它实现了一半**。`src/main/mcp-client.ts` 已经在用 `child_process.spawn` 拉起 `npx` 类命令、走 JSON-RPC 2.0 over STDIO；`src/main/platforms/` 已经有 `PlatformAdapter` 商店抽象（ModelScope / ClawHub / Smithery）。**缺的就是一个 npm Registry 适配器 + 把 npm 接到现有商店 UI。** |
| 有更好的方案吗？ | 有，且都是**增量增强**，不推翻现有架构：① 官方 MCP Registry 做「可信发现」层；② 支持 **DXT**（Desktop Extensions，内嵌运行时、自带权限清单，最契合闭源桌面产品）；③ 自带 Node 运行时（extraResources）替代「依赖宿主 npx 联网拉取」；④ 给第三方 server 加 OS 级沙箱 + 网络出口策略。 |

**一句话路线**：保留你现有的 `npx + JSON-RPC STDIO` 主干，新增 `npm` 平台适配器补齐「发现层」，把 npm 作为**权威包元数据/下载源**，把官方 MCP Registry 作为**可信增强层**，并视产品成熟度逐步引入 DXT 与沙箱。

---

## 1. 接口事实核查（回答第一个问题）

### 1.1 列表查询（List / Search）——✅ 有
**npm Registry Search API**（匿名、无需 token、已在本仓库 `src/renderer/src/api/registry.ts` 的 fetch 模式里可直接复用）：
```
GET https://registry.npmjs.org/-/v1/search?text=<query>&size=20&from=0
```
- 支持限定符：`keywords:mcp`、`author:<user>`、`scope:<scope>`（例如 `text=keywords:mcp%20filesystem`）。
- 返回结构：`{ objects:[{ package:{name,version,description,links,publisher,date}, score:{final,quality,popularity,maintenance}, searchScore }], total, time }`。
- 分页用 `from`（偏移）+ `size`，**无游标**；`total` 可信，前端分页器可直接用。

### 1.2 详情查看（Detail）——✅ 有
```
GET https://registry.npmjs.org/<pkg>              # 全部版本 + dist-tags + readme 字段
GET https://registry.npmjs.org/<pkg>/<version>    # 单版本：bin / dependencies / engines / license
```
- 从单版本元数据可提取：`bin`（运行命令）、`engines.node`（最低 Node 门槛）、`license`、`repository.url`、`description`。
- **配置提示（env/args）npm 没有标准字段**：最佳实践是从 `mcp.json`（若包内含）或 README 约定里抽取；退而求其次，约定 `MCP__<SERVER>__*` 或 server 自带的 `--help` 输出。本方案 Phase 1 先做「best-effort 抽取 + 用户手动补」，不做强解析。

### 1.3 安装（Install）——⚠️ 没有 RPC，靠「拉起进程」
npm **不存在**「安装接口」。桌面端的「安装」= 两步：
1. **解析**：拿到 `name@version`，写入本仓库的 `config.json`（已有 `ConfigManager`）。
2. **运行**：`spawn('npx', ['-y', '@scope/server@version', ...args], {env})` —— 这步就是「安装+启动合一」。

> 注：`npx -y` 会把包装进 npm 缓存再执行，首次需联网；离线场景或确定性要求下应改为「预装到 `node_modules` 后直接 `node ./node_modules/.bin/<bin>`」或「自带 Node 运行时」。

### 1.4 官方 MCP Registry（增强可信层）——✅ 有，但仅元数据
```
GET https://registry.modelcontextprotocol.io/v0.1/servers
GET https://registry.modelcontextprotocol.io/v0.1/servers/{serverName}/versions
GET https://registry.modelcontextprotocol.io/v0.1/servers/{serverName}/versions/{version}
```
- **只索引不托管**：每条记录指向 npm/PyPI/Docker 实际地址。
- **可信信号**：采用 reverse-DNS 校验命名空间（如 `io.github.user/server`），自带「verified」标记。
- **设计定位**：面向**下游聚合器/子注册表**，不鼓励客户端直连实时调用（仍是 `v0.1` 预览）。→ 本方案建议**构建期/更新期预聚合**成快照，而非运行时 live 调用。

---

## 2. 可行性评估（回答第二个问题）

把你的架构图逐层对照本仓库现状：

```
你的架构图                             本仓库现状（已存在）
─────────────────────────────────────────────────────────────
GUI (React)                          src/renderer/src/pages/*
  └─ IPC                             preload contextBridge + ipcRenderer
Backend (Electron Main)              src/main/index.ts + ConfigManager
  ├─ NPM API / config write          ConfigManager.writeClientConfig（已支持多客户端）
  └─ LLM 编排                        （独立模块，本方案不涉及）
child_process 拉起 npx mcp-server    McpClient.connectStdio → spawn(config.command, args, {stdio,env})
  └─ JSON-RPC over STDIO             McpClient 已实现 initialize/tools/list/tools/call
「插件市场」UI 调 Search/Registry    PlatformAdapter 抽象 + registry.ts（Officical/Smithery）
```

**判定：架构成立，且主干已现成。** 你需要补的两块是：
- **A. 发现层**：新增 `npm` 平台适配器（`searchServers` + `fetchServerDetail`），复用 `PlatformAdapter` 契约。
- **B. 运行层**：把 npm 解析出的 `name@version` 转成 `{command:'npx', args:['-y', name, ...], env}` 写入配置——`McpClient` 已能直接吃这种 config。

唯一需要打磨的弱点是「运行依赖宿主 Node + 运行时联网拉取」（见 Phase 4 加固）。

---

## 3. 更好的方案（回答第三个问题）

在你现有架构之上，按性价比排序的增量增强：

| # | 方案 | 解决什么痛点 | 工作量 |
|---|---|---|---|
| 1 | **官方 MCP Registry 做可信层** | npm 搜索结果鱼龙混杂、无 verified 标记 | 低（构建期聚合 + 徽章） |
| 2 | **自有发现后端**（复用已有 `VITE_REGISTRY_API_URL`） | 避免打包后每个客户端 live 打 npm、限流/缓存/允许清单可控 | 低（已留扩展点） |
| 3 | **自带 Node 运行时**（extraResources 内嵌 node） | 摆脱宿主 Node 依赖、离线可用、确定性 | 中 |
| 4 | **支持 DXT (Desktop Extensions)** | 单文件分发 + 内嵌运行时 + 权限清单，最契合闭源桌面 | 中高（长期方向） |
| 5 | **OS 级沙箱 + 网络出口策略** | npx 零隔离，第三方 server 安全面 | 中（按平台） |

> 推荐优先级：**1 → 2 立刻做；3 在 v1.1 做；4/5 作为产品化路线**。不推翻你现有的 npx 主干。

---

## 4. 可执行落地计划（在 mcp-dock 仓库内）

### Phase 1 — npm 发现适配器（核心缺口）
**新增文件** `src/main/platforms/npm.ts`，实现 `PlatformAdapter`：

```ts
// 复用现有类型契约
import type { PlatformAdapter, PlatformServerListItem,
             PlatformServerSearchPage, PlatformServerDetail,
             PlatformSearchParams, PlatformFacets } from './types';

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const NPM_PKG    = 'https://registry.npmjs.org/';

export const npmAdapter: PlatformAdapter = {
  id: 'npm',
  name: 'npm Registry',

  async searchServers(p: PlatformSearchParams): Promise<PlatformServerSearchPage> {
    const q = `keywords:mcp ${p.query || ''}`.trim();
    const url = `${NPM_SEARCH}?text=${encodeURIComponent(q)}&size=${p.pageSize}&from=${(p.page-1)*p.pageSize}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const json = await res.json();
    const items: PlatformServerListItem[] = (json.objects || []).map((o: any) => ({
      id: `npm-${o.package.name}`,
      name: o.package.name,
      displayName: o.package.name,
      description: o.package.description || '',
      source: 'npm',
      sourceUrl: o.package.links?.npm || `https://www.npmjs.com/package/${o.package.name}`,
      author: o.package.publisher?.username,
      tags: ['mcp'],
      extra: { version: o.package.version, score: o.score?.final },
    }));
    const total = typeof json.total === 'number' ? json.total : items.length;
    return { items, pageInfo: { page:p.page, pageSize:p.pageSize, total, totalPages: Math.ceil(total/p.pageSize), hasMore: p.page*p.pageSize < total } };
  },

  async fetchServerDetail(_p: PlatformSearchParams, serverId: string): Promise<PlatformServerDetail> {
    const name = serverId.replace(/^npm-/, '');
    const meta = await (await fetch(`${NPM_PKG}${name}`)).json();
    const latest = meta.dist-tags?.latest;
    const ver = meta.versions?.[latest] || {};
    const bin = ver.bin ? (typeof ver.bin === 'string' ? ver.bin : Object.values(ver.bin)[0]) : name;
    return {
      id: serverId, name, displayName: name,
      description: ver.description || meta.description || '',
      source: 'npm', sourceUrl: `https://www.npmjs.com/package/${name}`,
      author: meta.maintainers?.[0]?.name,
      install: { command: 'npx', args: ['-y', `${name}@${latest}`], env: {} },
      extra: { version: latest, license: ver.license, engines: ver.engines, bin, readme: meta.readme },
    };
  },

  getFacets() {
    return { categories: [{id:'mcp', name:'MCP'}],
             sortOptions: [{id:'relevance',name:'相关度',field:'score',order:'desc'}],
             supportsSubcategories: false };
  },
};
```

**注册**到 `src/main/platforms/registry.ts` 的 `adapters` 与 `src/shared/platform-constants.ts` 的 `SupportedPlatform`（加 `'npm'`）。
**验收**：商店切到 npm 源能搜出 `keywords:mcp` 的包、点详情能拿到 `npx -y <pkg>` 安装指令。

### Phase 2 — 安装/运行接线（复用现有 McpClient）
- 详情页「安装」按钮 → 调现有 `ConfigManager` 写入该客户端 `config.json`（格式适配器已支持 `command/args/env`）。
- 启动即复用 `McpClient.connectStdio`，传入 `{command:'npx', args:['-y', name, ...args], env}`——**无需改动 mcp-client.ts**（它已处理 Windows `taskkill` 进程树、macOS `detached`、`NODE_OPTIONS` 净化）。

### Phase 3 — 可信增强（官方 MCP Registry）
- 新增 `scripts/aggregate-mcp-registry.mjs`（构建/更新期运行）：拉取 `registry.modelcontextprotocol.io/v0.1/servers`，落盘 `src/main/platforms/data/mcp-registry-snapshot.json`。
- `npmAdapter` 加载快照做 **verified 徽章** + 主页/传输类型补全（仅增强展示，包仍走 npm 下载）。

### Phase 4 — 运行确定性加固（v1.1）
- `package.json` 的 `extraResources` 增加内嵌 Node（便携版），运行时 `install.command` 改指向 `process.resourcesPath/node.exe`（Windows）/`node`（macOS），`args` 改为 `['<app>/node_modules/.bin/<bin>']`，**不再依赖宿主 npx 联网**。
- 失败兜底：内嵌 Node 不可用时回退到现有 `getEnhancedPath()` 找宿主 npx。

### Phase 5 — 商店 UI 接线
- 复用 `src/renderer/src/pages/PlatformServerDetail.tsx`、`Library.tsx` 已有组件；在源切换器里增加 `npm` 选项卡（仿 Smithery 选项卡）。
- 详情页渲染 `install.command/args` 与 `extra.license`（**每个第三方 server 自带 license，需在此展示**——与已落地的《第三方开源许可声明》形成运行时自动汇总）。

### Phase 6 — 合规收尾（衔接已有 license 工作）
- 动态安装的每一个 MCP server 都有独立 license。建议在「安装完成」时，把其 `license` 字段追加进运行时生成的 `THIRD_PARTY_LICENSES`（或独立 `installed-mcp-licenses.json`），避免 GPL/MIT 等义务被遗漏。
- 注意：配置/拉起第三方 server 属**独立进程**，不会让主程序「传染」成 GPL；但**若把 server 代码打进安装包**，则须履行该 server 的 notice 义务。

---

## 5. 推荐目标架构（最终形态）

```
┌─────────────── 渲染层 (React) ───────────────┐
│  商店 UI（npm 选项卡）│详情页│安装按钮          │
└───────────────┬──────────────────────────────┘
                │ IPC (contextBridge)
┌───────────────▼──────────────────────────────┐
│  主进程 (Electron Main)                        │
│  ├─ npmAdapter.searchServers / fetchServerDetail│  ← 新增（Phase 1）
│  ├─ 自有发现后端代理 (VITE_REGISTRY_API_URL)    │  ← 已支持（Phase 3 可选）
│  ├─ MCP Registry 快照 (verified 徽章)          │  ← 新增（Phase 3）
│  ├─ ConfigManager.writeClientConfig           │  ← 已支持（Phase 2）
│  └─ McpClient.connectStdio                    │  ← 已支持（npx/JSON-RPC）
└───────────────┬──────────────────────────────┘
                │ spawn (内嵌 Node 或宿主 npx)
        ┌───────▼───────────┐   沙箱(Phase 5)
        │  mcp-server 子进程  │ ────────────────► OS 沙箱 + 网络出口策略
        │  JSON-RPC over STDIO│
        └────────────────────┘
   包来源：npm Registry（权威元数据/下载）· 官方 MCP Registry（可信增强）
   长期：DXT 单文件分发（内嵌运行时 + 权限清单）替代/并存 npx
```

---

## 6. 下一步建议
1. **立即做**：Phase 1（npm 适配器）+ Phase 2（接线），半天可出可搜可装的最小闭环。
2. **本周**：Phase 3（可信徽章）+ Phase 5（UI 选项卡）。
3. **产品化**：Phase 4（自带 Node）+ Phase 6（自动 license 汇总）+ 沙箱。

需要我**直接把 Phase 1+2 的代码写出来接进现有商店**吗？按你之前定的协作规范，我会先出小步 plan 再动手，等你确认。
