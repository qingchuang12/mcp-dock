# plan-7.1 · 商店 Skill 安装成功率修复（GitHub 枚举抗抖动 + zip 安装元数据 + zip 解压去外部进程）

> 版本：7.1（2026-09-10）· 前任：[archive/plan-6.1.md](archive/plan-6.1.md)（假成功修复 / 虾评下载安装 / 平台源磁盘缓存 / 已安装标识）
>
> 触发：用户报告「商店-skills 的虾评和 modelscope 安装 skill 都基本失败了」。
>
> **7.0 → 7.1 修订**：QA 证伪「332 用例全绿」后查出 zip 解压依赖外部进程（D8，~15% 偶发红）；
> 据此复用同一缺陷类排查，又查出 `resolveZipSkill` 的并发互毁（D9）与分支臆造（D10），
> 一并收口（T9/T10），并补独立复核（T11）。

## 背景与目标

### 一、ModelScope「基本失败」——根因已实证（本轮核心）

本机网络到 `api.github.com` **间歇性连接失败**，而目录枚举采用「多次串行请求 + 静默吞错」，
把网络抖动放大成安装失败。三轮真实网络实测：

**（1）单请求失败率（12 次，6 个 URL × 2 轮）**

| 指标 | 实测 |
|---|---|
| 成功 / 失败 | 8 / 4 → **失败率 33%** |
| 失败形态 | `TypeError: fetch failed` |
| 失败耗时 | 稳定 ~10.5s（10544–10572ms） |
| 耗时 min / 中位 / max | 122ms / **6277ms** / 10572ms |

**（2）端到端 6 轮（deep skill：`anthropics/claude-plugins-official` → `plugins/skill-creator/skills/skill-creator`）**

| 轮次 | 结果 | 耗时 |
|---|---|---|
| #1 | 文件 **13** 个（应 18，缺 5） | 38406ms |
| #2 | 文件 18 个 ✅ | 4382ms |
| #3 | 文件 18 个 ✅ | 858ms |
| #4 | 文件 **8** 个（缺 10） | 852ms |
| #5 | resolve ✗ `No SKILL.md found in this repository` | 2865ms |
| #6 | resolve ✗ 同上 | 899ms |

→ **解析失败率 2/6 = 33%**；其余轮次文件清单随机残缺。

**（3）对照**：`amap-lbs-skill`（15:35 装成功）仓库根级只有 1 个 SKILL.md，请求数少 → 成功。
**子目录越深越容易炸**，这正是「**基本**失败」而非全失败的原因。

### 三个放大缺陷

| # | 位置 | 问题 |
|---|---|---|
| D1 | `github.ts:339` `listDirFiles` | **逐目录串行递归**（1 次顶层 + N 个子目录）。5 子目录时全部成功概率 ≈ 0.67⁶ ≈ **9%** |
| D2 | `github.ts:348` `catch { return [] }` | **把网络失败当成「目录为空」**，静默丢弃整棵子树（#4 丢 10 个即此因） |
| D3 | `github.ts:287/295/302` `findSkillDirs` | 三层兜底全失败后返回 `[]`，上层报 **`No SKILL.md found in this repository`** —— 与事实不符的误导性错误 |

### 二、虾评——链路实测**完全正常**，未发现缺陷

用本机已绑定 key 实测（该 key 已在诊断后立即销毁，未留痕）：

| 环节 | 实测结果 |
|---|---|
| `GET /api/skills` 列表 | 200，12 条/页，total 2265，`id` 为 UUID |
| `GET /api/users/coins` | 200，**余额 28**（注册 +30，装 Agent自我进化 -2）→ 排除余额不足 |
| `GET /api/auth/me` | 200，token 有效 |
| `GET /api/skills/{id}/download` | 200，`{success:true,data:{download_url,version,coins_spent:0,is_update:true}}` |
| 响应体 vs `coze.ts` 解析 | **逐字段吻合**（`json.success` + `json.data.download_url`） |
| zip 直链下载 | 200，24314B，合法 zip（魔术字节 `504b0304`），`application/zip` |
| zip 结构 | 16 项，**根级 `SKILL.md`** |
| `findSkillRootDir` | 栈式搜索 + 大小写不敏感 → 可正确定位 ✅ |
| 前置映射 | `PLATFORM_SKILL_DOWNLOAD=['coze']` ✅、`platformTypeToSupported('coze')→'coze'` ✅ |
| 反向证据 | `~/.workbuddy/skills/Agent自我进化`（15:16）即经虾评通道装成功 |

**结论**：虾评安装链路当前**端到端可用，未复现失败**。用户侧的具体报错待补证（见 TODOS T6）。

### 三、附带查出的 zip 安装缺陷（用户已确认一并修）

| # | 位置 | 问题 |
|---|---|---|
| D4 | `skills-manager.ts:1312` | `branch: 'master'` **硬编码**（GitHub 默认 `main`，对虾评无意义） |
| D5 | `skills-manager.ts:1316` | `files: []` **恒空** → `.source.json` 不记录实际装入清单 |
| D6 | `skills-manager.ts:1314` | `rawBaseUrl` 存**预签名直链**（该例 `sign` 约 16:16 即过期）→ 后续更新/校验必然失败 |
| D7 | `skills-manager.ts:1217/1333` | `tmpRoot` 为**固定共享目录**且 `finally` 无条件 `rm -rf` → 并发/重试时互相摧毁 |
| D8 | `skills-manager.ts:1288`<br>`resolvers/install-zip.ts:185` | zip 解压 **shell out 外部进程**（`execFile('tar')` / `PowerShell Expand-Archive`）：PATH 首位的 GNU tar 读不了 ZIP 必然失败 → 退到 PowerShell（Windows 独有，Linux 必失败），且并行安装时进程争用 → 测试 ~15% 偶发红 |
| D9 | `resolvers/install-zip.ts:117/249` | `resolveZipSkill` 复用同一个共享 `tmpRoot`，`finally` 却 `rm -rf tmpRoot` → **与 D7 同类**的并发互毁（zip 直链通道） |
| D10 | `resolvers/install-zip.ts:233` | `branch: 'master'` **在 zip 通道再次臆造**（该通道无 Git 语义）→ 顺 `SkillDetail.tsx:211→249→450` 传入 `installFromDiscovered`，写进 `.source.json`，**抵销 D4 的修复** |

## 范围与边界

**做**
- `github.ts` 目录/文件枚举改为**单请求取全树**（`GET /git/trees/{ref}?recursive=1`），替代 1+N 次串行
- GitHub 请求加**指数退避重试**（针对 `fetch failed` / 超时，瞬时抖动重试极有效）
- **失败与「空」必须区分**：不再静默 `return []`；错误信息如实（网络失败不得谎报「仓库无 SKILL.md」）
- `installSkillFromZip` 元数据修复（D4/D5/D6）+ 临时目录按安装隔离（D7）
- zip 解压改为**项目自带纯 Node 解包器**（修 D8），消除外部进程依赖与跨平台缺陷
- `resolveZipSkill` 同源收口：临时目录隔离（修 D9）+ 不再臆造分支（修 D10）

**暂不做**
- 不改渲染层 UI 结构（本轮零 UI 改动）
- 不引入新依赖
- 不重构 `resolveFilesViaRaw` 为 codeload zip 兜底（用户未选该方案，记入后续观察）

## 实现思路

### 触点
| 文件 | 改动 |
|---|---|
| `src/main/github.ts` | 新增 `fetchGitHubTree()`（trees API 单请求）；`listDirFiles` 与 `findSkillDirsViaContents` 优先走它；新增 `githubFetchWithRetry()`；`catch` 改为**传播失败**而非返回 `[]` |
| `src/main/skills-manager.ts` | `installSkillFromZip`：`branch` 取真实默认分支；`files` 写实际清单；`rawBaseUrl` 改存可复现地址；`tmpRoot` 加随机 token 隔离 |
| `src/main/archive.ts` | 新增 `extractZipToDir()`（从 skills-manager 上提为公共工具，供两条 zip 通道复用） |
| `src/main/resolvers/install-zip.ts` | 解压改走 `extractZipToDir`（去掉 `tar`/`PowerShell`）；`finally` 只删私有 `extractDir`；`branch` 不再臆造 |
| `src/main/resolvers/*` | 错误信息区分「网络失败」与「确实无 SKILL.md」 |

### 步骤
1. 先落测试（复现 33% 抖动下的行为）：枚举失败必须**抛错**而非返回空
2. `githubFetchWithRetry`：重试 3 次、退避 300/900/2700ms、仅对网络类错误重试
3. `fetchGitHubTree`：单请求拿 `tree[].path`，按 `skillPath` 前缀过滤 → 替代递归
4. `listDirFiles` / `findSkillDirs` 接入 trees 优先 + 失败传播
5. `installSkillFromZip` 四项元数据/临时目录修复
6. zip 解压统一收敛到 `extractZipToDir`（纯 Node），移除两条通道的外部进程依赖
7. `resolveZipSkill` 同源收口：`finally` 只删私有 `extractDir`、`branch` 不再臆造
8. 自检：`tsc` 双配置 + 全量 vitest（连跑多轮排除偶发）
9. 独立验证：变异测试证明新增回归用例确实能捕获缺陷（非空转用例）

### 取舍
- **trees API 的代价**：大仓库 `recursive=1` 响应较大（该仓库 11MB，tree 响应可接受）；用 `truncated` 字段判定，截断时回退递归
- **不改成 codeload zip 兜底**：改动面大，本轮先做低风险高收益项
- **`resolveZipSkill` 的 `files: []` 不改**：zip 直链通道的「安装前文件清单」为空属既有限制，安装时 `installSkillFromZip` 会从磁盘重新枚举实际清单，不影响装出来的结果，故不扩大本轮范围

### 风险与回滚
- 风险：trees API 对超大仓库返回 `truncated:true` → 已设计回退路径
- 回滚：改动集中在 `github.ts` / `skills-manager.ts` / `archive.ts` / `resolvers/install-zip.ts` 四个文件，可按文件单独回退

## TODOS

- [x] T1 `githubFetchWithRetry`：指数退避重试（仅网络类错误）
- [x] T2 `fetchGitHubTree`：trees API 单请求取全树 + `truncated` 回退
- [x] T3 `listDirFiles`：改用 trees 优先；失败**传播**而非静默返回 `[]`（修 D1/D2）
- [x] T4 `findSkillDirs`：同上接入；错误信息区分「网络失败」与「确实无 SKILL.md」（修 D3）
- [x] T5 `installSkillFromZip`：branch 不硬编码 / files 写实际清单 / rawBaseUrl 不存过期直链 / tmpRoot 隔离（修 D4–D7）
- [ ] T6 **待用户补证**：虾评失败的具体报错文案或触点（当前实测链路全通，无法复现）
- [x] T7 自检：`tsc -p tsconfig.main.json` + `tsc -p tsconfig.json` + 全量 vitest
- [x] T8 QA 回归：新增单测覆盖「枚举失败必须抛错」「重试生效」「trees 截断回退」
- [x] T9 zip 解压去外部进程：新增 `archive.ts:extractZipToDir`，两条 zip 通道改用纯 Node 解包（修 D8，消除 ~15% 偶发红）
- [x] T10 `resolveZipSkill` 同源收口：`finally` 只删私有 `extractDir`（修 D9）+ `branch` 不再臆造（修 D10）+ 确定性回归用例
- [x] T11 独立复核：变异测试证伪回归用例有效性 + vitest 连跑 3 轮（340/340）+ 双 tsc exit 0

> **T6 仍开放**：虾评链路所有环节均已实测通过（余额 28 / token 有效 / 下载 200 / zip 完好 / 根目录定位正确），
> 反向证据亦有（`Agent自我进化` 15:16 经该通道装成）。**无用户侧报错文案则无法定位，不做推测归因。**
