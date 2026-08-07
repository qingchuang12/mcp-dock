# AI-Tools 编译说明（BUILD）

本文档面向需要从源码构建、调试或打包 AI-Tools 的开发者，覆盖项目结构、环境要求、依赖安装、各构建模式命令、构建输出位置、可用编译选项与常见编译问题排查。

> 当前版本：**1.0.0**
> 技术栈：Electron 28 + React 18 + TypeScript 5.3 + Vite 5 + Tailwind CSS 3.4 + electron-builder 24.9 + Zustand + Vitest

---

## 1. 项目结构总览

```
mcp-dock/
├── src/
│   ├── main/              # Electron 主进程（tsc -> dist/main）
│   │   ├── index.ts       # 应用入口、窗口创建、IPC 处理器注册
│   │   ├── config-manager.ts    # 多客户端 MCP 配置读写（14 个客户端）
│   │   ├── mcp-client.ts        # MCP JSON-RPC 客户端（Inspector 用）
│   │   ├── skills-manager.ts    # Skills 安装与管理
│   │   ├── history-manager.ts   # 配置备份与回滚
│   │   ├── env-manager.ts       # 运行时环境检测（node/python/npx/uvx）
│   │   └── cache-manager.ts     # 本地数据缓存
│   ├── preload/           # Electron 预加载脚本（tsc -> dist/preload）
│   │   ├── index.ts       # 安全 IPC 桥接（contextIsolation 下暴露 API）
│   │   └── index.d.ts     # 预加载 API 类型声明
│   ├── renderer/          # 前端（Vite root，vite build -> dist/renderer）
│   │   ├── index.html     # HTML 模板（含 CSP、字体、root 挂载点）
│   │   ├── src/
│   │   │   ├── main.tsx   # React 渲染入口
│   │   │   ├── components/ # UI 组件
│   │   │   ├── pages/      # 页面（Store / Library / Inspector 等）
│   │   │   ├── api/        # Registry API 层
│   │   │   ├── store/      # Zustand 状态管理
│   │   │   ├── lib/        # 工具函数与 Electron 桥接
│   │   │   └── locales/    # i18n（英文 + 简体中文）
│   │   └── assets/         # 图标与静态资源
│   └── __tests__/         # Vitest 单元测试（*.test.ts）
├── build/                 # 打包资源（图标源文件，被 electron-builder 引用）
│   ├── icon.icns          # macOS 图标
│   ├── icon.ico           # Windows 图标
│   └── icon.png           # Linux / Dock 图标
├── assets/                # 仓库展示用资源（README 图标等）
├── community-registry/    # 社区贡献目录（servers/、skills/ 模板与 README）
├── schemas/               # JSON Schema 校验文件（server / skill）
├── dist/                  # 编译输出（由 tsc 与 vite 生成，git 忽略）
│   ├── main/              # 主进程编译产物
│   ├── preload/           # 预加载编译产物
│   └── renderer/          # 渲染进程打包产物
├── release/               # electron-builder 打包产物（dmg/zip/nsis/AppImage/deb）
├── package.json           # 依赖声明 + npm scripts + build 配置
├── tsconfig.json          # 渲染进程类型检查配置（noEmit）
├── tsconfig.main.json     # 主进程 + preload 编译配置（CommonJS -> dist）
├── vite.config.ts         # Vite 配置（renderer 构建）
├── vitest.config.ts       # Vitest 配置（单元测试）
├── postcss.config.cjs     # PostCSS（tailwindcss + autoprefixer）
├── tailwind.config.cjs    # Tailwind 主题与路径扫描
├── init_structure.sh      # 社区贡献目录初始化脚本（非编译必需）
└── README.md / README_CN.md
```

### 三层进程架构

| 进程 | 源码目录 | 编译方式 | 输出 |
|------|----------|----------|------|
| 主进程 (Main) | `src/main/**` | `tsc -p tsconfig.main.json` | `dist/main/` |
| 预加载 (Preload) | `src/preload/**` | 随主进程一起编译 | `dist/preload/` |
| 渲染进程 (Renderer) | `src/renderer/**` | `vite build` | `dist/renderer/` |

主进程通过 `tsconfig.main.json` 的 `include` 同时编译 `src/main` 与 `src/preload`（见 `tsconfig.main.json:16`），因此 **preload 的编译产物与主进程共享一次 `tsc` 调用**，输出到 `dist/preload/`。

---

## 2. 环境要求

| 项目 | 最低要求 | 推荐 |
|------|----------|------|
| Node.js | ≥ 18.x（LTS） | 20.x LTS |
| npm | ≥ 9.x | 10.x |
| 操作系统 | Windows 10+ / macOS 11+ / 主流 Linux | Windows 11 / macOS / Ubuntu 22.04 |
| 磁盘空间 | 依赖 + 构建约 1.5 GB | 2 GB 以上 |
| 内存 | 4 GB | 8 GB 以上（electron-builder 打包较吃内存） |

### 平台相关前置条件

- **Windows**：无需额外 C++ 构建工具（依赖均为纯 JS/TS，无原生模块），但建议以**管理员或普通用户**身份运行 PowerShell 7+；若企业环境有防病毒软件，可能拦截 Electron 二进制下载。
- **macOS**：如需自行签名打包需 Apple Developer 证书；未签名版本可用 `xattr -cr` 解除隔离（见 README FAQ）。
- **Linux**：打包 AppImage / deb 需要 `fpm`、`dpkg`、`rpm` 等，electron-builder 通常自带或自动安装；若缺系统库，按报错安装（如 `libgtk-3-0`、`libnss3`）。

> 重要：开发模式下，渲染进程通过 Vite DevServer（`http://localhost:5173`）加载，需保证该端口未被占用。

---

## 3. 依赖安装步骤

```bash
# 1. 克隆仓库（如尚未获取源码）
git clone <repo-url> mcp-dock && cd mcp-dock

# 2. 安装依赖（同时会触发 electron 的 postinstall 下载 Electron 二进制）
npm install
```

### 安装注意事项

- **Electron 二进制下载**：`npm install` 会触发 Electron 的 `postinstall` 脚本，从 GitHub 下载对应平台的 Electron 二进制。国内网络可能较慢或失败，可设置镜像：
  ```bash
  # 方案 A：使用 npm 镜像（如 npmmirror）
  npm config set registry https://registry.npmmirror.com

  # 方案 B：单独设置 Electron 下载镜像
  npm config set electron_mirror https://registry.npmmirror.com/-/binary/electron/
  # 或在 Windows PowerShell 中临时设置环境变量：
  $env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
  ```
- **已安装缓存**：Electron 二进制默认缓存在 `~/.electron`（Linux/macOS）或 `%LOCALAPPDATA%\electron\Cache`（Windows），重复安装会复用，无需每次下载。
- **清理重装**：若依赖异常，删除 `node_modules` 与 `package-lock.json` 后重装：
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```
- **`init_structure.sh` 非必需**：该脚本仅用于初始化 `community-registry/` 目录与模板文件，与编译/运行无关，普通构建无需执行。

---

## 4. 构建模式区分

AI-Tools 在运行时通过 `src/main/index.ts:24` 判断开发/生产模式：

```ts
const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;
```

- 当 `isDev` 为 `true`：主进程加载 Vite DevServer 地址（`VITE_DEV_SERVER_URL`，默认 `http://localhost:5173`），并自动打开 DevTools。
- 当 `isDev` 为 `false`：主进程加载本地打包文件 `dist/renderer/index.html`。

### 开发模式 vs 生产模式对比

| 维度 | 开发模式 (`electron:dev`) | 生产模式 (`build` / `package`) |
|------|---------------------------|-------------------------------|
| 主进程编译 | `tsc --watch` 持续编译到 `dist/main`、`dist/preload` | 单次 `tsc` 编译 |
| 渲染进程 | Vite DevServer（端口 5173，支持 HMR 热更新） | `vite build` 打包到 `dist/renderer`，terser 压缩 |
| console / debugger | 保留 | 经 terser 移除（`drop_console` / `drop_debugger`） |
| 资源加载 | 远程 DevServer URL | 本地 `file://` 静态文件 |
| 代码混淆 | 否 | 是（chunk 文件名 hash 化、toplevel mangle） |
| 是否打包为安装包 | 否 | 是（`electron-builder` -> `release/`） |
| 适用场景 | 本地调试、UI 开发 | 分发、发布 |

---

## 5. 编译命令

### 5.1 开发模式

推荐一键启动（编译主进程 + 启动 Vite + 拉起 Electron）：

```bash
npm run electron:dev
```

该脚本等价于：

```bash
npm run build:main && \
concurrently -k \
  "npm run dev:main" \
  "npm run dev:renderer" \
  "wait-on tcp:5173 && cross-env VITE_DEV_SERVER_URL=http://localhost:5173 electron ."
```

流程说明：
1. 先单次编译主进程（`build:main`）确保预加载脚本存在。
2. `dev:main`（`tsc -p tsconfig.main.json --watch`）持续监听主进程/预加载源码变更。
3. `dev:renderer`（`vite`）启动 DevServer 于 5173 端口。
4. `wait-on` 等待端口就绪后，用 `cross-env` 注入 `VITE_DEV_SERVER_URL` 并启动 Electron（触发开发加载模式 + 打开 DevTools）。

也可仅启动前端 DevServer 进行 UI 调试（不拉起 Electron）：

```bash
npm run dev            # = concurrently dev:main + dev:renderer
npm run dev:renderer   # 仅 Vite DevServer
npm run dev:main       # 仅主进程 watch 编译
```

### 5.2 生产模式（仅编译，不打包）

```bash
npm run build
# 等价于：npm run build:main && npm run build:renderer
```

- `build:main`：`tsc -p tsconfig.main.json` -> 输出 `dist/main/`、`dist/preload/`
- `build:renderer`：`vite build` -> 输出 `dist/renderer/`

编译完成后，可用 Electron 直接运行已打包产物（无需再启动 DevServer）：

```bash
npm run start          # = electron . （加载 dist/renderer/index.html）
```

> 注意：`start` 之前必须先执行 `npm run build`，否则 `dist/` 不存在会报错。

### 5.3 打包为分发安装包

```bash
# 自动 build 后调用 electron-builder（当前平台）
npm run package

# 指定平台打包（均会先 npm run build）
npm run package:mac      # electron-builder --mac
npm run package:win      # electron-builder --win --x64
npm run package:linux    # electron-builder --linux
```

各平台产出（输出目录 `release/`，配置于 `package.json` 的 `build.directories.output`）：

| 平台 | 目标格式 | 输出示例 |
|------|----------|----------|
| macOS | dmg + zip（x64/arm64） | `MCP.Dock-*.dmg`、`MCP.Dock-*.zip` |
| Windows | nsis（安装版）+ portable（便携版） | `MCP.Dock.Setup-*.exe`、`MCP.Dock-*.exe` |
| Linux | AppImage + deb（x64/arm64） | `MCP.Dock-*.AppImage`、`mcp-dock_*.deb` |

### 5.4 单元测试

```bash
npm test          # vitest run（单次执行 src/__tests__/**/*.test.ts）
npm run test:watch # vitest（监听模式）
```

---

## 6. 构建输出位置

| 路径 | 生成阶段 | 内容 | 是否被打包进 app |
|------|----------|------|------------------|
| `dist/main/` | `build:main` / `dev:main` | 主进程 JS（CommonJS） | ✅ 是 |
| `dist/preload/` | `build:main`（与主进程同次编译） | 预加载 JS | ✅ 是 |
| `dist/renderer/` | `build:renderer` | HTML + JS/CSS/资源（hash 命名） | ✅ 是 |
| `build/` | 仓库自带 | 图标源（`icon.icns/.ico/.png`） | ✅ 是（files 声明） |
| `release/` | `package*` | 最终安装包/便携包 | ❌（产物目录） |
| `node_modules/` | `npm install` | 依赖 | ❌（已 tree-shake 处理） |

electron-builder 的 `files` 字段（`package.json:78`）明确包含 `dist/**/*`、`build/**/*`、`package.json`，因此最终安装包只内联这些目录，不包含 `src`、`node_modules` 等源码与依赖（依赖已在 `vite build` 时打包进 `dist/renderer`）。

---

## 7. 可用编译选项与参数清单

### 7.1 npm scripts（全部）

| 脚本 | 命令 | 说明 |
|------|------|------|
| `dev` | `concurrently "npm run dev:main" "npm run dev:renderer"` | 并行启动主进程 watch 与 Vite |
| `dev:main` | `tsc -p tsconfig.main.json --watch` | 主进程/预加载持续编译 |
| `dev:renderer` | `vite` | Vite DevServer（5173） |
| `build` | `npm run build:main && npm run build:renderer` | 完整生产编译 |
| `build:main` | `tsc -p tsconfig.main.json` | 主进程/预加载编译 |
| `build:renderer` | `vite build` | 渲染进程打包 |
| `start` | `electron .` | 运行已编译产物 |
| `electron:dev` | `build:main` + 并行 watch/dev/wait-on+electron | 完整开发体验 |
| `package` | `npm run build && electron-builder` | 当前平台打包 |
| `package:mac` | `npm run build && electron-builder --mac` | macOS 打包 |
| `package:win` | `npm run build && electron-builder --win --x64` | Windows 打包（x64） |
| `package:linux` | `npm run build && electron-builder --linux` | Linux 打包 |
| `test` | `vitest run` | 单次测试 |
| `test:watch` | `vitest` | 监听测试 |

### 7.2 TypeScript 编译参数（`tsconfig.main.json`）

- `-p tsconfig.main.json`：指定项目配置文件（主进程 + preload）。
- `--watch`（开发）：文件变更自动重编译。
- 关键编译选项：`module: CommonJS`、`outDir: dist`、`rootDir: src`、`target: ES2022`、`strict: true`、`resolveJsonModule: true`。
- `include`：`src/main/**/*`、`src/preload/**/*`；`exclude`：`node_modules`、`src/renderer`。

### 7.3 Vite 配置（`vite.config.ts`）可调参数

| 参数 | 当前值 | 说明 |
|------|--------|------|
| `root` | `src/renderer` | Vite 项目根目录 |
| `base` | `./` | 资源相对路径（便于 `file://` 加载） |
| `build.outDir` | `../../dist/renderer` | 渲染产物输出 |
| `build.emptyOutDir` | `true` | 每次清空输出目录 |
| `build.minify` | `terser` | 生产压缩器（去 console/debugger） |
| `server.port` | `5173` | DevServer 端口 |
| `resolve.alias['@']` | `src/renderer/src` | 路径别名（与 tsconfig 一致） |

> 如需自定义端口，修改 `server.port` 后，开发脚本中的 `wait-on tcp:5173` 与 `VITE_DEV_SERVER_URL` 也需同步修改。

### 7.4 electron-builder CLI 参数

基于 npm script 已封装，也可直接调用：

```bash
# 平台
--mac / --win / --linux
# 架构（可组合）
--x64 / --arm64 / --ia32
# 指定目标（覆盖 package.json 的 build.target）
--project electron-builder.yml
# 配置覆盖
--config.<key>=<value>
# 不发布（默认 publish: null，已设置）
```

`package.json` 的 `build` 字段已内嵌平台配置（图标、target 列表、nsis 选项等），无需额外配置文件。

### 7.5 环境变量（由脚本注入）

| 变量 | 注入位置 | 作用 |
|------|----------|------|
| `VITE_DEV_SERVER_URL` | `electron:dev` 经 `cross-env` | 触发开发模式，主进程加载 DevServer |
| `NODE_ENV` | 可手动 `cross-env NODE_ENV=development` | 同上，`isDev` 判断条件之一 |

---

## 8. 常见编译问题与解决方法

### 8.1 `npm install` 失败 / Electron 二进制下载超时
- **现象**：卡在 `node_modules/electron/install.js` 或报 `ETIMEDOUT`。
- **解决**：设置镜像（见 §3），或手动下载 Electron 二进制放入缓存目录后重装。企业网络可配置代理：
  ```bash
  npm config set proxy http://proxy.company.com:8080
  npm config set https-proxy http://proxy.company.com:8080
  ```

### 8.2 `npm run electron:dev` 启动后白屏 / 无法连接 5173
- **现象**：Electron 窗口空白，控制台提示无法加载 `http://localhost:5173`。
- **原因**：Vite DevServer 未就绪或端口被占用。
- **解决**：
  - 确认 `dev:renderer` 已启动，`http://localhost:5173` 可访问。
  - 端口冲突：修改 `vite.config.ts` 的 `server.port`，并同步 `electron:dev` 脚本中的 `wait-on` 与 `VITE_DEV_SERVER_URL`。
  - 防火墙/代理拦截 localhost：尝试 `127.0.0.1` 替代 `localhost`。

### 8.3 `npm run start` 报 `dist/renderer/index.html` 不存在
- **现象**：`Error: ENOENT: .../dist/renderer/index.html`。
- **原因**：未先执行 `npm run build`。
- **解决**：先运行 `npm run build`，再 `npm run start`。

### 8.4 `tsc` 编译报错 `noUnusedLocals` / `noUnusedParameters`
- **现象**：`error TS6133: 'xxx' is declared but its value is never read.`
- **原因**：`tsconfig.main.json` 开启了严格检查。
- **解决**：删除未使用变量/参数，或在函数参数前加 `_` 前缀（仅 `noUnusedParameters` 忽略下划线前缀），不要直接关闭严格选项以免引入隐患。

### 8.5 主进程与渲染进程 `alias '@'` 解析不一致
- **现象**：Vite 能解析 `@/...`，但 tsc 报找不到模块。
- **解决**：`tsconfig.json` 的 `paths` 与 `vite.config.ts` 的 `alias` 必须一致（均已设为 `src/renderer/src`）。若新增别名，两处需同步。

### 8.6 打包时 `release/` 产物缺失图标或报错
- **现象**：`electron-builder` 报找不到 `build/icon.*`。
- **解决**：确认 `build/` 目录下存在 `icon.icns`（macOS）、`icon.ico`（Windows）、`icon.png`（Linux）。图标缺失会导致对应平台打包失败。

### 8.7 Windows 下防病毒拦截 / 权限不足
- **现象**：`electron-builder` 生成 `nsis` 安装包时中断，或运行安装包被杀毒软件拦截。
- **解决**：临时将项目目录加入杀毒软件白名单；以普通用户身份运行（脚本已设 `requestedExecutionLevel: asInvoker`，无需管理员）。

### 8.8 macOS 打包后提示「应用已损坏」
- **现象**：未签名版本打开时报「“AI-Tools”已损坏，无法打开」。
- **解决**：终端执行 `xattr -cr /Applications/MCP\ Dock.app` 解除隔离（详见 README FAQ）。如需正式分发，配置 Apple 开发者证书并开启 `electron-builder` 签名。

### 8.9 Linux 打包缺少系统库
- **现象**：`electron-builder` 报 `dpkg` / `fpm` 未找到，或运行 AppImage 报缺 `.so`。
- **解决**：安装打包工具与目标库，例如 Ubuntu：
  ```bash
  sudo apt-get install -y dpkg rpm fakeroot libfuse2 libgtk-3-0 libnss3
  ```

### 8.10 测试阶段 `vitest` 找不到测试文件
- **现象**：`No test files found`。
- **解决**：确认测试文件位于 `src/__tests__/` 且命名为 `*.test.ts`（`vitest.config.ts` 的 `include` 已限定该路径）。

---

## 9. 快速参考（常用命令一览）

```bash
# 安装依赖
npm install

# 开发（带热更新 + DevTools）
npm run electron:dev

# 生产编译（仅生成 dist/）
npm run build

# 运行已编译产物
npm run start

# 打包当前平台安装包 -> release/
npm run package

# 跨平台打包
npm run package:mac
npm run package:win
npm run package:linux

# 运行单元测试
npm test
```

---

*本文档严格基于仓库现有配置（`package.json`、`tsconfig*.json`、`vite.config.ts`、`vitest.config.ts`、`src/main/index.ts` 等）整理，未引入任何未声明的自定义脚本或参数。*
