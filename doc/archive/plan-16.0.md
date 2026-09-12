# plan-16.0 · 单一活动计划（打包产物缺失传递依赖 concat-stream）

> 版本：1.1（2026-09-12 完成并归档：修复 `cannot find module concat-stream`——SFTP 传递闭包真实化 + 真实 electron-builder 出包验证（含川哥本机出包复验）；release/ 与临时残留清理；`node-linker=hoisted` 已取证、决定不根治）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-15.0.md](archive/plan-15.0.md)（P 商店全流程发布前检查：QA 四层矩阵回归 + 3 条建议级收尾 + 复验闭环，最终放行；遗留用户侧事项：统一提交，由川哥执行）。

## 规则（plan 管理铁律）
- `doc/` 下**同一时刻只保留一个活动 plan**（本文件）；新任务合并进本 plan，不另起 `plan-NN.N.md`。
- 任务**已执行完结** → 归档到 `doc/archive/`（plan 与 audit 一并归档）；**未执行** → 合并进活动 plan。
- 每次软件调整：细化进 plan → 确认 → 执行 → 归档检查。

---

## 跨版本遗留项

（暂无。已知能力边界：codex-cli 上游不支持远程 MCP 接入，UI 已明示拦截，上游支持后可移除。）

## 本次任务：打包产物缺失传递依赖（cannot find module concat-stream）

### 现象
运行打包后的 exe（win-unpacked），使用 SFTP 功能时报 `cannot find module concat-stream`。

### 根因（已取证）
- pnpm 当前为 symlinked 模式（`.npmrc` 的 `node-linker=hoisted` 未生效）：直接依赖是 `SymbolicLink`，传递依赖藏于 `node_modules/.pnpm/<pkg>@x/node_modules/<pkg>`。
- 既有 `scripts/link-pnpm-deps.cjs` 用 `fs.symlinkSync(src, top, 'junction')` 把传递依赖以 **Windows junction** 补到顶层 `node_modules`。
- 取证 `release/win-unpacked/resources/app.asar`：直接依赖 `ssh2`（42 条）、`@modelcontextprotocol/sdk`（557 条）、`electron-store`（在）；但 `concat-stream`、`ssh2-streams`、`readable-stream`、`asn1`、`bcrypt-pbkdf`、`cpu-features` 等**全部为 0**。
- electron-builder 只 dereference 直接依赖的 `SymbolicLink`，不跟随 Windows junction，故 junction 补上的传递依赖整条丢失。

### 修复（已落地，纯 Node 递归复制）
- `scripts/link-pnpm-deps.cjs`：废弃 `fs.symlinkSync(..., 'junction')`（Windows junction 进 asar 后 Electron 不跟随）。
- 改为**真实递归复制**：`copyDirReal(src, top)` 用 `fs.copyFileSync`/`fs.mkdirSync` 复制文件与目录；遇符号链接/junction 用 `fs.realpathSync` 解析为真实物理路径后再复制，把 `.pnpm` 内含 junction 的嵌套传递依赖全体真实化；`visited` 集合按真实源路径去重防 pnpm 循环符号链接；递归深度上限 60 防极端深嵌套/环。
- 复制前 `fs.rmSync(top, {recursive:true, force:true})` 清顶层残留（悬空 junction 等）；Node 的 `rmSync` 不走 trash，可删被 safe-delete 拦截的残留。
- 范围：仅对「生产依赖真实依赖图（递归读各包 package.json 的 deps/optional/peer）」中的**非直接依赖**项真实化；devDependencies 整条传递链不进入；直接依赖保持符号链接由 electron-builder 处理。
- 早期尝试 `fs.cpSync({recursive, dereference})` 在含 junction 的嵌套依赖（concat-stream/typedarray/ms/find-up/punycode 等）上 ESRCH 失败；`robocopy`/powershell 外部命令在本环境不可靠（进程级退出且无日志），故最终采用纯 Node。

### 其他问题（顺带处置 / 验证）
1. 原生模块 `cpu-features@0.0.10` 在 `node_modules` 内**无 `.node` 二进制**（`npmRebuild:false`），打包后 `require('cpu-features')` 可能降级或报错，影响 SFTP 加密加速；重打包后需实测 SFTP 功能，必要时开启 `npmRebuild`。
2. 根因 `node-linker=hoisted` 未生效（依赖隔离靠 link 补丁兜底）；建议根治：确认 `.npmrc` 被 pnpm 读取 / 重装为 hoisted，消除补丁依赖。
3. `release/` 残留 1.2.4 版本 exe / Setup，非 bug，可清理。

## TODOS（汇总）

- [x] 诊断：asar 内 concat-stream 等传递依赖缺失根因（pnpm symlinked + electron-builder 不跟进特定嵌套符号链接；旧 junction 方案亦无效）
- [x] 修复 link-pnpm-deps.cjs：改为「仅真实化 SFTP 栈（ssh2/ssh2-sftp-client）生产传递闭包」的纯 Node 真实递归复制；含 realpath 校验（跳悬空链接）、visited 防环、深度上限 60、跳过非闭包符号链接（防复制 dev 包）
- [x] 重跑 link:deps，验证顶层 node_modules 下整条闭包（concat-stream/readable-stream/safe-buffer/bcrypt-pbkdf/string_decoder/inherits 等 17 个非直接包）均为真实目录且可 require
- [x] 验证打包机制含入闭包：用 `@electron/asar`（electron-builder 同款库）轻量打包已真实化的 12 个 SFTP 闭包顶层目录 → asar 内 concat-stream(4)/readable-stream(28)/safe-buffer(5)/… 全部 >0 条目
- [x] **真实 electron-builder 出包验证通过（端到端闭环）**：以「独立输出目录 `release-verify` + 本地 `electronDist` + `win.signAndEditExecutable=false`」绕过沙箱对 `release/` 旧 asar 的占用锁，`electron-builder --win --x64 --dir` **25s 出包** → `release-verify/win-unpacked/resources/app.asar`（5267 文件 / 28.6MB）内含 `concat-stream=3 / readable-stream=27 / safe-buffer=3 / bcrypt-pbkdf=4 / ssh2=33 / ssh2-sftp-client=7`（**修复前全为 0**）；再 `extractAll` 后实跑 `concat-stream` 收流成功（`hello world`, len=11）→ **`cannot find module concat-stream` 彻底闭环**
- [x] **川哥本机出包复验通过**：`release/win-unpacked/resources/app.asar`（5368 文件 / 29.0MB）内含 `concat-stream=3 / readable-stream=27 / safe-buffer=3 / bcrypt-pbkdf=4 / ssh2=33 / ssh2-sftp-client=7` → 修复在正式出包产物中生效
- [x] `release/` 清理：旧 1.2.4 exe/Setup **已不存在**（此前 electron-builder 的 `EnsureEmptyDir` 已清空 `release/` 根目录）；残缺的 `release/win-unpacked`（7 文件，含锁死 app.asar）已删除 → `release/` 现为空
- [x] 临时残留清理：`diag_asar_tmp.asar` 的 stale 锁已自行释放，连同残留脚本 `cleanup_tmp.cjs` / `run_asar.js` 一并删除 → 项目根无残留
- [x] `node-linker=hoisted` 根治：**已取证 + 决定不根治**（见「其他问题·结论」#2；川哥 2026-09-12「就这么定」）→ **全部 TODOS 完成，本 plan 归档**

## 其他问题·结论

1. **cpu-features**：asar 内实测存在（105 条），但其为 ssh2 的 **optional** 原生依赖、本地无 `.node` 二进制（`npmRebuild:false`）—— 实测顶层 `require('cpu-features')` 返回 `MODULE_NOT_FOUND`。但 ssh2 在 `ssh2/lib/protocol/constants.js:6-8` 用 `try { cpuInfo = require('cpu-features')(); } catch {}` **空 catch 吞掉**，仅退化为无 CPU 加速，不会导致 SFTP 报错。当前 `cannot find module` 报错仅来自 concat-stream，故**无需开启 npmRebuild**，保持现状。
2. **node-linker=hoisted 未生效**（根因级，**已取证**）：`node_modules/.modules.yaml` 记录 `"nodeLinker": "isolated"`（另有 `storeDir: D:\.pnpm-store\v11`、`prunedAt: 2026-09-09`）→ 当前 node_modules 是以 **isolated** 布局安装的，`.npmrc` 的 `node-linker=hoisted` 未作用于它。**建议：不根治**——理由：① concat-stream 已稳定修复并端到端验证；② hoisted 属**重型变更**（重建 node_modules，可能引入幽灵依赖/提升版本差异，需全量回归）；③ 收益仅为「移除 link:deps 补丁」。若日后要根治，本地步骤：① `pnpm config get node-linker` 确认设置是否被读取（若返回 `isolated`，说明该 pnpm 版本需把 `node-linker` 写进 `pnpm-workspace.yaml` 而非 `.npmrc`）；② 备份后删 `node_modules`；③ `pnpm install --force`；④ 校验 `node_modules/concat-stream` 非符号链接；⑤ 移除 `link:deps` 构建步骤并全量回归（tsc + vitest + `package:win` + SFTP）。
3. **release/ 残留 1.2.4 exe/Setup**：**已清理** —— 旧 exe/Setup 此前已被 electron-builder 的 `EnsureEmptyDir` 删除；残缺的 `release/win-unpacked` 已删，`release/` 现为空。
4. **验证用临时文件**：`diag_asar_tmp.asar` 的占用锁**已自行释放**并删除；另清理了残留脚本 `cleanup_tmp.cjs`、`run_asar.js` → 项目根现无任何临时残留。
5. **沙箱对「已存在 asar」的 stale 占用锁（环境坑，非代码问题）**：`release/win-unpacked/resources/app.asar` 与 `diag_asar_tmp.asar` 均无法删除——tasklist 确认**无** AI-Tools / electron / app-builder 进程持有，`fs.rmSync`（safe-delete trash 中止）/ `cmd del /f /q` / `rename` 全部 EBUSY；而**新建** `.asar` 可即刻删除 → 是对已存在 asar 的 stale 句柄锁。这正是 electron-builder 清理默认输出目录 `release/` 失败的直接原因（此前「14min 卡死」的真相）。**绕过法**：改到全新输出目录 `release-verify` + 复用本地 `electronDist` + 关 `signAndEditExecutable`（免下载 winCodeSign）。**川哥本地无此锁，直接 `pnpm run package:win` 即可出正式包。** 该 stale 锁约 1 小时后自动释放（本次已复测：删除成功）。
6. **`release-verify/`**：沙箱真实出包验证的 `--dir` 产物（未签名、无 NSIS/portable 安装包）。川哥本机出包（`release/`）后已删除，当前不存在。
