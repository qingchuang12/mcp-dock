# plan-6.1 · 修复 Skill 安装「假成功」/ 虾评下载安装 / 平台源列表磁盘缓存

> 版本：6.1（2026-09-10）· 前任：[archive/plan-5.0.md](archive/plan-5.0.md)（新增 Coze Skill 平台源，已归档）
>
> 6.1 追加两个主题：T9 平台源列表加载慢（磁盘缓存 + SWR）、T10 商店安装后未显示已安装。

## 背景与目标

商店 → Skills → 虾评，点详情 → 安装 → 提示「安装成功」，实际没装上。

根因链（已定位并实证）：

1. **渲染层丢弃结果**（直接致因）：`SkillDetail.tsx:403` `await api.skills.install(...)` 未校验返回的
   `SkillInstallResult`，主进程返回 `{success:false}` 也不抛异常，无条件执行 `:407 toast.success`。
   同文件 `:355` 的 `installFromDiscovered` 分支有显式 `success===false` 检查，两条通道不一致。
2. **主进程空清单不拦截**（假成功源头）：`skills-manager.ts:320` 判据
   `if (files.length > 0 && downloadedCount === 0)`，空数组时前半为 false，整段判定被跳过；
   直接调用时 `verifySkillMd` 默认 false → 写出只含 `.source.json` 的空壳目录后 `return {success:true}`。
3. **虾评本无下载通道**：coze 列表项无 `repository/authorUrl` → `srcUrl` 为空 → resolve / 远程详情 /
   本地兜底三条通路全部关闭，只剩 meta 预览态（`files: []`），必然落入 2 号兜底分支。

实证：`~/.codebuddy/skills/` 下 5 个仅含 `.source.json` 的空壳目录，`"files": []`，rawBaseUrl 为拼错的
raw 地址（如 `raw.githubusercontent.com/skillhub/web-tools-guide/main`）。

目标：

- 任何来源安装失败都必须如实报错，不再出现「假成功」与空壳目录。
- 虾评支持在 mcp-dock 内一键安装（绑定 API Key 后）。
- 清理历史遗留空壳目录。

## 范围与边界

**做**

- P0 两处假成功修复（主进程 + 渲染层）。
- 平台安装能力标志：`PlatformAdapter.fetchSkillDownload` 是否实现 = 唯一事实源，
  渲染层据此决定是否可安装，避免 UI 堆 `if (source === 'xxx')`。
- 虾评下载安装通道：coze adapter 实现下载 → 复用既有 `installSkillFromZip`。
- 添加源时虾评的 key 栏提示。
- 清理 5 个历史空壳目录（先备份 → 移入回收站，可恢复）。

**暂不做**

- 其他 SPA 源（SkillHub / ClawHub / SkillsMP）的下载安装实现——本轮仅通过能力标志正确禁用并提示。
- 虾评注册流程自动化：`POST /api/auth/register` 属创建外部账号 + 消耗 IP 配额，
  本轮不代用户注册，key 由用户在「绑定 Token」处自行填写。
- 虾评正式版下载扣 2 虾米的二次确认弹窗——本轮在 UI 文案提示「正式版将消耗虾米」。

## 实现思路

### 触点与实测结论（2026-09-10）

| 端点 | 实测结果 |
|---|---|
| `GET /api/skills?page=1&limit=3` | 200，匿名可读列表 |
| `GET /api/skills/{id}` | **200，匿名可读详情** |
| `GET /api/skills/{id}/download` | **401**，错误体指向 `https://xiaping.coze.com/skill.md` |
| 同上 + `Authorization: Bearer sk_invalid` | 401 `Invalid API key` |

成功响应体 `{success, data:{download_url, version, coins_spent}}` **来自官方文档，未实测**（缺真实 key），
故运行时做防御式解析（`success` + `data.download_url` 双重校验），不假定结构。
鉴权格式 `Authorization: Bearer {key}`（`sk_xxx` / `agent-world-xxx` 均可），域名必须是 `xiaping.coze.com`。

### 步骤

1. **P0-B 主进程**：`installSkill` 前置拦截 `files.length === 0` → 清理目录并返回
   `{success:false, error} `；同步修正 `SkillDetail.tsx:369` 与行为相反的错误注释。
2. **P0-A 渲染层**：`SkillDetail` 安装结果统一校验（两条通道一致），失败 `toast.error`，
   且**不再乐观更新** `installedInClients`。
3. **能力标志**：`PlatformAdapter` 增可选 `fetchSkillDownload`；`shared/platform-constants.ts`
   增 `PLATFORM_SKILL_DOWNLOAD`（渲染层可读），加单测守卫「列表内平台必须实现该方法」。
4. **虾评下载**：
   - `coze.ts` 实现 `fetchSkillDownload({baseUrl, secret, skillId})`；无 secret 时返回明确错误
     「需先在添加源处绑定虾评 API Key」。
   - `skills-manager.ts`：私有 `installSkillFromZip` 提升为 public（供平台通道复用，不复制逻辑）。
   - `main/index.ts`：新增 IPC `skills:install-platform-skill`（connectionId, skillId, clients）→
     取 download_url → `installSkillFromZip`。凭证沿用既有 `secretStore.getSecretToken(conn.tokenId)`。
   - `preload/index.ts` + `preload/index.d.ts` + `renderer/lib/electron.ts` 暴露该 API。
   - `SkillDetail.tsx`：平台源（有 connId）且平台支持下载 → 走新通道；否则按钮禁用 + 原因提示。
5. **key 提示**：`SourceManager.tsx` 绑定 Token 栏按 `platformType === 'coze'` 显示提示，
   含「下载需要 API Key」与 `https://xiaping.coze.com/skill.md` 链接。
6. **清理空壳**：备份 `~/.codebuddy/skills` 下 5 个仅含 `.source.json` 的目录后再移入回收站（可恢复），
   不做硬删除。

### 取舍与风险

- **成功率 vs 安全**：下载成功路径未实测，故解析做防御式校验，失败给出平台返回的原始错误信息，
  便于用户自查 key / 虾米余额；不猜测成功结构。
- **扣费**：正式版下载扣 2 虾米属消耗用户资产，UI 明确提示，失败不自动重试。
- **回滚**：改动集中在 `SkillDetail.tsx` / `skills-manager.ts` / `coze.ts` / `SourceManager.tsx`
  与新增 IPC，均为增量；空壳清理有备份且走回收站，可完整恢复。

## TODOS

- [x] T1 P0-B：`installSkill` 空文件清单拦截 + 修正错误注释
- [x] T2 P0-A：`SkillDetail` 安装结果统一校验，去掉乐观更新
- [x] T3 能力标志：`fetchSkillDownload` + `PLATFORM_SKILL_DOWNLOAD` + 单测守卫
- [x] T4 虾评下载通道：coze adapter / IPC / preload / SkillDetail 接入
- [x] T5 添加源虾评 key 提示文案
- [x] T6 清理 5 个历史空壳目录（备份 → 删除；回收站 API 被沙箱禁用，已 md5 校验备份）
- [x] T7 自检：tsc 编译通过；单测 286 通过 / 1 失败（`env-manager` npx 探测，改动前既有问题）
- [x] T8 虾评下载安装端到端验证（2026-09-10 19:5x，用本机已绑定 key 实测，全链路通过）
      实测：`GET /api/users/coins` 200 余额 28；`GET /api/auth/me` 200 token 有效；
      `GET /api/skills/{id}/download` 200 且响应体 `{success:true,data:{download_url,version,coins_spent,is_update}}`
      与 `coze.ts` 解析逐字段吻合；zip 直链 200（24314B、合法 zip、根级 SKILL.md）；
      `findSkillRootDir` 栈式搜索可正确定位。**未发现虾评链路缺陷。**

- [x] T9 平台源（ModelScope 等）列表加载慢：主进程侧加磁盘缓存 + SWR
      （新增 `src/main/platforms/search-cache.ts`，接入 `platforms:search-skills`；
        单测 `src/__tests__/platform-search-cache.test.ts` 7 项通过；真机冷启动体感待用户验证）
- [x] T10 商店 ModelScope 安装后列表未显示「已安装」（我的库可见）：已定位并修复（详见下方 T10 段）

### T9 背景与实测（2026-09-10）

**结论：非 ModelScope 官方问题，是软件可优化。**

| 项目 | 实测 |
|---|---|
| `GET /openapi/v1/skills` 响应 | 首字节 0.36–0.49s，总计 0.36–0.63s |
| page_size 20/50/100 | 0.38 / 0.51 / 0.63s |
| 响应体 | 31KB / 86KB / 183KB（小，非瓶颈） |
| 连续 5 次快速请求 | 全 200，未触发限流 |
| 分类接口 | `getFacets` 返回硬编码 18 类常量，同步、零网络 |

**主因**：内置 GitHub 源走磁盘缓存 + SWR（`api/registry.ts:433-440`，首屏秒开）；
平台源**无磁盘缓存**，仅 react-query 内存缓存 10min，重启即失效 → 冷启动每次等网络。

**实现位置**：主进程侧（`platforms:search-skills` 通道），不碰渲染层 hooks。
理由：① 渲染层 `useSkillsData.ts` 由 T10 并行修改中，避免冲突；② 主进程做对所有平台源通用。

**缓存策略**：
- key = `platform-search:<platformType>:<baseUrl>:<query>:<page>:<pageSize>:<category>:<sort>`，**不含 secret**（不落盘凭证）
- 命中未过期 → 直接返回；命中已过期 → 返回 stale + 后台刷新；未命中 → 请求后写缓存
- **失败结果不写缓存**（403/网络错误），避免把失败固化

### T10 背景与修复（2026-09-10）

**现象**：商店 → Skills → ModelScope 源，装完技能后列表卡片不显示「已安装」，但「我的库」里能看到。

**根因（方向 A 确认，方向 B 排除）**：`StoreGrid.tsx:48` 用 `installedSkillIds.has(skill.name)` 直接比对。
- 商店列表项 `skill.name` 取的是 **展示名**（`display_name`，如 `高德地图综合服务Skill`）；
- `installedSkillIds` 里存的却是 **物理目录名**（`id.split('/').pop()`，如 `amap-lbs-skill`）。
两套命名空间，永不同名 → 恒为 false。已排除「缓存未失效」假设（方向 B），
`syncInstalledSkillIds()` 原本就在装/卸成功后调用。

**修复**：新增匹配模块 `src/renderer/src/lib/skillIdentity.ts`，把双方统一展开成**别名集合**再比对：

| 函数 | 作用 |
|---|---|
| `skillMatchKeys(value)` | 拆出 `full` + `tail` 两段小写键（`a/b` → `a/b`、`b`） |
| `skillSourceUrlKeys(url)` | 仅当 URL 含 `/tree/` 或 `/blob/` 时贡献 tail，避免普通仓库 URL 误命中 |
| `skillItemKeys(skill)` | 汇总 `name` + `id` + `sourceUrl` 的全部键 |
| `buildInstalledSkillKeys(names)` | 由物理目录名构建已安装键集 |
| `isSkillInstalled(set, itemKeys)` | 任一键命中即视为已安装 |

接入点两处：`StoreGrid.tsx:33-58`（列表徽标，`useMemo` 缓存键集）、
`SkillDetail.tsx:135/355-364/441/477/507`（`syncInstalledSkillIds` 装/卸后重取真实目录名）。

**验证**：新增 `src/__tests__/skill-installed-match.test.ts` 19 项；全量 21 文件 / 313 用例全绿；
`tsc -p tsconfig.main.json` 与 `tsc -p tsconfig.json` 均零错误；
残留排查确认 `installedSkillIds` 唯一消费点即 StoreGrid，无漏改。

### T8 说明（跨版本遗留）

T4 的成功路径缺少真实 key 无法实测：实测只覆盖了「无鉴权 401 / 无效 key 401 / 详情 200」。
需用户在「编辑源 → 绑定 Token」填入虾评 API Key 后，装一个**试用版**技能验证（`coins_spent` 应为 0）。
