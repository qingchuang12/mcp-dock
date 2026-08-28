# plan-cleanup-1.0: 冗余代码清理计划

## 扫描概述

对 `mcp-dock` 项目进行全面扫描，识别以下类别的冗余代码：
- **类型定义重复**：同一类型在多处定义
- **源码级冗余文件**：与项目无关或重复的源文件
- **一次性脚本/调试工具**：已完成使命的临时脚本
- **历史文档/调试页面**：历史规划文档、API 调试 HTML
- **构建产物磁盘冗余**：已在 `.gitignore` 但仍占用磁盘的空间
- **组件重复代码**：跨组件重复的逻辑/UI 片段

---

## 一、Critical - 类型定义重复（架构演进遗留）

### 1.1 `resolvers/types.ts` 与 `platforms/types.ts` 类型重复

**位置：**
- [resolvers/types.ts](file:///D:/moneyspace/mcp-dock/src/main/resolvers/types.ts)
- [platforms/types.ts](file:///D:/moneyspace/mcp-dock/src/main/platforms/types.ts)

**问题描述：**
两个文件各自独立定义了大量完全相同的类型，这是 `resolvers/`（旧架构）→ `platforms/`（新 PlatformAdapter 架构）演进过程中未清理遗留导致的。

**重复类型清单：**

| 类型 | resolvers/types.ts | platforms/types.ts | 差异 |
|------|-------------------|-------------------|------|
| `SupportedPlatform` | L10 | L12 | 完全一致 |
| `PlatformSkillListItem` | L29 | L22 | 完全一致 |
| `PlatformPageInfo` | L55 | L55 | 完全一致 |
| `PlatformSearchPage` | L68 | L64 | resolvers 版多 `pagingMode`/`serverTotal` 等字段，但 platforms 版也有 |
| `PlatformServerListItem` | L102 | L38 | 完全一致 |
| `PlatformServerSearchPage` | L130 | L82 | 完全一致 |
| `PlatformServerDetail` | L140 | L90 | 完全一致 |
| `DirectSearchAttempt` | L175 | L135 | 完全一致 |
| `DirectSearchDiagnostics` | L195 | L155 | 完全一致 |
| `PLATFORM_NAMES` | L18 | 无 | resolvers 独有，但 platforms 未使用 |
| `UA` / `DIRECT_SEARCH_PAGE_SIZE` | L8 | 无（在 platforms/shared.ts 中） | 常量分散 |

**影响范围分析：**
- `resolvers/` 被以下文件引用：`platform-skill-resolver.ts`、`url-detect.ts`、`dispatch.ts`、`pagination.ts`、`servers.ts`、`skillhub.ts`、`clawhub.ts`、`install-zip.ts`
- `platforms/` 被以下文件引用：`modelscope.ts`、`clawhub.ts`、`skillhub.ts`、`skillsmp.ts`、`shared.ts`、`registry.ts`、`bailian.ts`
- **两者不是互斥的**：`resolvers/` 和 `platforms/` 是项目中的两套并行实现。`platform-skill-resolver.ts` 作为 facade 导出 `resolvers/` 的 API，而 `platforms/` 通过 `registry.ts` 提供 `PlatformAdapter` 接口。

**建议方案：**
- 将类型定义统一收敛到 `platforms/types.ts`（新架构）
- `resolvers/types.ts` 改为从 `platforms/types.ts` re-export
- 确保 `resolvers/` 各模块的 import 路径不受影响

**风险等级：** ⚠️ 中风险 — 涉及多处 import 路径变更，需全量回归测试

---

## 二、High - 源码级冗余文件

### 2.1 `src/preload/index.js` — 与 TypeScript 版本重复

**位置：** [src/preload/index.js](file:///D:/moneyspace/mcp-dock/src/preload/index.js)

**问题描述：**
- 项目有 `src/preload/index.ts`（TypeScript 源文件），构建流程通过 `tsconfig.main.json`（`include: ["src/preload/**/*"]`）编译到 `dist/preload/index.js`
- 主进程 `index.ts` L111 引用 `path.join(__dirname, '../preload', 'index.js')` 即 `dist/preload/index.js`
- `src/preload/index.js` 使用 ES Module `import` 语法，但 `tsconfig.main.json` 配置 `"module": "CommonJS"`，说明此文件**不是** tsc 编译产物
- 推断为早期手写 JS 版本，后改用 TS 编写但未删除旧 JS 文件

**影响范围分析：**
- 无任何 import 引用 `src/preload/index.js`
- 构建与运行时均使用 `dist/preload/index.js`（编译自 `index.ts`）
- 删除安全，不影响任何功能

**建议方案：** 直接删除 `src/preload/index.js`

**风险等级：** ✅ 低风险 — 确认无引用

---

### 2.2 `io/` 目录 — Java 代码与项目无关

**位置：** [io/agentscope/](file:///D:/moneyspace/mcp-dock/io/agentscope/)

**包含文件：**
- `core/a2a/agent/A2aAgent.java`（A2A Agent 实现）
- `core/middleware/MiddlewareBase.java`（中间件基类）

**问题描述：**
这是 Java 源代码（AgentScope 框架的 A2A Agent 和中间件），而 `mcp-dock` 是一个 **Electron + TypeScript** 项目。Java 文件无法被项目构建系统处理，属于误放或从其他项目带入。

**影响范围分析：**
- `package.json` 无 Java 相关依赖或构建脚本
- 无任何 TypeScript 文件引用 Java 代码
- 不属于项目构建产物

**建议方案：** 删除整个 `io/` 目录

**风险等级：** ✅ 低风险 — 确认与项目无关

---

## 三、Medium - 一次性脚本/调试工具

### 3.1 `scripts/dev/probe-ms-*.mjs` — ModelScope API 调试探针（11 个文件）

**位置：** [scripts/dev/](file:///D:/moneyspace/mcp-dock/scripts/dev/)

**文件清单：**
| 文件 | 用途 |
|------|------|
| `probe-ms-all.mjs` | 验证 category='all' 参数行为 |
| `probe-ms-cats.mjs` | 聚合 Skill/MCP 真实分类分布 |
| `probe-ms-cats2.mjs` | 分类探测（第二版） |
| `probe-ms-empty-cat.mjs` | 空分类边界测试 |
| `probe-ms-final.mjs` | 最终验证脚本 |
| `probe-ms-mcp-final.mjs` | MCP 端点最终验证 |
| `probe-ms-mcp-page.mjs` | MCP 分页验证 |
| `probe-ms-mcp-raw.mjs` | MCP 原始响应验证 |
| `probe-ms-skill-quota.mjs` | Skill 配额边界验证 |
| `probe-ms-www.mjs` | www 子域名行为对比 |
| `probe-ms-www2.mjs` | www 子域名对比（第二版） |

**问题描述：**
这些是开发期间用于调试 ModelScope API 行为的一次性探针脚本。名称中带 `-final`、`-2` 等后缀表明是迭代调试过程。功能已集成到 `platforms/modelscope.ts` 中，脚本本身不再被任何流程引用。

**影响范围分析：**
- `package.json` 的 `scripts` 中无引用
- 无 CI/CD 流程引用
- 代码中无 import 引用

**建议方案：** 删除全部 11 个 `probe-ms-*.mjs` 文件

**风险等级：** ✅ 低风险 — 仅调试用途

---

### 3.2 `scripts/diag-ms-server.mjs` — 诊断脚本

**位置：** [scripts/diag-ms-server.mjs](file:///D:/moneyspace/mcp-dock/scripts/diag-ms-server.mjs)

**问题描述：**
只读诊断脚本，逐步复现 `msServerSearchImpl` 链路定位空结果原因。一次性用途。

**建议方案：** 删除

**风险等级：** ✅ 低风险

---

### 3.3 `scripts/probe-result.json` — 探针结果缓存

**位置：** [scripts/probe-result.json](file:///D:/moneyspace/mcp-dock/scripts/probe-result.json)

**问题描述：**
探针脚本运行结果缓存（77296 条 skill 分类统计），无代码逻辑依赖。

**建议方案：** 删除

**风险等级：** ✅ 低风险

---

### 3.4 `scripts/theme-rewrite.cjs` — 一次性主题改写

**位置：** [scripts/theme-rewrite.cjs](file:///D:/moneyspace/mcp-dock/scripts/theme-rewrite.cjs)

**问题描述：**
批量将 Tailwind 硬编码颜色值替换为 CSS 变量的脚本。执行完毕后不再需要。

**影响范围分析：**
- `package.json` 无引用
- 无构建流程引用

**建议方案：** 删除

**风险等级：** ✅ 低风险

---

### 3.5 `scripts/gen-bailian-index.cjs` — 百炼索引生成

**位置：** [scripts/gen-bailian-index.cjs](file:///D:/moneyspace/mcp-dock/scripts/gen-bailian-index.cjs)

**问题描述：**
生成百炼离线索引（251 条），用于填充 `platforms/bailian/data/bailian-index.json`。索引已生成到位，此脚本不再需要运行。

**影响范围分析：**
- `package.json` 无引用
- 无构建流程引用

**建议方案：** 删除（如后续需要重新生成索引可保留，建议确认）

**风险等级：** ✅ 低风险 — 但建议确认百炼索引是否需要定期更新

---

### 3.6 `scripts/check-store-i18n.cjs` — 商店国际化检查

**位置：** [scripts/dev/check-store-i18n.cjs](file:///D:/moneyspace/mcp-dock/scripts/dev/check-store-i18n.cjs)

**问题描述：**
检查 Store 页面组件中使用的 i18n key 是否在 `zh.json` / `en.json` 中都有定义。有一定维护价值。

**建议方案：** 保留（可集成到 CI lint 流程）

**风险等级：** ℹ️ 建议保留

---

## 四、Medium - 文档/调试页面

### 4.1 `doc/*_explorer.html` — 平台 API 数据浏览页面（6 个）

**位置：** [doc/](file:///D:/moneyspace/mcp-dock/doc/)

**文件清单：**
| 文件 | 对应平台 |
|------|---------|
| `bailian/bailian_explorer.html` | 百炼 |
| `clawhub/clawhub_explorer.html` | ClawHub |
| `modelscope/modelscope-mcp-explorer.html` | ModelScope MCP |
| `modelscope/modelscope-skill-explorer.html` | ModelScope Skill |
| `skillhub/skillhub_explorer.html` | SkillHub |
| `skillsmp/skillsmp_explorer.html` | SkillsMP |

**问题描述：**
这些 HTML 页面用于在浏览器中直接浏览各平台的 API 返回数据，辅助开发调试。功能已集成到应用内的 Store 页面，HTML 页面不再需要。

**影响范围分析：**
- 纯静态 HTML，无代码引用
- 不参与构建

**建议方案：** 删除（或移到 `scripts/dev/` 目录下作为调试参考）

**风险等级：** ✅ 低风险

---

### 4.2 `doc/plan-*.md` — 历史规划文档（5 个）

**位置：** [doc/](file:///D:/moneyspace/mcp-dock/doc/)

**文件清单：**
| 文件 | 内容 |
|------|------|
| `plan-1.0.md` | 初始规划 |
| `plan-1.1.md` | 迭代规划 |
| `plan-1.2.md` | 迭代规划 |
| `plan-1.3.md` | 迭代规划 |
| `plan-store-1.4.md` | 商店功能规划 |

**问题描述：**
历史版本规划文档，功能已实现。保留可作为开发记录参考，但非项目运行必需。

**建议方案：** 归档到 `doc/archive/` 目录或删除

**风险等级：** ✅ 低风险 — 不影响运行

---

### 4.3 `doc/README.md` 和 `doc/README_CN.md` — 与根目录 README 可能重复

**位置：** [doc/README.md](file:///D:/moneyspace/mcp-dock/doc/README.md) / [doc/README_CN.md](file:///D:/moneyspace/mcp-dock/doc/README_CN.md)

**问题描述：**
文档目录下存在 README 文件，可能与项目根目录的 README 内容重复。需对比确认。

**建议方案：** 对比后决定是否删除

**风险等级：** ✅ 低风险

---

## 五、Low - 构建产物磁盘冗余

### 5.1 `dist/` 目录

**位置：** [dist/](file:///D:/moneyspace/mcp-dock/dist/)

**问题描述：**
TypeScript 编译产物，已在 `.gitignore` 中。但当前占用磁盘空间。

**建议方案：** 执行 `pnpm run build` 前可清理，但通常保留以支持 `electron:dev` 启动。

**风险等级：** ✅ 低风险 — 可随时重建

---

### 5.2 `release/` 目录

**位置：** [release/](file:///D:/moneyspace/mcp-dock/release/)

**问题描述：**
`electron-builder` 打包产物（含 `AI-Tools 1.3.1.exe`、`AI-Tools Setup 1.3.1.exe`、`win-unpacked/` 等），已在 `.gitignore` 中。占用空间较大（估计 200MB+）。

**建议方案：** 清理旧版本安装包，仅保留最新版本

**风险等级：** ✅ 低风险 — 可随时重新打包

---

### 5.3 `node_modules/` 目录

已在 `.gitignore` 中，但占用大量磁盘空间。可通过 `pnpm install` 随时重建。

**建议方案：** 无需操作，`pnpm install` 自动管理

---

## 六、Low - 组件重复代码

### 6.1 `LoadingSkeleton` 组件重复

**位置：**
- [LibraryMcpList.tsx](file:///D:/moneyspace/mcp-dock/src/renderer/src/components/LibraryMcpList.tsx) L30-L44
- [LibrarySkillList.tsx](file:///D:/moneyspace/mcp-dock/src/renderer/src/components/LibrarySkillList.tsx) L30-L44

**问题描述：**
两个文件中 `LoadingSkeleton` 组件代码完全相同（3 个骨架占位块）。可提取为共享组件。

**建议方案：** 提取到 `components/store/LoadingSkeleton.tsx`，两处改为 import

**风险等级：** ✅ 低风险 — 纯 UI 组件，行为一致

---

## 七、Info - IDE/Agent 本地文件

### 7.1 `.codebuddy/` 和 `.workbuddy/` 目录

**位置：** 
- [.codebuddy/](file:///D:/moneyspace/mcp-dock/.codebuddy/)
- [.workbuddy/](file:///D:/moneyspace/mcp-dock/.workbuddy/)

**问题描述：**
IDE/Agent 的本地记忆文件，非项目源码。`.codebuddy` 已在 `.gitignore` 中，`.workbuddy` 未在 `.gitignore` 中。

**建议方案：** 将 `.workbuddy` 加入 `.gitignore`

**风险等级：** ✅ 低风险

---

### 7.2 `mcp-dock.iml` — IntelliJ IDEA 模块文件

**位置：** [mcp-dock.iml](file:///D:/moneyspace/mcp-dock/mcp-dock.iml)

**问题描述：**
IntelliJ IDEA 项目模块文件，通常应加入 `.gitignore`。

**建议方案：** 加入 `.gitignore`

**风险等级：** ✅ 低风险

---

## 清理优先级总结

| 优先级 | 类别 | 条目数 | 操作 | 风险 |
|--------|------|--------|------|------|
| **Critical** | 类型定义重复 | 1 组 | 统一收敛 + re-export | ⚠️ 中 |
| **High** | 源码冗余文件 | 2 个 | 直接删除 | ✅ 低 |
| **Medium** | 一次性脚本 | 15 个 | 直接删除 | ✅ 低 |
| **Medium** | 文档/调试页面 | 12 个 | 删除或归档 | ✅ 低 |
| **Low** | 构建产物 | 3 个目录 | 选择性清理 | ✅ 低 |
| **Low** | 组件重复代码 | 1 组 | 提取共享组件 | ✅ 低 |
| **Info** | IDE 本地文件 | 3 个 | 补充 .gitignore | ✅ 低 |

---

## TODOS

- [x] **T1**: 确认 `resolvers/types.ts` 与 `platforms/types.ts` 的合并方案，确保无遗漏字段 → `resolvers/types.ts` 改为从 `platforms/types.ts` re-export 共享类型
- [x] **T2**: 删除 `src/preload/index.js` → 已删除
- [x] **T3**: 删除 `io/` 目录 → 已不存在（之前已清理）
- [x] **T4**: 删除 `scripts/dev/probe-ms-*.mjs`（11 个文件） → 已删除
- [x] **T5**: 删除 `scripts/diag-ms-server.mjs` → 已删除
- [x] **T6**: 删除 `scripts/probe-result.json` → 已删除
- [x] **T7**: 删除 `scripts/theme-rewrite.cjs` → 已删除
- [x] **T8**: 确认 `scripts/gen-bailian-index.cjs` 是否需要保留，不需要则删除 → 已删除
- [x] **T9**: 删除 `doc/*_explorer.html`（6 个文件） → 用户选择保留
- [x] **T10**: 归档或删除 `doc/plan-*.md`（5 个文件） → 已归档到 `doc/archive/`
- [x] **T11**: 对比 `doc/README.md` / `doc/README_CN.md` 与根目录 README → 确认为项目唯一 README，保留
- [x] **T12**: 清理 `release/` 旧版本安装包 → 跳过（仅一个版本，可随时重建）
- [x] **T13**: 提取 `LoadingSkeleton` 为共享组件 → 提取到 `components/store/LoadingSkeleton.tsx`
- [x] **T14**: 将 `.workbuddy`、`mcp-dock.iml` 加入 `.gitignore` → 已添加
- [x] **T15**: 执行 `pnpm run typecheck` + `pnpm test` 验证清理后无回归 → ✅ 主进程 typecheck 通过 / 渲染进程 typecheck 通过 / 11 个测试文件 144 个测试全部通过
