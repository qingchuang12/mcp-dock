# plan-9.0 · E1：放开 ClawHub / SkillHub 商店内安装

> 版本：9.0（2026-09-11）· 前任：[archive/plan-8.0.md](archive/plan-8.0.md)（商店全数据源查询/安装全量排查，已完结归档）

## 背景与目标

plan-8.0 实测确认 ClawHub / SkillHub 的 zip 下载直链可用，但安装通道未接线（用户拍板执行 backlog E1）。目标：两个平台的技能在商店详情页可一键安装。

## 范围与边界

**做**：
1. `clawhubAdapter` / `skillhubAdapter` 实现 `fetchSkillDownload`（zip 直链通道）。
2. `PLATFORM_SKILL_DOWNLOAD` 登记 `'clawhub'`、`'skillhub'`（双向守卫测试自动生效）。
3. 两个平台 `mapEntry` 的 `downloadUrl` 对齐（D3 同类）：GitHub 源优先保留，非 GitHub 源改用 zip 直链——与 plan-8.0 ModelScope D3 修法一致。

**不做**：
- skills.sh 镜像条目（ClawHub 榜单 `install.kind='skills-sh'`）沿用既有 skills.sh → GitHub 解析通道，不动。
- E2（ModelScope 连接级退避）、D16（百炼接线）不在本轮。

## 实测依据（2026-09-11 复核）

| 直链 | 实测 |
|---|---|
| `https://clawhub.ai/api/v1/download?slug=planning-with-files` | 200 ZIP 122160B（clawhub 原生） |
| `https://clawhub.ai/api/v1/download?slug=design-mobile-apps`（skills-sh 镜像） | **404** —— zip 通道只服务 clawhub 原生技能，故 mapEntry 对 GitHub 源保留原 URL |
| `https://clawhub.ai/api/v1/download?slug=tiktok-scraper` | 409（上游构建缺失，U5 已归档） |
| `https://api.skillhub.cn/api/v1/download?slug=tencent-docs` | 302 → COS zip，200 / `504b0304` / 378994B |
| `https://api.skillhub.cn/api/v1/download?slug=x-twitter-search` | 200 ZIP 7798B |
| `https://skillhub.cn/api/v1/download?slug=…`（站点域名） | 200 但返回 **HTML** —— 下载端点只在 API 域名存在，故 fetchSkillDownload 固定用 API 主机，不拼用户 baseUrl |

## 实现思路（触点 → 步骤）

1. `src/shared/platform-constants.ts`：`PLATFORM_SKILL_DOWNLOAD` 增 `clawhub`/`skillhub`；把 `SKILLHUB_DOWNLOAD_BASE` 从 `resolvers/skillhub.ts` 上移到此处（与 `CLAWHUB_DOWNLOAD_BASE` 同址存放），原处改 import（复用收敛）。
2. `src/main/resolvers/install-zip.ts`：import 改指向 shared。
3. `src/main/platforms/clawhub.ts`：实现 `fetchSkillDownload`（slug → `CLAWHUB_DOWNLOAD_BASE?slug=`，slug 空则明确报错）；`mapEntry.downloadUrl` 按 GitHub 优先 / 否则 zip 直链。
4. `src/main/platforms/skillhub.ts`：实现 `fetchSkillDownload`（slug → `SKILLHUB_DOWNLOAD_BASE?slug=`）；`mapEntry.downloadUrl` 同上对齐。
5. 测试：两个 fetchSkillDownload 的 URL/报错用例 + mapEntry downloadUrl 对齐用例；跑双 tsc + 全量 vitest + 变异测试（抹登记 / 摘 fetchSkillDownload 必须转红）。

**风险与回滚**：改动集中于两个 adapter 与常量位置，git 工作区可直接回滚；安装按钮从「禁用」变「可用」，上游 404/409 条目点击后会得到明确的 HTTP 错误提示（与 U5 措辞一致），不产生空壳目录（`installSkillFromZip` 失败不落盘）。

## TODOS

- [x] T1 实测复核两平台下载直链与 slug 字段（见上表）
- [x] T2 常量上移 + `PLATFORM_SKILL_DOWNLOAD` 登记
- [x] T3 两 adapter 实现 `fetchSkillDownload` + `mapEntry.downloadUrl` 对齐
- [x] T4 回归测试（含守卫转红验证）+ 双 tsc + 全量 vitest 多轮
- [x] T5 plan 收尾与日志
