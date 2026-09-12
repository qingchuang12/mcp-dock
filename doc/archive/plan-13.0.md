# plan-13.0 · 单一活动计划（A10 百炼接线 + E2 ModelScope 退避 + electron:dev 修复）

> 版本：14.2（2026-09-12 模块 G 实施：百炼「全部」哨兵值大小写修复——商店-MCP-百炼空列表）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-10.0.md](archive/plan-10.0.md)、[archive/plan-11.0.md](archive/plan-11.0.md)、[archive/plan-12.0.md](archive/plan-12.0.md)。
> 合并来源：plan-14.0（electron:dev 诊断）已并入本 plan 后删除。

## 规则（plan 管理铁律）
- `doc/` 下**同一时刻只保留一个活动 plan**（本文件）；新任务合并进本 plan，不另起 `plan-NN.N.md`。
- 任务**已执行完结** → 归档到 `doc/archive/`（plan 与 audit 一并归档）；**未执行** → 合并进活动 plan。
- 每次软件调整：细化进 plan → 确认 → 执行 → 归档检查。

---

## 模块 A · A10 百炼接线 + E2 ModelScope 退避（已实施并验证）

决策（2026-09-11 拍板）：A10 = **接线启用**；E2 = **加连接级退避**。

### A10 实施（接线启用）
- `src/shared/platform-constants.ts`：`PlatformType` 增 `'bailian'`；`PLATFORM_META` 增 `bailian:{label:'百炼',defaultBaseUrl:'https://bailian.console.aliyun.com'}`；`MCP_PLATFORM_TYPES` 增 `'bailian'`；`BUILTIN_MCP_SOURCE_IDS` 增 `bailian:'mcpsrc_bailian'`。
- `src/main/connections-store.ts`：`builtinMcpSeeds()` 增百炼 seed 连接（`kind:'mcp'`、`platformType:'bailian'`），使百炼在「商店 → MCP 源」默认可见、可浏览 251 条离线索引。
- `src/renderer/src/components/McpSourceManager.tsx`：`builtinIds` 增 `BUILTIN_MCP_SOURCE_IDS.bailian`（内置不可删，与 smithery 一致）。
- **icon URL 404 修复**：`bailian-index.json` 的 `icon` 全是占位死链（`img.alicdn.com/imgextra/iN/O1CN01N.png`，实测 HTTP 404）。`bailian.ts` 的 `mapServer` 改为 `iconUrl: undefined` → UI 回退首字母头像，不再每张卡片发一次 404 请求。

### E2 实施（ModelScope 连接级退避）
- `src/main/platforms/shared.ts`：新增 `MODELSCOPE_RETRY_DELAYS_MS = [1500, 4000]`；`fetchJson` 与 `fetchWithRetry` 的固定退避（400/800ms）改为**可配置 `retryDelaysMs`**（默认 `[400,800]`，其它平台行为不变）；`probeEndpoints` 透传 `retryDelaysMs`。
- `src/main/platforms/modelscope.ts`：`probeEndpoints(...)` 与 `fetchJson(...)` 均传入 `MODELSCOPE_RETRY_DELAYS_MS` → ModelScope 新建连接抖动时首跳等待由 0.4s 升至 1.5s/4s，缓解上游 33–50% 新建连接超时导致的整页「请求失败」误报。

### 验证证据
- `tsc -p tsconfig.main.json --noEmit` 与 `tsc -p tsconfig.json --noEmit` → **exit 0**（主进程 + 渲染进程均干净）。
- `vitest run`（全量）→ **28 文件 / 397 测试全绿，exit 0**。

- [x] A10 接线实施 + icon 404 修复
- [x] E2 ModelScope 连接级退避实施

---

## 模块 B · electron:dev 无窗口修复（已定位 → 修复 → 验证）

### B.1 现象
`pnpm run electron:dev` 终端正常拉起（concurrently: dev:main / dev:renderer / electron），但**没有任何窗口弹出**。

### B.2 根因（两处，均已确证）
本故障由**两个相互独立的环境问题**叠加造成，缺一不能修好。

**B.2.1 `ELECTRON_RUN_AS_NODE=1` 环境变量污染**
宿主 IDE / Electron 桌面应用把它注入环境并被子进程继承。该变量一旦存在：
- `electron.exe` 退化为**纯 Node 运行时** → 不启动浏览器进程；
- `require('electron')` 不再被拦截，回退为 npm 包的 shim（返回可执行文件路径**字符串**）；
- `app` / `BrowserWindow` 全为 `undefined`。

→ `src/main/index.ts` 模块顶层的 `getCacheManager()`（早于 `app.whenReady()`）执行 `app.getPath('home')` →
`TypeError: Cannot read properties of undefined (reading 'getPath')` → 主进程**建窗前即死**。

**B.2.2 Chromium 沙箱在受限父进程环境下不可用（决定性的一条）**
即便清了 B.2.1，从 IDE 内嵌终端 / 受限 job 对象派生的 Electron，其**沙箱化 GPU 子进程会被反复终止**，Chromium 随即以
`FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:416] GPU process isn't usable. Goodbye.` 整体退出
（exit code `2147483651` = `0x80000003`），**窗口来不及显示**。

**关键澄清（此前误判已纠正）**：Electron 43 官方发行包**本就只含 `resources/default_app.asar`，不含 `electron.asar`**
（缓存 zip 150MB / 75 条目解析确认）。故「electron.asar 缺失」是**正常布局**，与本次故障无关；electron 安装一直完好。

### B.3 诊断证据链
1. 编译健康：双 tsc 0 error；`dist/main`、`dist/renderer` 产物存在；Vite 5173 与 `wait-on`/`loadURL` 一致。
2. 无孤儿实例：`tasklist` 无残留 electron/vite → 排除单实例锁静默退出。
3. **最小 Electron app 探针**：未清理环境时 `require('electron')` → 字符串、`app` undefined；**删除 `ELECTRON_RUN_AS_NODE` 后** → `app` object、`WINDOW_CREATED=true`。
4. **缓存 zip 解析**：`electron-v43.0.0-win32-x64.zip` 共 75 条目，`resources/` 仅 `default_app.asar` → 证明 electron.asar 缺失属官方正常布局。
5. **开关矩阵（真实 app，清环境后逐项实测）**：

| 启动开关 | 结果 |
|---|---|
| 无 | 崩溃（`GPU_FATAL=true`） |
| `--disable-gpu` | **仍崩溃** → 问题在**沙箱**，不在 GPU |
| `--no-sandbox` | **存活 ✅（最小充分开关）** |
| `--disable-gpu --no-sandbox` | 存活 ✅ |
| `--in-process-gpu` | 存活 ✅（备选） |

6. **排除环境变量诱因**：极简 21 键环境、无开关 → 仍崩溃；全量环境删除全部 `ELECTRON_*` / `CHROME_*` / `GOOGLE_*` → 仍崩溃。
   → 沙箱失败源于**进程上下文**（受限父进程 / job 对象），不是某个变量，故必须用启动开关解决而非清变量。

### B.4 修复（已实施）
- 新增 `scripts/electron-dev-launch.cjs`：
  1. 拉起前 **`delete env.ELECTRON_RUN_AS_NODE`**；
  2. 开发启动**默认追加 `--no-sandbox`**（可用 `ELECTRON_DEV_KEEP_SANDBOX=1` 关闭，或显式传 `--sandbox` 保留）；
  3. 把子进程 stdout/stderr 与启动信息写入 `<项目根>/electron-dev.log`；对 `exit 2147483651` 打印定位提示，便于无窗口时取证。
- `package.json`：`start` → `node scripts/electron-dev-launch.cjs .`；`electron:dev` 的 electron 段 → `... node scripts/electron-dev-launch.cjs .`（`cross-env VITE_DEV_SERVER_URL=...` 仍在外层，变量正常透传）。
- **仅作用于开发启动**，不影响 electron-builder 打包产物（打包后从资源管理器正常启动，沙箱可用、保持默认开启）。

### B.5 验证证据（父进程仍带 `ELECTRON_RUN_AS_NODE=1`）

| 场景 | 结果 |
|---|---|
| 包装器启动真实 app（生产分支） | `LAUNCHER_STATUS=ALIVE_AFTER_9000ms`、`GPU_FATAL=false`、`GETPATH_CRASH=false`；日志确认 `args=[".","--no-sandbox"]` 且已清理 `ELECTRON_RUN_AS_NODE` |
| 包装器启动（**dev 分支**：`VITE_DEV_SERVER_URL` 已设 → `loadURL()` + `openDevTools()`） | `ALIVE_AFTER_9000ms`、无 GPU 致命退出；stderr 仅 `ERR_CONNECTION_REFUSED`（因未启 Vite，属预期） |

- [x] B 修复（包装器清 `ELECTRON_RUN_AS_NODE` + 开发追加 `--no-sandbox`）并验证

### B.6 第三次定位：**真因 = `wait-on tcp:5173` 卡死（IPv6/IPv4 地址族错配）**

**现象升级**：完成 B.2.1 + B.2.2 修复后，川哥反馈「**仍无窗口，且没有生成 `electron-dev.log`**」。

**`electron-dev.log` 缺失本身就是决定性线索**——launcher 在 spawn Electron *之前*就建日志，log 不存在 ⇒ **launcher 从未执行** ⇒ 卡点必在它上游。

**取证（进程 + 端口快照，非猜测）**：

| PID | 进程 | 启动 | 状态 |
|---|---|---|---|
| 14304 | `pnpm.mjs run electron:dev` | 23:57:19 | 运行中 |
| 14440 | `concurrently -k "dev:main" "dev:renderer" "wait-on tcp:5173 && …"` | 23:57:24 | 运行中 |
| **7632** | **`wait-on tcp:5173`** | 23:57:25 | **卡住 8 分钟以上** |
| 25260 | `tsc -p tsconfig.main.json --watch` | 23:57:25 | 正常 |
| 23364 | `vite.js` | 23:57:25 | 正常，监听 5173 |

即 `concurrently` 三路子进程里 `dev:main` / `dev:renderer` 都正常，唯独 **`wait-on tcp:5173` 永不放行**。

**根因**：`vite.config.mts` 只写了 `server:{port:5173}`、**未指定 host**。Vite 按 `localhost` 解析后**只绑定了 IPv6 回环 `[::1]:5173`**（netstat 实证：`TCP [::1]:5173 LISTENING 23364`，**无 IPv4 行**）。而 `wait-on tcp:5173` 走 IPv4 `127.0.0.1` ⇒ 连接被拒 ⇒ **无限重试** ⇒ `&& node scripts/electron-dev-launch.cjs .` 永不执行 ⇒ **无窗口 + 无 `electron-dev.log`**。

**证据闭环**：
- 补齐 IPv4 监听后，**同一个 `wait-on tcp:5173` 立刻放行**，launcher 随即执行（log 生成），Electron 主进程出现且 `MainWindowTitle=AI-Tools`、`MainWindowHandle=1246848`（**真窗口**）。
- 端到端复验：`wait-on tcp:127.0.0.1:5173 => RESOLVED`；launcher `args=[".","--no-sandbox"]`、`已清理环境变量=ELECTRON_RUN_AS_NODE`，无 `getPath` 崩溃、无 GPU 致命、无 `ERR_CONNECTION_REFUSED`。
- 另有 **静默端口漂移** 隐患：若 5173 已被占，Vite 会静默改用 5174（实测日志 `Port 5173 is in use, trying another one... → 5174`），而闸与地址仍指 5173 → 同样静默挂死，且渲染进程可能连到残留旧实例。

### B.7 真因修复（已实施）
- `vite.config.mts` → `server: { host: '127.0.0.1', port: 5173, strictPort: true }`
  - 显式绑 IPv4，消除与 `wait-on` / Electron 的地址族错配；
  - `strictPort: true` 让「5173 被占」**直接报错退出**，而不是静默漂到 5174 再挂死。
- `package.json`（`electron:dev`）→ 闸与地址均改显式 IPv4：`wait-on tcp:127.0.0.1:5173`、`VITE_DEV_SERVER_URL=http://127.0.0.1:5173`。
- `src/main/index.ts`：dev 兜底地址同步为 `http://127.0.0.1:5173`，与 vite 配置一致。

- [x] B 真因修复（vite 绑 `127.0.0.1` + `strictPort`；`wait-on` / URL 显式 IPv4）并验证

---

## 模块 C · 「安装 MCP → 无需配置」空态美化（已实施并验证）

### C.1 现状与问题
`src/renderer/src/components/ConfigForm.tsx:84-106`：schema 无任何配置项时，只渲染一行居中灰字 + 两个按钮，**无容器、无层级、无图标** → 视觉上「飘」在弹窗里（川哥反馈的「太丑」）。另暴露两个隐性缺陷：
1. **硬编码英文** `No configuration required`，而 locale 里早已存在 `detail.noConfigRequired`（zh：「无需配置，点击安装即可继续。」）却从未被引用 → 中文界面混入英文；
2. 其上方 `detail.configDescription`（「安装前请配置服务器设置」）在无配置项时与空态文案**语义矛盾**。

### C.2 改法（对齐既有空态范式）
以 `components/store/StoreEmptyState.tsx` 为同源范式（`w-14 h-14` 圆形徽标 + `text-[15px] font-medium` 标题 + `text-[13px] muted2` 说明），按弹窗尺寸等比缩小：
- **ConfigForm 空态改为卡片式容器**：`rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]` —— 弹窗 body 本身是 `--color-surface`，用 `--color-bg` 形成内嵌「井」的层次（暗色 #1c1c1e on #2c2c2e、浅色 #f2f2f7 on #ffffff，两主题都成立）；
- **徽标**：`w-11 h-11 rounded-full bg-success/10` + 绿色对勾 SVG（`text-[var(--color-success)]` 跟随主题）。语义为**就绪态**（不需要任何操作），故用 success 而非 accent 蓝；
- **文案**改用 i18n key `t('detail.noConfigRequired')`（`text-[13px] font-medium leading-relaxed`），顺带修掉硬编码英文；
- **按钮**补 `cursor-pointer`（本文件 4 处；项目既有 13 个组件均如此写，`.btn` 全局未设）；
- `pages/Detail.tsx`：新增 `hideConfigDescription`（`isSmitheryDetail(server)` 且 `schema.properties` 为空）→ 无配置项时不渲染那句矛盾说明。

### C.3 验证证据
- `tsc -p tsconfig.json --noEmit` → **exit 0**；`tsc -p tsconfig.main.json --noEmit` → **exit 0**。
- `vite build`（renderer）→ **exit 0**（built in 27.67s）。
- **产物实证**（不只看「构建通过」）：
  - `dist/renderer/assets/*.css` 含 `.bg-success\/10{background-color:#34c7591a}` → 确认透明度变体真的产出 CSS，而非被 Tailwind 丢弃（`/10` 打在 CSS 变量上才容易失效，此处用的是 theme 里的 hex，安全）；
  - `dist/renderer/assets/*.js` 含新对勾路径 `9 12.75 11.25 15 15 9.75` → 图标已进产物。
- 说明：本机无显示会话，**视觉最终确认需川哥在窗口内过目**。

- [x] C 「无需配置」空态美化 + i18n 修正 + 消除上方矛盾文案

## 模块 D · 商店 Skills 标签/分类显示（ClawHub 已修，SkillsMP 待拍板）

### D.1 问题 1 · SkillsMP 源没有分类筛选（**待川哥拍板**）
**现象**：商店 → Skills 页，数据源切到 SkillsMP 时，工具栏的分类下拉框**不出现**（其它源都有）。
**根因（实测确证，非代码缺陷，是上游约束）**：
- 该下拉框由 `facets.categories.length > 0` 驱动（`StoreToolbar.tsx:160`）；`skillsmp.ts:142 getFacets()` 返回 `categories: []` → 不渲染。
- 为什么不声明分类？**上游 API 根本不支持分类过滤，且条目里没有分类字段**：
  1. `GET /api/skills?search=&category=<slug>` → **400**；
  2. `GET /api/skills?...&categorySlug=development` / `=finance` / `=testing` → **200 但结果与不带分类完全一致**（逐条比对 id 序列，`same=true`）→ **参数被静默忽略**（与 `sortBy=stars` 同类的「200 假成功」陷阱）；
  3. 列表条目字段只有 `id/name/author/description/contentLanguage/githubUrl/stars/forks/updatedAt/path/branch/route`，**无 category** → 客户端也无从筛选；
  4. `/api/categories`、`/api/skills/categories`、`/api/skills/facets` → 全部 **404**。
- 站点确有分类体系（`/categories/<slug>`，共 **75** 个 slug，如 development/testing/git-workflows/llm-ai），但只存在于 **Next.js 服务端渲染页面**里，未开放对应 JSON 接口。
- 佐证：`zh.json`/`en.json` 里早就有一组 `skillCategory.skillsmp.*`（architecture-patterns/mcp-integration/rag…），但 `SkillCard` 走的是**扁平** `skillCategory.${id}` 查找 → 这组键**永远命中不到**，属历史遗留死配置（说明曾有同类意图后搁置）。

**可选方案（请择一）**：
| 方案 | 做法 | 代价 |
|---|---|---|
| A · 关键词映射过滤 | 参照 smithery 既有做法（`SMITHERY_CATEGORY_QUERIES`）：分类 → 搜索关键词，改分类即改 `search` | 结果真实变化，但**只是近似**（关键词命中，并非真分类）；有「伪分类」观感风险 |
| B · 维持现状 | 不显示分类控件 | 与其它源不一致，但**数据诚实**（符合 plan-10.0「不挂假控件」原则） |
| C · 抓分类页 | 解析 `/categories/<slug>` 的 RSC 载荷 | 页面含技能链接但**缺 stars/描述等元数据**，且属 HTML 抓取，脆弱、易烂 |

- [x] D1 SkillsMP 分类筛选 → **方案 D：接入上游真实分类**（旧 A/B/C 三个近似方案全部作废，上游本就支持真过滤；详见模块 F）

### D.2 问题 2 · ClawHub 列表标签显示不正常（**已修复并验证**）
**现象**：ClawHub 卡片上的分类标签**几乎全部显示为原始英文小写 id（research/other/finance…）且一律灰底**，与其它源的中文彩色标签格格不入；个别无分类条目还会渲染出一个**没有文字的空标签**。
**根因（实测 100 条真实数据 + 渲染链路复现）**：
1. **缺翻译**：ClawHub 下发 14 类分类 id（integrations/automation/research/development/productivity/communication/creative/knowledge/agents/operations/security/finance/lifestyle/other），而 `skillCategory` 只有内置 8 类；`localizeKey(t, i18n, 'skillCategory.'+id, id)` 找不到键 → **回退成原始 id**。实测 40 条中 100% 的标签全部回退（finance 26 / other 8 / research 4 / development 3 / communication 2 / automation / integrations / operations 各 1）。
   *反证*：同一批分类在**下拉框**里是中文的（`CLAWHUB_CATEGORIES` 自带 name），只有**卡片标签**是英文 → 典型的「一处配了、另一处漏了」。
2. **缺配色**：`getCategoryColor` 只覆盖内置 8 类 → ClawHub 分类全部落 `colors[id]` 未命中 → 走灰底兜底。
3. **空标签**：`SkillCard` 旧逻辑 `rawCategories.length ? [...] : [skill.category]`，而 `skill.category` 为 `undefined` 时 → `catList = [undefined]` → 渲染出**无文字的标签**。实测 100 条中有 1 条（`a-b-test-design` 无任何分类）命中。
4. **潜在类型坑**：`clawhub.ts` 的 `raw.native?.skill?.categories || … || raw.tags` 回退链，而 Convex 真实结构里 **`tags` 是对象**（`{latest: <versionId>}`）而非数组 → 一旦上游某条缺 `categories`，`extra.categories` 会变成对象，客户端分类过滤 `cats.includes(...)` 将**直接抛 TypeError**，`getFacets` 统计也会误处理。
**改法**（5 处，均最小侵入）：
- `locales/zh.json` + `en.json`：`skillCategory` 补齐 12 个 ClawHub 分类（productivity/security 已有，不重复）。
- `SkillCard.tsx`：`getCategoryColor` 增加 11 个 ClawHub 分类配色（other 保留灰底兜底）；`catList` 改为**仅收非空字符串**，无分类时不再产出空标签。
- `clawhub.ts`：新增 `toCatArray` / `pickCategories`，把分类收敛为「非空字符串数组」，并**彻底移除 `raw.tags` 回退**（`tags` 是对象，不是分类）；`mapEntry` / `getFacets` / 两处客户端过滤统一走它。
**验证证据**：
- 真实数据终验（60 条）：修复前 `[research]`/`[other]`/`[finance]` → 修复后 `[研究🎨]`/`[其他▫️]`/`[金融🎨]`；未本地化标签 **0**，空标签 **0**。
- `tsc -p tsconfig.json --noEmit` → exit 0；`tsc -p tsconfig.main.json --noEmit` → exit 0。
- `vitest run` 全量 → **397 passed，exit 0**（含 `clawhub.mapEntry` / 离线缓存 / NASTY_INPUTS 全部通过）。
- `vite build`（renderer）→ exit 0；产物 CSS 实证 9 个新色类全部产出（`bg-indigo-500\/15` … `bg-amber-500\/15` 均 FOUND）。
- 说明：本机无显示会话，**最终视觉需川哥在窗口内过目**。

**顺带发现（未改，待定）**：ClawHub 卡片作者一律显示 `@clawhub`——`mapEntry` 里 `extra.author = raw.author`，而 Convex 顶层**没有 `author`** 字段，`useSkillsData.ts:16` 便回退到 `item.source`。修法只需一行：`extra.author: raw.author || ownerHandle`（`ownerHandle` 已算出），改后显示 `@rhyssullivan` 这类真实发布者。**是否一并修复请示意。**

- [x] D2 ClawHub 标签本地化 + 配色 + 空标签/类型坑加固（实施 + 验证）
- [x] D2b ClawHub 卡片作者改真实 ownerHandle（2026-09-12 实施 + 验证）

---

## 模块 E · 源能力核查与完善（ClawHub 排序 / 百炼 / SafeSkill / schemas）

四项一次性核查（川哥指令：能修则修、不能修则移除）。**结论全部实测取证，不靠读码推断。**

### E1 · ClawHub 排序 → **可用，保留**（不修不删）

- 上游 Convex RPC **拒绝任何排序参数**：`sort` / `sortBy` / `orderBy` 一律 `status:error`「Server Error」（实测 4 组参数全失败）。
- 但适配器做的是**客户端排序**（`clawhub.ts` 搜索路径与离线回退路径各一处），`CLAWHUB_SORTS` 的 `relevance` / `downloads` / `updated` 与分支一一对应，id 无错配。
- 实测首屏顺序确实改变：`downloads` → 首条 `answeroverflow`(dl=22466)；`updated` → 首条 `a-b-test-design`(up=1789139610366)；默认序首条是 `answeroverflow` 之外的 `ricketh137/a`。
- 缓存键已含 `sort`（`search-cache.ts:54`），**不存在**「切换排序命中旧缓存」的假象。
- **结论：排序真实生效 → 保留**。诚实范围：仅对已抓取窗口（≤100 条）重排，`total` 为 null、非全库排序。

### E2 · 百炼 MCP 源 → **补齐两处缺陷**（已实施）

与 `npm` / `modelscope` 逐项对照（搜索/分页/详情/分类中文名/来源过滤/离线索引 均一致），百炼缺 2 项：

1. **排序静默失效（双重 bug）** — `bailian.ts` 旧实现把 **sort 的 id 当字段名**用：
   - `(a as any)['users']` 取的是不存在的键 → `undefined` → `0`，比较器**恒返回 0** → 顺序不变；
   - 方向又硬编码 `sort==='users' ? -1 : 1`，与 `BAILIAN_SORTS` 标注的 `order:'desc'` **相抵**，即便取到字段也会反向。
   - 实测：`users` 结果 **== 原始顺序**（即排序完全没生效）。
   - 修复：以 `BAILIAN_SORTS` 为唯一事实源，用 `field` / `order` 解释排序 id。
2. **「测试连接」假绿** — 百炼是离线索引源（零网络），但 `PLATFORM_HEALTH_PATHS` 无 `bailian`，旧 `|| ['/']` 兜底会去探控制台首页 → 200 即标「连接成功…搜索时将回退页面解析」（承诺了不存在的能力）。通用修复见 E3。

修复后实测 `users` 前 5：`外卖订餐 2`(544171) / `电影票务 2`(519889) / `电子签章 4`(509066) / `出行打车 5`(507474) / `Elasticsearch检索 3`(476877) → **== 正确降序 ✓**

### E3 · SafeSkill → **源本身不可修复；但暴露并修掉一个通用假绿 bug**

- **不可修复（已复核）**：`safeskill.cn` 只有 SPA 壳页 —— `/` → 200 `text/html`；`/v1/search`、`/api/v1/search`、`/api/skills`、`/api/v1/skills` **全部 404**；`registry.ts` 无 adapter（`getAdapter('safeskill') === null`）。与 2026-09-10 的记录一致。
- **但发现两处可修缺陷**：
  1. **探活分支是死代码**：旧 `const paths = PLATFORM_HEALTH_PATHS[t] || ['/']` 中的 `|| ['/']` 让 `paths` **恒非空**，使紧随其后的 `if (targets.length === 0)`（注释明写「如实报告无法验证」，D9 用例也据此断言）**永远不可达**。后果：safeskill 探首页拿 200 → 被标「连接成功」——正是该修复本想避免的假绿，**被同一行的兜底抵消了**。
  2. **商店退化为通用错误态**：`platforms:search-skills` 对无 adapter 的平台直接 `throw` → react-query 转成 `data.error` → 渲染 `StoreErrorState`（通用「加载失败/重试」），把「上游没有这个能力」误导成「故障」。其它源走的是 `unsupported: true` → 如实的空态。
- **修复**：
  - `connections-store.verify()` 去掉 `|| ['/']`；未配置探活路径时**不发起任何请求**，按平台性质给结论——离线索引源（bailian）→ `active` +「使用内置离线索引，无需网络连接」；无公开接口（safeskill）→ `error` +「未开放可用的公开接口，无法验证」。
  - `index.ts platforms:search-skills`：未知类型仍 `throw`（不把类型错误伪装成「平台不支持」）；**已知类型但无 adapter / 无 skill 搜索能力 → 返回 `unsupported: true`**，与其它源语义统一。
- **川哥拍板（2026-09-12）**：见 E5。

### E5 · SafeSkill 从可选源清单下线（已实施）

川哥拍板「safeskill 去掉吧」。采用**与 `'custom'` 相同的收口方式**（代码里已有先例与注释）：

| 处置 | 对象 | 原因 |
|---|---|---|
| **移除** | `SKILL_PLATFORM_TYPES` 里的 `'safeskill'` | 不再能新建该源（核心诉求） |
| **保留** | `PlatformType` 联合类型 + `PLATFORM_META.safeskill` | **存量连接仍要能渲染**：`SourceManager` 的 `unknownPlatformFallback` 分支把「类型不在清单里的存量连接」降级为只读 div，其文案取自 `platformLabel()` → `PLATFORM_META[type].label`；一并删除会让它显示成原始 slug `safeskill` |
| **保留** | `registry.ts` 不注册 adapter | 存量连接的查询继续走 `unsupported: true` 如实空态，而非通用错误态 |
| **保留** | `resolvers/dispatch.ts` 的 safeskill 候选端点、`url-detect.ts` 的域名映射 | 服务存量连接的「粘贴 URL 解析」路径；删掉会让该路径反而报错 |

**同批清理的陈旧引用**：`ServerCard.tsx` 的平台源清单去掉 `'safeskill'`（该源无 adapter、永不产出条目，属死引用）；zh/en locale 两处把它当「可添加的 Skill 源」宣传的文案（`emptySkillNoConnectionsDesc`、令牌导入 `desc`）改为不再列举 SafeSkill；`registry.ts` 与 `PLATFORM_HEALTH_PATHS` 的注释补上「已下线」标注。

**存量数据安全性**：`connections-store.migrate()` 只在 `c.id === 'mcpsrc_official'` 时过滤（Official 是内置源），**不按 platformType 过滤** → 用户手建过的 safeskill 连接会原样保留，可正常查看/删除。

### 验证证据
| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.main.json --noEmit` | exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `vitest run` 全量 | **28 文件 / 406 用例通过**，exit 0（含 E5 新增 3 条守卫） |
| 百炼排序前后对照（真实 251 条索引） | OLD `users` == 原始顺序（失效）→ NEW == 正确降序 ✓ |
| 探活决策树对照 | bailian / safeskill 均为「未配路径」：OLD 探首页（假绿）→ NEW 不探测（`active` / `error`） |
| `platform-adapters.test.ts` 单文件 | 56 passed |

> 注：全量套件曾出现 1 例偶发失败，复跑即 406/406 全绿 —— 与既往记录过的 `env-manager > checkNpx` 并行负载抖动同源，非本次改动引入。

- [x] E1 ClawHub 排序核查（结论：可用，保留）
- [x] E2 百炼排序静默失效修复 + 探活假绿修复
- [x] E3 SafeSkill 可修复性核查（源不可修 → 退化为如实空态）+ 探活死代码修复
- [x] E4 schemas/ 删除（零引用）
- [x] E5 SafeSkill 从 `SKILL_PLATFORM_TYPES` 下线（保留类型/META 以兼容存量连接；实施 + 验证）

---

## 模块 F · SkillsMP 分类体系探查 → D1 定案（2026-09-12）

川哥给线索：「探查一下看看 `https://skillsmp.com/api/skills?_sv=6&cursor=start&limit=12&sortBy=stars&category=backend`，网站的页面是支持分类的」。

### F.1 结论：**旧结论「SkillsMP 不支持分类」是错的，上游真实支持**

之前（plan-8.0 U4 / plan-10.0）判定「无分类能力」，是**三次踩坑叠加**，并非上游没这功能：

| 旧测法 | 真实原因 |
|---|---|
| `?search=&category=<slug>` → 400 | **`search` 空串本身就会 400**（`INVALID_QUERY`），与 category 无关，属误伤 |
| `?categorySlug=development` → 200 但结果不变 | **参数名错了**，正确名是 `category`；错名被静默忽略 |
| 站点 75 个 slug 里 `development`/`tools` 等 → 400 | 这些是**父级分组**，API **只认叶子分类** |

### F.2 实测证据（本轮复测，200/400 均可复现）

- `?limit=3&category=backend` → **200**：`total=68569`、`totalIsExact=true`，返回条目确为后端语义（`backend-patterns`/`django-patterns`/`laravel-patterns`/`api-design`/`mcp-server-patterns`）；不带 category 时 `total=1200` 且 `isCapped=true, continuationUnavailable="index-not-ready"` —— **结果集与计数都不同，过滤真实生效**。
- `category=<非法值>` → **400 `{"error":"Invalid category filter","code":"INVALID_CATEGORY"}`**：是可枚举**白名单**而非静默忽略 → 可据此反推合法集。
- 参数开关矩阵：`_sv=6` **非必需**；`cursor=start` 只影响 `total` 统计口径（68569 vs 480），**前 N 条顺序与 id 完全一致**；`category` 与 `search` 可叠加（`search=skill&category=backend` 收窄）。
- `category=`（空串）→ **400**，故请求前必须判空、**不拼空占位**。

### F.3 权威分类清单（来源：上游 MCP `list_categories`，非猜测）

`POST https://skillsmp.com/mcp`（无状态、无每日配额；需 `MCP-Protocol-Version: 2025-06-18` 头）返回**两级结构**：

```
domains[12] → { domain(父 slug), domainName, categories[{slug, name, count}] }
```

- **12 个父域**：blockchain / business / content-media / data-ai / databases / development / devops / documentation / lifestyle / research / testing-security / tools
- **63 个叶子分类**（3+8+4+4+3+11+5+3+6+6+3+7 = 63），带官方 name 与 count
- **交叉验证**：站点 `/categories` 页 75 个链接中，锚文本为 `Browse <X>` 的 **12 个恰好就是被 API 拒绝的 12 个父域**；其余 63 个（锚文本带 `N skills`）**与实测返回 200 的 slug 集完全一致**。两条独立路径互证。
- 附带发现：上游有**官方文档化接口** `GET /api/v1/skills/search`（`openapi.json`、`/api/llms.txt` 均指向它），参数 `q`(必填)/`page`/`limit`/`sortBy`(枚举 `stars`,`recent`)/`category`/`occupation`/`language`；**匿名限流 50 次/天、10 次/分钟**（本轮探测中途 429 即源于此）。当前适配器用的 `/api/skills` 是未文档化端点，但它**同样支持 `category`**，故无需迁移即可接分类。

### F.4 顺带查实的排序真相（推翻旧注释）

| sortBy | 实测结果 |
|---|---|
| 不带 / `stars` | **真实生效**（stars 严格降序 389030→68803→61507…），且 `stars` 是上游**默认** |
| `recent` | **真实生效**（updatedAt 降序） |
| `relevance` / `downloads` / `updated` | 被静默忽略（响应 `filters.sortBy` 回显仍是 `"stars"`），与 stars **完全同序** |

→ 旧注释「只有 recent 生效、stars 是假排序」**半对半错**。真实缺陷是：**UI 暴露的「相关度」在上游根本不存在（实为 stars 序）= 假控件；而真正有效且是默认的「Star 最多」反而没暴露**。

### F.5 实施（川哥确认「开始实施」，2026-09-12 已全部完成）

| # | 改动 | 实施要点 |
|---|---|---|
| F-a | `skillsmp.ts` 新增 `SKILLSMP_CATEGORIES`（**模块私有，不导出**） | 12 父域 + 63 叶，叶带官方 count；注释标明来源（MCP `list_categories` 2026-09-12 快照）与「父域仅作分组、不可过滤」 |
| F-b | `searchSkills` 分类白名单 + **四组合模板** | 见 F.7-1 的坑；`validCategory = category && SKILLSMP_CATEGORY_IDS.has(category) ? category : ''` |
| F-c | `getFacets()` 返回分类树 + `supportsSubcategories: true` | 与 npm 的既有声明对齐 |
| F-d | `StoreToolbar.tsx` 分类下拉支持 `<optgroup>` | 有 `children` 的节点渲染为分组标签（父域不可选），平铺类目行为不变，其余 8 个源零影响 |
| F-e | `SKILLSMP_SORTS` → `stars`(星标最多) + `updated`(最近更新)，**下线假控件「相关度」**；映射 `updated→recent`，其余（含应用层默认 `relevance`）省略参数 = 上游默认序 | 见 F.4 |
| F-f | 删除死配置 `skillCategory.skillsmp.*`（zh/en 各 15 键） | 三处消费点（`SkillCard`/`SkillDetail`×2）均为扁平 `skillCategory.${id}`，嵌套块永不命中，确认死配置后删除 |

**同批顺带（F-e 的必要收尾）**：`StoreFilterBar.tsx` 增加**仅显示层**的排序值兜底 —— 应用默认 `storeSort='relevance'` 而部分源无此排序（SkillsMP/Coze/百炼），受控 `<select>` 的 value 匹配不到选项会 React 告警且显示空白；现回退显示首个选项、**不改写 sort 状态**，请求语义不变。

**明确不做**：不把「选中的分类」回填到条目上（`mapEntry.category` 保持透传服务端值）——条目本身无分类字段，回填等于给结果贴标签（沿用 plan-10.0 原则）。

### F.7 验证证据

**F.7-1 测试抓出实现 bug（这正是补测试的价值）**：初版模板写死 `&category={category}` 并靠「空值替换为空串」省略参数，回归用例立刻抓到真实请求是 `...&sortBy=&category=backend` —— `fillTpl` 对空值产出**空串**而非删除参数，`sortBy=` 属与 `category=` 同类的空参数隐患（上游目前容忍空 sortBy，但不可依赖）。已改为**按 (sortBy?, category?) 四组合显式枚举模板**（`SKILLSMP_TPLS.plain / sort / category / sortCategory`，各带一条去 `limit` 的降级项），空值 = 参数**根本不出现**；带 category 的组合降级时**绝不丢 category**（否则静默退回未过滤结果 = 假象）。

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.main.json --noEmit` | exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `vitest run` 全量 | **28 文件 / 416 用例通过**，exit 0（基线 406 + D2b 3 + F 净增 7：getFacets 3 条 + 参数透传 5 条，替换 1 条过时断言） |
| zh/en locale JSON 解析 | OK，`skillCategory` 嵌套 `skillsmp` 键已移除（21 个扁平键保留） |
| 分类树静态抽查 | 63 叶去重一致、12 父域齐全、父域未混入叶子 |
| **真实上游端到端**（4 组合 + 2 降级形态，节流 1.1s） | 全部 **HTTP 200**；`category=backend` 结果序列与不带分类**不同**（过滤生效 ✓）；`sortBy=recent` 与 `stars` **不同**（排序生效 ✓）；`filters` 回显不含 category（上游本就不回显，以结果序列为准） |
| 新增守卫 | 未选分类不发 `category=`；合法分类必带；非法值（`coding`/`data-analytics`/父域 slug）不透传；带分类后任何降级都不丢 category；假控件 `relevance` 不再出现在 sortOptions |

**遗留说明（未修，非本次范围）**：`StoreFilterBar.hasActiveFilters` 硬编码 `sort !== 'relevance'` 为「未筛选」基准，对无 `relevance` 排序的源（Coze/百炼）恒判「有筛选」。属既有问题、与本次改动无关，如需收敛可另开任务。

### F.6 本轮已实施（一行修复，已确认）

- `clawhub.ts` `mapEntry`：`extra.author` 由 `raw.author` 改为 `raw.author || ownerHandle || undefined`。Convex 顶层无 `author` 字段，旧实现让渲染层 `useSkillsData` 回退成 `item.source` → 每张卡片显示 `@clawhub`；现显示真实发布者。
- 新增 3 条守卫用例（兜底 ownerHandle / raw.author 优先 / 两者皆无时不造假作者）。
- 验证：双 `tsc --noEmit` exit 0；`platform-adapters.test.ts` **59 passed**（原 56 + 3）。

- [x] F.6 D2b ClawHub 作者名修复（实施 + 验证）
- [x] F.5-a~f SkillsMP 真实分类接入（分类树 + 白名单四组合模板 + optgroup + 排序修正 + 清死配置；实施 + 验证）

---

## 模块 G · 商店-MCP-百炼列表恒为空（2026-09-12，川哥反馈「列表是空，检查下能不能用」）

### G.1 排查结论：数据与链路全部正常，唯一根因是哨兵值大小写

排查覆盖全链路（均有实证）：

| 环节 | 结论 |
|---|---|
| 离线索引产物 `dist/main/platforms/bailian/data/bailian-index.json` | 存在且有效（251 条，mtime 2026-08-19；`copy-platform-data.mjs` 拷贝链路正常） |
| `dist/main/platforms/bailian.js` | 2026-09-12 00:50 编译，与源码同步 |
| `registry.ts` 注册 / `platformTypeToSupported('bailian')` 映射 / `builtinMcpSeeds()` seed | 均在 |
| 渲染层查询 `useMcpData.ts:77` → IPC `platforms:search-servers` → `bailianAdapter.searchServers` | 通 |

**根因**：`bailian.ts:134-135` 把「全部」哨兵值写成**大写 `'ALL'`**，而渲染层契约是**小写 `'all'`**——`useMcpData.ts:78` 固定传 `category || 'all'` / `source || 'all'`，下拉框「全部」的 value 也是 `'all'`（`StoreToolbar.tsx:168`、`StoreFilterBar.tsx:73`）。两个匹配条件对 'all' 永假 → **251 条全被过滤 → 列表恒为空**（连选具体分类也无效，因 `source='all'` 仍全灭）。ModelScope（`modelscope.ts:326/425/460`）与 npm（`npm.ts:534`）均为小写 `'all'`，百炼是唯一写错的 adapter。

**实测矩阵（dist 编译产物直跑）**：

| source | category | total |
|---|---|---|
| `''` | `''` | 251 ✓ |
| `''` | `'all'`（渲染层实际传值） | **0 ✗** |
| `'all'` | 任意 | **0 ✗** |
| `'ALIYUN'` | `''` | 35 ✓（真实筛选本身正常） |

### G.2 修复（两行判据 + 回归测试）

- `bailian.ts` `searchServers`：`category === 'ALL'` → `category === 'all'`、`source === 'ALL'` → `source === 'all'`，注释写明渲染层契约与跨 adapter 一致性。
- `platform-adapters.test.ts` 新增 `bailian 「全部」哨兵值（渲染层契约）` 4 条守卫：`category='all'`/`source='all'`/双 `'all'`（商店默认请求形态）均不过滤、与全量 total 一致；具体值 `ALIYUN` 仍真实过滤（防过修）。

### G.3 验证证据

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.main.json --noEmit` | exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `vitest run` 全量 | 28 文件 / 420 用例通过，exit 0（基线 416 + G 新增 4） |
| 修复后 dist 直跑矩阵 | `source='all',category='all'` → **251**（修复前 0）；`ALIYUN` → 35 不变 |

- [x] G 百炼「全部」哨兵值大小写修复（实施 + 验证）

---

## TODOS（汇总）
- [x] A10 百炼接线启用（实施 + 验证）
- [x] E2 ModelScope 连接级退避（实施 + 验证）
- [x] B electron:dev 无窗口修复（三根因全修：环境变量污染 + Chromium 沙箱 + wait-on 地址族错配；实施 + 验证）
- [x] C 「安装 MCP → 无需配置」空态美化（实施 + 验证）
- [x] D2 ClawHub 列表标签本地化 + 配色 + 空标签加固（实施 + 验证）
- [x] E1 ClawHub 排序核查（结论：可用，保留）
- [x] E2 百炼源完善（排序静默失效修复 + 探活假绿修复，实施 + 验证）
- [x] E3 SafeSkill 核查（源不可修；探活死代码 + 商店错误态修复，实施 + 验证）
- [x] E4 schemas/ 删除（零引用）
- [x] E5 SafeSkill 从 `SKILL_PLATFORM_TYPES` 下线（保留类型/META 兼容存量连接；实施 + 验证）
- [x] D1 SkillsMP 分类筛选 → 定案「接入上游真实分类」（探查取证见模块 F）
- [x] D2b ClawHub 卡片作者改真实 ownerHandle（实施 + 验证）
- [x] F.5-a~f SkillsMP 真实分类接入实施（分类树 + 白名单四组合模板 + optgroup + 排序修正 + 清死配置；实施 + 验证）
- [x] G 百炼「全部」哨兵值大小写修复——商店-MCP-百炼空列表（实施 + 验证）
- [ ] **统一提交**【用户侧事项，不计入 AI 的归档判定】（A10/E2/B/C/D/E/F 改动 + plan-8.0~12.0 遗留未提交改动；由川哥执行，AI 不代做、不催促——2026-09-12 新边界，见 code-assistant 技能 v1.1）
