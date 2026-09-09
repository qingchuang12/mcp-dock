# plan-3.1 · Skill 附属文件编辑

> 版本：3.1（2026-09-07） · 前任：[doc/archive/plan-3.0.md](../archive/plan-3.0.md)（云端一致性，代码已完成并归档）
> 遗留随迁（来自 3.0）：P7 —— cloud 出现在技能详情页安装目标是否设计意图，待用户求证。

## 背景与目标

创建/导入已支持附属文件（plan-3.0「Skill 附属文件完整支持」：zip 导入 files 通道 + createCustomSkill 落盘），但**编辑模式**仍只能改 SKILL.md 正文，附属脚本/相关文件无法查看、修改、新建、删除。

本版目标：编辑模式下提供「附属文件」面板，覆盖查看/编辑/新建/删除四项能力。

## 范围与边界

**做**

1. main：`listSkillFiles`（递归扫描 skill 目录 → 相对路径 + 大小 + 文本/二进制标记；排除 `.source.json`；`SKILL.md` 标记受保护）与 `readSkillFile`（UTF-8 解码探测，二进制或 >512KB 标记只读）+ IPC。
2. main：`updateCustomSkill` 输入扩展 `files`（新建/覆盖）+ `removedFiles`（删除），沿用 zip 导入的路径预检与 `assertWithin` 防穿越；受保护文件（SKILL.md / .source.json）禁止新建与删除；`save-with-cloud-sync` 透传。
3. renderer：electron.ts 类型 + preload API。
4. renderer：CreateSkillModal 编辑模式「附属文件」面板（列表 / 文本编辑区 / 新建文本 / 删除确认 / 暂存态，随「保存」与 SKILL.md 统一提交；以首个已安装客户端为读取基准）。
5. i18n（zh/en）+ 单测 + typecheck/test 全绿。

**不做**（理由）

- 创建模式的面板——zip 导入通道已覆盖归档文件，无需求驱动。
- 二进制/超大文件的在线编辑——损坏风险大于收益，只读可删（用户已确认）。
- 独立写 IPC（write/delete）——保存必须与 SKILL.md 原子一致，避免状态分裂（用户已确认「随保存统一提交」）。
- 新建方式支持「从本地选文件复制」——仅新建文本文件（用户已确认）。

## 实现思路

### 关键取舍

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 保存时机 | 变更（改/新建/删除）暂存于弹窗，随「保存」与 SKILL.md 一并提交 | 与 isDirty 联动，取消/关闭不落盘，语义统一（用户确认） |
| 多客户端基准 | 以首个已安装客户端为读取基准，保存写入所有已选客户端 | 与现有 SKILL.md 编辑回填同口径（用户确认） |
| 二进制/大文件 | `readSkillFile` UTF-8 探测失败或 >512KB → 标记只读 | 防乱码写坏文件、防 UI 卡顿（用户确认） |
| 写入通道 | 复用 `updateCustomSkill`（扩展 files/removedFiles），不另设写 IPC | 复用既有预检/`assertWithin`/逐客户端落盘与历史备份链路 |
| 受保护文件 | SKILL.md（正文区编辑）、.source.json（隐藏）禁止新建/删除 | 与 plan-3.0「.source.json 跳过」约定一致 |

### 触点清单

| 文件 | 改动 |
|------|------|
| `src/main/skills-manager.ts` | `listSkillFiles` / `readSkillFile` 方法；`updateCustomSkill` 扩展 `files` / `removedFiles`（预检 + 落盘 + 删除） |
| `src/main/index.ts` | IPC `skills:list-skill-files` / `skills:read-skill-file`；`skills:save-with-cloud-sync` 输入类型透传 files/removedFiles |
| `src/preload/index.ts` | `listSkillFiles` / `readSkillFile` 桥接 |
| `src/renderer/src/lib/electron.ts` | API 类型 + mock |
| `src/renderer/src/components/CreateSkillModal.tsx` | 编辑模式「附属文件」面板（列表 / 编辑区 / 新建 / 删除 / 暂存态） |
| `src/renderer/src/locales/zh.json` / `en.json` | 面板相关文案 |
| `src/__tests__/skills-custom-files-manage.test.ts`（新增） | list/read/update 批量写/删除/穿越拒绝/受保护拦截单测 |

### 步骤

1. main：`listSkillFiles` / `readSkillFile` + IPC + 单测。
2. main：`updateCustomSkill` 扩展 files/removedFiles（全量预检 + assertWithin + 逐客户端写/删）+ `save-with-cloud-sync` 透传 + 单测。
3. renderer：electron.ts 类型 + preload API + mock。
4. renderer：CreateSkillModal 编辑模式面板（列表加载 → 点击读内容 → 编辑暂存 → 新建/删除 → 保存携带变更）。
5. i18n + typecheck + test 全绿。

### 风险与回滚

- **风险 1**：多客户端同名文件内容不一致 → 以首个客户端为基准整体覆盖（与 SKILL.md 编辑同口径，用户已确认）。
- **风险 2**：files/removedFiles 路径穿越 / 删除越界 → 复用 createCustomSkill 全量预检 + `assertWithin` 双保险；删除路径同样先校验再执行。
- **风险 3**：编辑大文件卡顿 → 读取 >512KB 标记只读，不加载内容。
- **回滚**：全部 additive（新方法/新 IPC/新面板），既有保存行为不变；逐文件 revert 即可。

### 验证

1. `npm run typecheck` 退出码 0；`npm run test` 全绿（含新增单测）。
2. 手动（本机）：
   - 编辑一个带 scripts/ 附属文件的 skill → 面板出现文件列表，SKILL.md 显示受保护；
   - 点击脚本 → 文本域加载，修改后点「保存」→ 所有已选客户端文件被更新；
   - 新建 `scripts/new.py` → 保存后目录出现该文件；删除某附属文件 → 保存后目录删除；
   - 改名保存 → 附属文件随目录迁移不丢失；新建/删除 SKILL.md、.source.json → 被拦截。

## TODOS

- [x] ① main 读取：`listSkillFiles`（递归扫描 → 相对路径+大小+文本/二进制标记；排除 `.source.json`；SKILL.md 标记受保护）/ `readSkillFile`（UTF-8 探测，二进制或 >512KB 只读）+ IPC
- [x] ② main 保存通道：`updateCustomSkill` 扩展 `files` / `removedFiles`（全量预检 + assertWithin + 逐客户端写/删；受保护文件拦截）；`save-with-cloud-sync` 透传
- [x] ③ main 单测：list/read/update 批量写、删除、穿越拒绝、受保护拦截（其余工作与单测同步推进）
- [x] ④ renderer：electron.ts 类型 + preload API + CreateSkillModal 编辑模式「附属文件」面板（列表 / 文本编辑区 / 新建文本 / 删除确认 / 暂存态，随「保存」统一提交，首个已安装客户端为基准）
- [x] ⑤ i18n zh/en 文案 + typecheck + test 全绿（244/244）
- [ ] 3.0 遗留：手动验证清单过一遍（对照弹窗 / banner / 云同步手动项）；P7 求证（cloud 是否保留技能安装目标）