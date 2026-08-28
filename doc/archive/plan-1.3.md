# 计划 1.3：全功能扫描与工程优化计划

> 目标：对 AI-Tools（MCP Dock）主进程、渲染层、平台适配层与工程化配置做一次完整审计，产出可落地的优化清单。
> 范围：`src/main/**`、`src/renderer/src/**`、`src/main/platforms/**`、根目录工程配置。
> 状态：仅规划，未执行。
> 证据性质：以下每条均经**实际读源码或执行命令确认**，不含推测项。已核验的关键结论在文末「验证记录」列出复现命令。
> 生成时间：2026-08-25

---

## 〇、审计范围与代码规模

| 层 | 文件数 | 行数 | 测试覆盖 |
|---|---|---|---|
| `src/main/`（核心） | 14 | 9890 | 5/14 有测试 |
| `src/main/platforms/` | 8 | 1964 | **0** |
| `src/renderer/src/pages/` | 13 | 7224 | **0** |
| `src/renderer/src/components/` | 22 | 5604 | **0** |
| 合计 | — | ~25000 | 7 个测试文件 / 76 例 |

最大三个文件：`platform-skill-resolver.ts`(2274)、`pages/Library.tsx`(1905)、`skills-manager.ts`(1774)。

---

## 一、P0：数据丢失 / 安全漏洞 / 功能完全不可用

### P0-1　SFTP 启动拉取会静默清空本地暂存区
`src/main/cloud-sync-service.ts:456-461` + `src/main/index.ts:196-204`

`mirrorLocal` 对本地每一项调 `client.exists(remotePath)`，**catch 中把任何异常都当作「远端不存在」**（456-458），随后 `fs.rmSync(localPath, {recursive:true, force:true})`。网络抖动、权限错误、远端目录存在但为空时，启动时的自动 pull 会无确认地删掉整个 `~/.ai-tools/cloud/ai-tools`（用户的云库本地副本）。

> 修法：`exists` 失败必须中止本次镜像清理并向上报错；删除前要求远端 listing 成功且非空；删除改为移入 `.trash/<时间戳>/` 而非直接 rm。

### P0-2　Git 通道启动 pull 硬重置，丢弃未推送内容
`src/main/cloud-sync-service.ts:224`

`git reset --hard FETCH_HEAD` 在启动自动 pull 时直接执行。上一次会话 push 失败（任务被 `sync-task-manager.ts:57-64` 标记 failed 待重试）的本地改动会被无声抹掉。

> 修法：pull 前 `git status --porcelain` 非空则先提交到本地备份分支，再重置。

### P0-3　Skill 名未校验即 path.join，存在路径穿越与任意目录删除
`src/main/skills-manager.ts:238,243,252,308-313`、`src/main/index.ts:512`

- `installSkill` 用 `skillId.split('/').pop()` 直接当目录名；`sourceInfo.files` 来自**远端清单**并直接 `path.join(skillPath, file)`（252），含 `../` 的恶意清单可写到 skills 目录之外。
- `uninstallSkill(skillName)` 无任何校验就 `fs.rm(recursive, force)`（313）；IPC `skills:uninstall` 也无参数校验，`../../..` 类输入可删除目录外路径。
- 已存在的 `sanitizeSkillName`（327）只用于 create/update，**安装/卸载路径完全没走**。

> 修法：所有 skill 名统一过 `sanitizeSkillName`；写入/删除前 `path.resolve` 校验必须落在 skillsPath 前缀内，否则抛错。

### P0-4　客户端配置文件全部非原子直写
`src/main/config-manager.ts:1107,1130,1163,1199,1220,1232,1237`

写 Cursor / VS Code / Claude / Zed / Codex 配置一律 `fs.writeFile` 覆盖原文件，无临时文件 + rename，无写后校验。断电或崩溃会留下截断的 JSON/TOML，**用户的 AI 客户端直接起不来**。这是本产品最核心的写操作，风险最高。

> 修法：抽 `writeFileAtomic`（写 `.tmp` → fsync → rename）；rename 前对内容做 JSON/TOML 反解析自检。`cloud-sync-store.ts` 的 `persist()` 同样问题。

### P0-5　settings.json 可能被空对象覆盖，丢掉全部用户设置
`src/main/config-manager.ts:240,259-266`、`src/main/skills-manager.ts:125`

构造函数 fire-and-forget 调 `loadUserSettings()` 未被 await，`this.userSettings` 初值是 `{}`。若 `setCustomConfigPath`/`addCustomClient`（342/405）在加载完成前触发，`saveUserSettings` 会把 `{}` + 本次改动整份写回，抹掉 `customClients`、`customSkillsPaths`、`manualMcpServers`。

> 修法：load 改为可 await 的 `ready` Promise，所有写操作前 await；写入改为读-改-写 + 原子落盘。

### P0-6　百炼平台离线索引未进构建产物，列表永久为空
`src/main/platforms/bailian.ts:72`

代码读 `path.join(__dirname,'data','bailian-index.json')`，源文件在 `src/main/platforms/bailian/data/bailian-index.json`（106KB），但 **tsc 不拷贝 json**——`ls dist/main/platforms/` 只有 8 个 `.js`，无 data 目录。`loadIndex()` 静默 catch 返回 `[]`，百炼列表/详情/facets 全空且无任何报错。`package.json:87` 的 `files` 仅含 `dist/**/*`，打包后同样缺失。

> 修法：`build:main` 后加 copy 步骤（或开 `resolveJsonModule` 直接 import）；`loadIndex` 得到空数组时返回明确错误而非静默降级。

### P0-7　ClawHub 离线降级路径指向不存在的文件
`src/main/platforms/clawhub.ts:100,300`

路径解析为 `dist/main/platforms/clawhub/data/clawhub.json`，**全仓库无此文件**，`src/main/platforms/clawhub/` 目录也不存在。注释宣称「联网失败回退内置离线索引」，实际必然落到末尾返回空列表。

> 修法：补齐索引文件并纳入构建拷贝，或直接删除该分支避免误导维护者。

### P0-8　`.gitignore` 忽略 `.github`，仓库无法拥有 CI
`.gitignore:14`

该行使任何 workflow 文件都不会被提交；`.github` 目录确认不存在，仓库**零 CI**。同时 `package.json` 无 `lint`/`typecheck` 脚本，根目录无 eslint/prettier 配置。主进程 tsc 与 vitest 全靠人工执行。

> 修法：移除 `.gitignore:14`；加 workflow 跑 `tsc -p tsconfig.main.json --noEmit` + `tsc -p tsconfig.json --noEmit` + `vitest run`。

### P0-9　i18n：13 个 key 两侧都不存在，中文界面漏出 key 原文
`pages/History.tsx:109,161,228`、`pages/SkillDetail.tsx:320,324,343,358,595,604`、`pages/Detail.tsx:1086`、`pages/PlatformServerDetail.tsx:202,617`

i18next 对缺失 key **返回 key 字符串本身**（truthy），因此全项目 **304 处** `t('x') || '兜底'` 的兜底永远不生效。中文用户在历史页看到 `history.backups`、`history.skills`，安装成功提示显示 `skill.installSuccess`。

> 修法：① 补齐这 13 个 key 的 zh/en；② 全局把 `t('k') || '中文'` 改成 `t('k', {defaultValue:'中文'})`；③ 加脚本在 CI 校验代码引用的 key 是否都存在于 locales。

### P0-10　Library 列表项点击无法进入详情页（stale closure）
`pages/Library.tsx:322-324`

`useEffect(() => { loadData(); }, [api])` 只依赖 `api`，但 `loadData` 内部调用 `isMcpDockInstalled(config, id, serverLists)`。`serverLists` 由另一个 effect（`:299`）异步拉取，且未进 zustand persist 白名单（`store/useStore.ts:188-196`），冷启动时为空。首屏所有 server 的 `isMcpDock` 恒 `false`，`handleServerClick`（`:911-915`）直接 return，**点击无反应**；徽章也判错。

> 修法：`loadData` 用 `useCallback` 包住并把 `serverLists` 纳入依赖，或在 `serverLists` 变化时单独重算派生字段。

---

## 二、P1：功能缺陷 / 用户可感知问题

### 主进程

**P1-1　IPC push/pull 绕过队列串行保证** — `src/main/index.ts:933-939,196-204` vs `sync-task-manager.ts:154-190`
`cloud-sync:push/pull` 与启动 pull 都直接调 `cloudSyncService`，不入队。用户点同步时若队列正在跑 `cloud-push`，两个 git 进程同时操作 `~/.ai-tools/cloud` → `index.lock` 冲突；SFTP 则是 `uploadDir` 与 `mirrorLocal` 交叉。刚加的 enqueue 去重只在队列内部生效。
→ 所有 push/pull 入口一律走 `SyncTaskManager.enqueue`，service 层再加一把互斥锁。

**P1-2　gitPush 变更判定用错范围** — `cloud-sync-service.ts:241-245`
`git add -A <scope子目录>` 后用**不带 pathspec** 的 `git status --porcelain` 判断 `staged`，该命令包含其他 scope 的未追踪文件。因此 `staged` 为真不代表本 scope 有变更，「已上传/无需上传」提示（261）不可信。
→ 改用 `git diff --cached --quiet -- <scope>` 判定。

**P1-3　历史回滚覆盖不全且完全不恢复 Skill** — `history-manager.ts:121,297-305`
备份客户端硬编码只有 11 个，缺 vscode、kiro、trae-cn、marscode、jetbrains、antigravity、openclaw；`BackupData.skills` 有写入（151）但 `restore` 只遍历 `data.clients`，**Skill 变更无法回滚**。用户以为有兜底，实际大半客户端和全部 Skill 没有。
→ 客户端列表复用 config-manager 的单一清单；restore 补 Skill 目录快照（需改为存内容而非仅名字）。

**P1-4　凭据加密密钥无任何秘密材料** — `secret-store.ts:93-100`（`cache-manager.ts:135-146` 同）
`scryptSync([platform, arch, home].join('-'), 'mcp-dock-secret-v1')` — 密钥材料全是可公开推断的常量。任何能读 `~/.ai-tools/secrets/*.enc` 的本机进程都能重算密钥解出 SFTP 密码 / Git token / 私钥口令。**加密等同混淆**。
→ 改用 Electron `safeStorage`（OS 级钥匙串），或首次运行生成随机 key 交系统钥匙串保管，仅迁移期兼容旧密文。

**P1-5　Cursor 等客户端按纯 JSON 解析，含注释即整体读失败** — `config-manager.ts:1053`
默认分支用 `JSON.parse`（仅 Zed/Claude/opencode 走 jsonc，cursor/windsurf/trae/kiro/qoder 不走）。用户手写过注释或尾随逗号 → `readConfig` 抛错 → `writeConfig` 的 merge 兜底 catch（1092）静默吞掉 → **以「空 live 配置」为基准把用户原有 server 全丢**。
→ 所有 JSON 类客户端统一走 `jsonc.parse` + `jsonc.modify` 保留格式与注释。

**P1-6　IPC 缺参数校验可放大为任意文件写** — `index.ts:343-345,378-380,249-252`
`shell.openExternal(url)` 未做协议白名单；`addCustomClient` 接受任意 `configPath`，之后 `config:write` 即可把 JSON 写到该路径（如 `~/.bashrc`）。
→ openExternal 限 http/https；custom client 的 configPath 做后缀与目录白名单，写入前二次确认。

**P1-7　Skill 重命名用 cp + rm，中断即丢数据** — `skills-manager.ts:604-606`
`mkdir` → `fs.cp(recursive)` → `fs.rm(oldPath)`，cp 部分失败后**仍会执行 rm**（无回滚）。另 595 行条件 `newName !== originalName.toLowerCase() || newPath !== oldPath` 几乎恒真，大小写冲突保护形同虚设。
→ 同盘优先 `fs.rename`；跨盘则 cp 成功校验后再 rm。

### 渲染层

**P1-8　`lib/electron.ts` 的 mock 会静默顶替真实 API** — `lib/electron.ts:867-868`
`getElectronAPI() || mockAPI`。preload 注入失败（打包遗漏、`contextIsolation` 变更、sandbox 报错）时不报错，而是回落到 mock：`clients.getAll` 返回硬编码 Cursor/Claude Code 且 `installed:true`（`:481-499`）、`getPlatform` 返回 `'darwin'`（`:674`，Windows 上渲染 mac 交通灯留白）、`env.getAllRuntimes` 全部 `available:true`（`:657`）。**用户看到一个完全虚假的可用界面**。
→ 用 `import.meta.env.DEV` 门控 mock，生产环境缺 API 时抛错并渲染兜底页。

**P1-9　大量 catch 只 console.error，用户看不到失败原因** — `Library.tsx:379,445,457,903`、`Settings.tsx:146,202`、`SkillDetail.tsx:414`、`History.tsx:61`、`Detail.tsx:421`
其中 `Library:445/457` 与 `SkillDetail:414` 最严重：**卸载失败后仍走 `loadData()`/清空本地状态，界面表现与成功一致**。`Library:379` 初始加载失败仅置 `hasLoaded=true`，变成「暂无安装」空态。
→ 统一补 `toast.error`；卸载类失败不要提前清本地状态。

**P1-10　原生 alert/confirm 阻塞渲染进程且未 i18n** — `Library.tsx:429`、`History.tsx:72,75,79,134,138`、`Detail.tsx:409`、`SkillDetail.tsx:409`、`PlatformServerDetail.tsx:217`
`alert('Invalid JSON configuration')` 等硬编码英文；Electron 里原生弹窗阻塞渲染进程且样式与应用割裂。
→ 收敛到已有 `Modal` + `toast`。

**P1-11　手动创建的 Skill 发起注定 404 的头像请求** — `Library.tsx:147,161-169`
`author = skill.source?.id?.split('/')[0] || skill.name.charAt(0)`。手动 Skill 无 `source`，`author` 退化成**单个字符**，随后请求 `https://avatars.githubusercontent.com/{单字符}`。每个手动 Skill 一次外网失败请求 + 图标闪烁。
→ 无 `source` 时直接走首字母色块分支，不发请求。

**P1-12　Modal 无焦点陷阱、无 aria、CreateSkillModal 无 Esc** — `Modal.tsx:41,44-47`、`CreateSkillModal.tsx:221`
遮罩是带 `onClick` 的裸 `div`（无 role/tabIndex）；容器缺 `role="dialog"`/`aria-modal`；打开时不移入焦点，Tab 会跑到背后页面。`CreateSkillModal` 自建弹层，全文件无 `Escape` 监听。
→ Modal 加 `role="dialog" aria-modal="true"` + 首元素聚焦 + Tab 循环；CreateSkillModal 复用 `Modal`。

**P1-13　可点击 div 无键盘可达性** — `Library.tsx:1148,1295`、`ServerCard.tsx:149`、`SkillCard.tsx:137`、`SyncTasksPanel.tsx:151`、`CreateSkillModal.tsx:257`、`Settings.tsx:516`
全部 `<div onClick>`，无 `role="button"`/`tabIndex={0}`/`onKeyDown`。**纯键盘用户无法进入任何详情页**。
→ 换成 `<button>`，或补 role + tabIndex + Enter/Space 处理。

**P1-14　图标按钮缺 aria-label** — `CreateSkillModal.tsx:234,393`、`Modal.tsx:61`、`Toast.tsx:121`、`Library.tsx:1096`、`Settings.tsx:304`、`PlatformServerDetail.tsx:415`
屏幕阅读器只读到空按钮。`Library.tsx:981,997` 有 `title` 但仍缺 `aria-label`。
→ 补 `aria-label`（可复用现有 `title` 文案）。

### 平台适配层

**P1-15　全链路零重试，串行端点探测最坏阻塞 45 秒** — `platforms/shared.ts:210-307`、`skillsmp.ts:16-20`
全目录 grep 无任何 retry/backoff。`probeEndpoints` 串行 for 循环，单次超时 15s（modelscope 20s）；SkillsMP 配 3 个模板，全超时即 **45s 无法取消**，期间 IPC 悬挂。
→ 候选端点并发探测（`Promise.any`）或加总体预算上限；对 5xx/网络错误加 1-2 次指数退避。

**P1-16　3 处 fetch 无超时可无限悬挂，zip 下载无大小上限** — `platform-skill-resolver.ts:685,2101,2155`、`modelscope.ts:289`
8 处 `await fetch` 只有 6 个 AbortController。`:2155` 是 zip 下载，**无超时无 content-length 校验**，恶意/超大包可耗尽磁盘。`modelscope.ts:289` 的 `fetchSkillDetail` 既无超时也无任何调用方（死代码）。
→ 统一走 `shared.ts` 的 `fetchText/fetchJson`；zip 补大小上限；删死代码。

**P1-17　公共层已抽出但 resolver 未迁移，9 个函数双份实现** — `platform-skill-resolver.ts:927,1031,1037,1046,1147,1166,1216` vs `platforms/shared.ts:24,81,88,99,119,132,182`
`extractPageInfo`、`buildUrl`、`fillTpl`、`emptyPageInfo`、`fetchText`、`pickSkillLike`/`pickLike`、`locateSkillArray`/`locateArray` 各有两份且**签名已分叉**（resolver 的 `fillTpl` 无 sort/order 参数）。resolver 完全不走 registry，`index.ts:27/28` 同时 import 两套形成双轨。
→ 把 SkillHub/ClawHub 分支迁进对应 adapter，删重复工具函数，`index.ts` 只留 registry 通道。

**P1-18　ClawHub 在线路径写死 hasMore=false，无法翻第二页** — `platforms/clawhub.ts:208-212`
拿到结果后强制 `total=null; totalPages=null; hasMore=false`，单次 RPC limit 上限 100。**在线可用时反而比离线分支（`:271-277` 有真分页）能力更弱**。
→ 按 limit/offset 或 cursor 实现真分页，至少在 `items.length === limit` 时置 `hasMore=true`。

### 工程化

**P1-19　包管理器混用，两份 lockfile 同时被跟踪** — `package-lock.json`(422KB) + `pnpm-lock.yaml`(231KB)
`package.json:11` 声明 `packageManager: pnpm@11.22.0`，但 `:16` 的 build 脚本混写 `pnpm run build:main && npm run build:renderer`。两份 lock 会漂移，协作者装出不同依赖树。
→ 删 `package-lock.json` 并加入 `.gitignore`，build 脚本统一 pnpm。

**P1-20　主进程 tsconfig 缺未使用检查，已产生死代码** — `tsconfig.main.json`
无 `noUnusedLocals`/`noUnusedParameters`（渲染层 `tsconfig.json:15-16` 已开）。实证死代码：`bailian.ts:23` 的 `BAILIAN_ONLINE_URL` 定义后从未使用；`skillsmp.ts:89` `SKILLSMP_LANGUAGES` 仅回传前端无过滤实现；`platform-skill-resolver.ts:1517,1531` 的 `log` 被定义为空函数 `() => {}`（导致后台任务异常完全静默）。
→ 补齐两项并清理告警。

**P1-21　未使用依赖 13 个随包体分发** — `package.json:28-57`
逐个 grep 引用为 0：`node-fetch`、`asn1`、`bcrypt-pbkdf`、`tweetnacl`、`p-limit`、`mime-types`、`gray-matter`、`@rjsf/core`、`@rjsf/utils`、`@rjsf/validator-ajv8`、`react-markdown`、`rehype-raw`、`remark-gfm`。`@rjsf/*` 三件套 + react-markdown 生态体积可观（release 产物 116MB）。另 `@types/react-syntax-highlighter` 误置于 dependencies。
→ `depcheck` 复核后移除；types 包移入 devDependencies。

**P1-22　仓库存在调试残留，随时会被误 add** — `_verify/`(4 文件)、`package.json.bak`、`scripts/probe-ms-*.mjs`(12 个)
`git check-ignore` 确认 `_verify/main.js` 与 `package.json.bak` **均未被忽略**。`_verify/main.js:4` 硬编码绝对路径 `D:/moneyspace/mcp-dock/dist/...`。scripts 下另有 5 个 0 字节文件；`src/main/skill-sources-store.ts` 与 `components/SkillSourceManager.tsx` 也是 0 字节空文件且全仓无引用。
→ 删除 `_verify`、`package.json.bak`、全部空文件；probe 脚本移入 `scripts/dev/`；`.gitignore` 补 `_verify/`、`*.bak`。

---

## 三、P2：可维护性 / 技术债

### 结构性拆分

**P2-1　`platform-skill-resolver.ts` 2274 行缺乏边界**
顶层结构：URL 解析/HTML 提取(`:59-153`)、类型定义(`:332-544`)、MCP 搜索(`:547-908`)、分页工具(`:910-1180`)、SkillHub 专用(`:1182-1370`)、ClawHub 专用(`:1372-1608`)、统一分发(`:1616-2046`，`searchPlatformDirectPaged` 单函数约 390 行 if 链)、zip/skills.sh 安装(`:2048-2274`)。
→ 拆为 `resolvers/url-detect.ts`、`resolvers/install-zip.ts`、`platforms/skillhub.ts`/`clawhub.ts`（吸收专用分页），保留薄 facade 委托 registry。目标单文件 < 400 行。

**P2-2　`pages/Library.tsx` 1905 行职责混杂**
单文件承载 MCP tab + Skills tab + 编辑配置 + 两套同步 + 卸载客户端选择 + 云上传确认 + 冲突解决 + 创建/编辑 Skill，共 **33 个 useState**(`:219-271`)、**6 个 Modal**(`:1428/1455/1510/1575/1642/1679/1833`)。拆分点：
- `:88-178` `ServerIcon`/`SkillIcon` → `components/`（`SkillIcon` 与 `SkillCard` 内部图标重复）
- `:1122-1268` → `LibraryMcpList.tsx`；`:1269-1423` → `LibrarySkillList.tsx`
- `:266-296,741-877` 云同步逻辑 → `hooks/useCloudUpload.ts`
- `:1454-1639` 三个「选客户端同步」弹窗 → 一个 `ClientPickerModal`（三处 JSX 几乎逐行相同）
- `:1833-1903` 卸载弹窗 → `UninstallModal.tsx`

**P2-3　`config-manager.ts`(1477) 与 `skills-manager.ts`(1774) 职责混杂**
前者同时承担路径解析 + 客户端探测 + 多格式读写 + 用户设置持久化；后者混了 GitHub API 抓取 + HTML 解析 + **自研 ZIP 解包**(`:497-535`) + 本地文件管理 + 云冲突检测。
→ 按「路径解析 / 客户端探测 / 格式适配器 / 设置存储」与「远端发现 / 归档解包 / 本地存储」拆分；ZIP 换成成熟依赖。

### 重复代码

**P2-4　客户端路径解析散落三处且已不一致** — `config-manager.ts:152-236`、`skills-manager.ts:111-123`、`history-manager.ts:76-88`
各自硬编码一份 skills 路径表。history-manager 那份还完全无视 `customSkillsPaths`/`customClients`，备份统计因此漏算。
→ 抽 `shared/client-paths.ts` 单一来源。

**P2-5　客户端选择器在 8 处重复实现** — `Library.tsx:1480,1543,1610,1876`、`AddServerModal.tsx:312`、`CreateSkillModal.tsx:377`、`Detail.tsx:1067`、`PlatformServerDetail.tsx:603`、`SkillDetail.tsx:814`
同一套「ClientIcon + 名称 + 勾选态 + toggle」button 列表，样式类名逐字重复。
→ 抽 `ClientMultiSelect`，参数化 filter（installed / supportsSkills / 排除已装）与配色（同步蓝 / 卸载红）。

**P2-6　`McpSourceManager` 与 `ConnectionManager` 是同一份代码** — 445 行 vs 450 行
归一化 `mcpSource`/`skillSource` 前缀后 **184 行完全相同**（占各自 40%+）。locale 里 `mcpSource`(53 key) 与 `skillSource`(52 key) 也几乎一一对应。
→ 抽公共 `SourceManager<T>`，用 namespace + platformType 参数化。

**P2-7　`HistoryManager` 自建第二个 ConfigManager 实例** — `history-manager.ts:52`
与 `index.ts:40` 的全局实例各持一份 `userSettings` 与 `clientsCache`。用户改了自定义路径后，备份/恢复仍走旧实例的旧缓存路径。
→ 改依赖注入传入全局实例。

### 正确性小缺陷

**P2-8　`writeConfig` 缓存失效只对默认分支生效** — `config-manager.ts:1238`
`invalidateClientsCache()` 在函数末尾，前面 7 个分支（jetbrains/codex/openclaw/opencode/claude-code+zed/vscode/servers-key）都提前 `return` → 缓存不失效 →「配置存在」状态本会话内一直是旧值。
→ 用 try/finally 包裹，或移到 `ensureConfigDir` 之后。

**P2-9　MCP 请求超时定时器不清理** — `mcp-client.ts:452-457,511-523`
`sendRequest` 每次注册 30s `setTimeout`，响应正常返回时只 delete map，**不 clearTimeout**。Inspector 高频调用工具时累积大量待触发定时器。
→ timer 句柄存进 `pendingRequests`，resolve/reject 时 clearTimeout。

**P2-10　manifest 在 scope 化上传下永远传不上去** — `cloud-sync-service.ts:474-488` + `shared/sync-scope.ts:19-22`
manifest 写到 `stagingDataDir/manifest.json`，而 `resolveScopeDirs` 在 scope=mcp/skills 时只上传子目录。清单文件白写。
→ manifest 下沉到各 scope 子目录，或仅全量 push 时写。

**P2-11　`safeskill` 平台复用 SkillHub adapter，来源标记错误** — `platforms/registry.ts:21`
`safeskill: skillhubAdapter` 占位，导致 safeskill 结果 `source` 被写成 `'skillhub'`（`skillhub.ts:173`），前端来源筛选与详情跳转会错。
→ 未实现的平台从 registry 移除并在 UI 隐藏，而非静默别名。

**P2-12　ModelScope MCP 详情返回硬编码安装命令** — `platforms/modelscope.ts:257-271`
`fetchServerDetail` 不发请求，直接返回 `description:''` 与恒定的 `npx -y @modelscope/mcp-server --repo <id>`。
→ 调真实详情接口，或标记为不支持并让 UI 降级到「跳转官网」。

**P2-13　字段映射为纯手写 `||` 链，上游缺字段静默降级为空串** — `modelscope.ts:79-101,115-132`、`clawhub.ts:73-96`、`skillhub.ts:165-187`、`skillsmp.ts:117-134`
五个 adapter 各写一份 `mapEntry`，均无必填校验：`id` 全部兜底 `''`。**空 id 会一路流到详情页与安装逻辑**。`shared.ts:119` 的 `pickLike` 只要求存在 name/title/id/slug/repo 之一，拦不住空值。
→ 抽 `mapCommon(raw, fieldMap)` + 必填断言，映射失败返回 null 并计入诊断。

**P2-14　`extractPageInfo` 候选键覆盖 6 层结构，行为不可预测** — `platforms/shared.ts:132-179`
单函数用 `json?.data?.pagination || json?.pagination || json?.Data?.McpServer || json?.Data || json?.data || json || {}` 兼容全平台，`hasMore` 有 4 条互斥推断路径；`locateArray`(`:99-116`) 试探 9 个候选键。上游任一层变动都会静默取到错误分页。
→ 每 adapter 声明自己的 `pageInfoPath`，共享层只做纯计算 + 针对性单测。

**P2-15　HTML 解析全靠正则，上游改版即失效** — `platform-skill-resolver.ts:88-152`
`extractGithubUrls`/`extractDirectLinks`/`extractInlineJson` 用 4 条正则扫原始 HTML 与 `<script>` 块，匹配 `window.__`/`__NEXT_DATA__` 等框架内部约定，无 schema 校验无版本兜底。
→ 优先走 JSON 接口，正则仅兜底，提取结果做形状校验后再进安装流程。

**P2-16　ClawHub 后台补全无并发保护与错误上报** — `platform-skill-resolver.ts:1516-1528,1551`
`void completeClawhubInBackground(state)` fire-and-forget，最多翻 500 页；catch 里的 `log` 在 `:1517` 是空函数，**异常完全静默**。缓存 TTL 10 分钟内窗口重叠可能重复启动。
→ 加单例 flag 与真实日志，失败写入 diagnostics 供前端展示。

**P2-17　缓存 key 类型与实际平台不匹配，新平台无法缓存** — `cache-manager.ts:54-60,389`
`CacheKey` 字面量只枚举 `official`/`smithery`/`skills` 三系。五个新平台适配器全部不走 CacheManager，各自用模块级变量（`clawhubCache`）或每次重新 fetch。
→ `CacheKey` 泛化为 `${string}-index`/`${string}-detail-${string}`，让 adapter 统一接入 SWR。

### 渲染层技术债

**P2-18　列表 key 用 index** — `AddServerModal.tsx:260`（env 变量行，**删中间项后输入框内容错位**）、`OfficialConfigForm.tsx:319,365`、`Inspector.tsx:519`、`Detail.tsx:712,733,976`、`Settings.tsx:327`
→ 为 env 行生成稳定 id。

**P2-19　StoreGrid 的 key 掺入 index，抵消 memo 优化** — `StoreGrid.tsx:37,47,58`
`key={\`${currentPage}-${index}-${server.id}\`}` 使翻页/筛选后所有卡片强制重建，`memo(ServerCard)`(`ServerCard.tsx:257`) 白做。`:58` 的容器 key 让整个网格每页重挂载。
→ key 改为 `server.id`/`skill.id`。

**P2-20　大列表无虚拟化** — `Library.tsx:1144,1291`、`Inspector.tsx:795`
Library 直接 `.map()` 渲染全部条目，每行含 `ServerIcon`（2 个可能失败的 `<img>`）与 6 个 svg 按钮。
→ 列表项抽 `memo` 组件；上百条时接 `react-window`。

**P2-21　类型断言绕过空值检查** — `Detail.tsx:441-443,453-454,734,848,899`、`SkillDetail.tsx:466,636,678`、`PlatformServerDetail.tsx:456`、`CreateSkillModal.tsx:204`；`as any`：`Library.tsx:96`、`Detail.tsx:383`、`store/useStore.ts:203,207,215`
→ 用类型守卫 / 可选链 + 早返回替代 `!`；`ServerListItem` 补 `repository` 字段消除 `Library.tsx:96` 的 `as any`。

**P2-22　类组件与工具组件文案硬编码中文** — `ErrorBoundary.tsx:38,44`、`WindowControls.tsx:31,41,58`、`Pagination.tsx:68,100`、`SyncTasksPanel.tsx:26-29`、`PlatformConnectionBrowser.tsx:82,114,121,125-128,138,160-161,235`（共 15 处）
英文界面下这些位置直接漏出中文。
→ 用 `withTranslation()` HOC 或把文案作为 props 传入。

**P2-23　Inspector 的 errorMessage 被丢弃** — `Inspector.tsx:131`
`const [, setErrorMessage] = useState<string>('')`，`:207,294` 写入的错误信息无处读取，UI 仅靠状态灯变红表达失败。
→ 删掉该 state 或在头部展示错误摘要。

**P2-24　`useStoreFacets` 的 enabled 永远为 true** — `hooks/useStoreFacets.ts:86`
`enabled: resourceType === 'mcp' ? true : true`，三元两支相同，未完成的逻辑残留。

**P2-25　Store 页两个安装态查询无错误处理** — `pages/Store.tsx:89-99`
两个 `useEffect` 的 `.then()` 都没 `.catch()`，IPC 失败产生 unhandled rejection，「已安装」徽章静默失效。

**P2-26　useEffect 缺依赖** — `History.tsx:34-36`、`Layout.tsx:42-44`、`PlatformServerDetail.tsx:116-120`（已用 eslint-disable 压制）
loader 闭包捕获 `api`/`t` 却不在依赖里。当前 `api` 引用稳定所以未暴露，但 mock/真实 API 切换或语言变更时会用到旧闭包。

---

## 四、测试覆盖缺口

现有 7 个测试文件（`vitest run` 实测 **76 passed**）覆盖：`cloud-sync-service`（scope 隔离）、`env-manager`、`history-manager`、`skills-manager`、`sync-task-manager`（去重）、`shared/frontmatter`、`renderer/lib/localizedText`。

### 零测试的关键模块

| 文件 | 行数 | 风险 |
|---|---|---|
| `src/main/platform-skill-resolver.ts` | 2274 | 最大文件，全平台抓取/解析/安装 |
| `src/main/config-manager.ts` | 1477 | **直接改用户磁盘上的客户端配置** |
| `src/main/index.ts` | 999 | 全部 IPC handler 入口 |
| `src/main/mcp-client.ts` | 572 | MCP 协议连接与工具调用 |
| `src/main/cache-manager.ts` | 478 | AES-256-GCM 加解密、密钥派生 |
| `src/main/connections-store.ts` | 453 | 连接凭证持久化 |
| `src/main/secret-store.ts` | 309 | API 令牌存储 |
| `src/main/cloud-sync-store.ts` | 189 | 同步配置持久化 |

- `src/main/platforms/` **全目录 1964 行零测试**：`shared.ts`(341)、`clawhub.ts`(324)、`modelscope.ts`(297)、`skillhub.ts`(259)、`bailian.ts`(227)、`skillsmp.ts`(202)、`registry.ts`(53)。
- 渲染层 55 个 `.ts/.tsx` 中仅 `lib/localizedText` 被间接测到；`vitest.config.ts:6` 是 `environment:'node'` 未配 jsdom，**当前无法测组件**。

### 补测优先级

1. `platforms/shared.ts` 的 `extractPageInfo`/`locateArray` — 纯函数，成本最低收益最高，直接防住 P2-14
2. 各 adapter 的 `mapEntry` — 喂缺字段/空 payload 断言不崩（防 P2-13）
3. `cache-manager` 加解密与版本失效
4. `config-manager` 配置读写（tmpdir fixture，配合 P0-4 原子写一起做）
5. 加 jsdom 环境后补渲染层关键 hook

---

## 五、执行顺序建议

| 阶段 | 内容 | 依据 |
|---|---|---|
| **第一批（止血）** | P0-1 P0-2 P0-4 P0-5 P0-3 | 会造成用户数据丢失或安全漏洞，且改动范围可控 |
| **第二批（功能可用）** | P0-6 P0-7 P0-9 P0-10 P1-5 P1-8 P1-9 | 用户当下就能感知的失效（百炼空列表、点击无反应、key 漏出、配置被吞） |
| **第三批（基础设施）** | P0-8 P1-19 P1-20 P1-21 P1-22 + 测试第 1、2 项 | 建立 CI 后续改动才有护栏；先清残留降噪 |
| **第四批（可靠性）** | P1-1 P1-2 P1-3 P1-4 P1-6 P1-7 P1-15 P1-16 P1-18 | 需要设计取舍（safeStorage 迁移、队列互斥、并发探测） |
| **第五批（重构）** | P2-1 P2-2 P2-3 P2-4 P2-5 P2-6 | 大范围改动，必须在 CI + 测试就位后再动 |
| **第六批（打磨）** | 其余 P1 无障碍项与全部 P2 | 可穿插在日常迭代中 |

> 强烈建议：**P2 的重构类条目（P2-1 ~ P2-6）不要在第三批 CI 与测试就位前动手**，否则无回归护栏。

---

## 六、验证记录

以下结论均由命令实测确认，可复现：

```bash
# P0-6：dist 中无 bailian 索引（输出为空），源文件存在（106800 字节）
find dist -name "*.json" -path "*bailian*"        # → 空
ls dist/main/platforms/                            # → 仅 8 个 .js，无 data/
ls -la src/main/platforms/bailian/data/            # → bailian-index.json 106800

# P0-7：全仓无 clawhub.json
find . -name "clawhub.json" -not -path "./node_modules/*"   # → 空

# P0-8：.gitignore 第 14 行忽略 .github；无 eslint/prettier 配置
grep -n "github" .gitignore                        # → 14:.github
ls -a | grep -iE "eslint|prettier"                 # → 空

# P0-9：history.backups 在两个 locale 文件中均不存在
grep -c "\"backups\"" src/renderer/src/locales/{zh,en}.json   # → 0 / 0

# P1-19：两份 lockfile 均被 git 跟踪
git ls-files | grep lock    # → package-lock.json, pnpm-lock.yaml

# 现有测试基线
npx vitest run              # → 7 files, 76 passed
```

# 第五批重构（P2-1~P2-6）验证（2026-08-25）
# 采用「薄 facade + 叶子模块抽取」零行为变更策略，外部 import 不变
npx tsc -p tsconfig.main.json --noEmit   # → exit 0
npx tsc -p tsconfig.json --noEmit        # → exit 0
npx vitest run                            # → 10 files, 103 passed

# P2-1 platform-skill-resolver.ts（2274 行）→ src/main/resolvers/ 8 个叶子模块 + 41 行薄 facade
# P2-3 config-manager.ts（~1488）→ 763 行 facade + src/main/config/{types,client-probe,format-adapters,settings-store}.ts
#      skills-manager.ts（~1774）→ 1041 行 facade + src/main/skills/{types,local-store,conflict,html-parse}.ts
#      （archive.ts / github.ts 已在 P1-17 抽取，本批沿用）
# P2-2 Library.tsx（~1832）→ 1230 行编排器 + 7 个提取件：
#      components/{ServerIcon,SkillIcon,LibraryMcpList,LibrarySkillList,ClientPickerModal,UninstallModal}.tsx + hooks/useCloudUpload.ts
# P2-4 src/main/client-paths.ts 单一来源（computeDefaultSkillsPaths / resolveSkillsPath）
# P2-5 components/ClientMultiSelect.tsx 复用 9 处客户端选择器
# P2-6 components/SourceManager.tsx 合并 McpSourceManager 与 ConnectionManager

已直接读源码确认的位置（抽样）：
- `cloud-sync-service.ts:456-461` — `catch { remoteExists = false }` 紧接 `fs.rmSync(recursive, force)`
- `config-manager.ts:1232,1237` — 两处 `await fs.writeFile(configPath, content)` 无原子保护；`:1238` 的 `invalidateClientsCache()` 在 `:1233` 的 `return` 之后不可达
- `secret-store.ts:93-100` — `scryptSync([platform, arch, home].join('-'), 'mcp-dock-secret-v1')`
- `Library.tsx:322-324` — `useEffect(() => { loadData(); }, [api])`
- `lib/electron.ts:867-868` — `return getElectronAPI() || mockAPI`

---

## 七、进度跟踪 (TODO)

> 本计划的 58 条问题已同步为任务系统中的逐条 TODO（前缀即条目 ID，如 `P0-1`），可勾选推进。下表为批次视图与实时计数。

### 计数看板
| 批次 | 范围 | 条目 | 状态 |
|---|---|---|---|
| 第一批 止血 | P0-1~P0-5 | 5 | ✅ 已完成（2026-08-25） |
| 第二批 功能可用 | P0-6,7,9,10 + P1-5,8,9 | 7 | ✅ 已完成 |
| 第三批 基础设施 | P0-8 + P1-19,20,21,22 + 测试1/2 | 6 | ✅ 已完成（2026-08-25） |
| 第四批 可靠性 | P1-1,2,3,4,6,7,15,16,18 | 9 | ✅ 已完成（2026-08-25） |
| 第五批 重构 | P2-1~P2-6 | 6 | ✅ 已完成（2026-08-25） |
| 第六批 打磨 | 其余 P1 无障碍 + 其余 P2 | 25 | ⬜ 未开始 |
| **合计** | | **58**（已完成 33） | ✅ 33 / ⬜ 25 |

### 批次 → 任务系统 TODO 映射
- **第一批**：P0-1, P0-2, P0-3, P0-4, P0-5
- **第二批**：P0-6, P0-7, P0-9, P0-10, P1-5, P1-8, P1-9
- **第三批**：P0-8, P1-19, P1-20, P1-21, P1-22, (测试) shared.extractPageInfo / adapter.mapEntry
- **第四批**：P1-1, P1-2, P1-3, P1-4, P1-6, P1-7, P1-15, P1-16, P1-18
- **第五批**：P2-1, P2-2, P2-3, P2-4, P2-5, P2-6
- **第六批**：P1-10~P1-14, P1-17, P2-7~P2-26（共 25 条）

> 执行原则：第五批（大重构）务必在第三批 CI + 测试就位后再动手，否则无回归护栏。

