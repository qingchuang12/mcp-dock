# overview · 商店全数据源查询/安装全量排查（plan-8.0）

> 完成时间：2026-09-11 · 前序：plan-7.1 · 状态：**全部 TODOS 完结**

## TL;DR

对商店全部 13 个数据源的「查询链 + 安装链」逐条实测排查完毕：**11 个可修复缺陷全部修复**（含用户主诉的 ModelScope 安装失败），**6 项上游限制如实归档**（无法代码修复），1 项死代码记为产品决策项。全量 28 文件 / 384 用例全绿，双 tsc exit 0，10 个变异测试证明新守卫全部非空转。

## 核心结论（根因都不是网络）

| 源 | 结论 |
|---|---|
| ModelScope Skill | **安装通道从未接线**（D1/D2/D3）——修复后一键安装走实测可用的 zip 直链；配额张冠李戴（D4）已按 Skill 2400 / MCP 100 拆分 |
| SkillsMP | 基址 DNS 已死（`api.skillsmp.com` ENOTFOUND，D6）+ 忽略 `githubUrl`（D7）——已修复，整源复活 |
| 虾评 Coze | 代码路径正确，下载需有效 API Key（未复现用户侧失败，结案不归因） |
| SafeSkill | 官方文档声明的 search 接口线上未部署（上游限制）；串别家数据（D8）与探活假绿（D9）已修，现在诚实报「不支持」 |
| 百炼 Bailian | 死代码：适配器已写已注册但类型/配置层从未接线（D16），本轮不改，记为产品决策项 A10 |
| 其余源（GitHub / SkillHub / ClawHub / skills.sh / Smithery / npm / ModelScope MCP） | 链路正常，属非缺陷；仅个别上游限制（409、游标制、需鉴权） |

## 本轮修复清单

- **B1（工程师完成，我独立验证）**：D1–D7 + D14 反向守卫 —— ModelScope 安装接线、配额按资源类型拆分、SkillsMP 基址与安装源字段
- **B2（因团队 429 限流由我直接实施）**：D8 SafeSkill 解除串数据映射、D9 探活不再假绿、D10 陈旧注释改实测事实、D11 缓存键纳入鉴权态（secret 仍不落盘）、D12 缓存内存/磁盘容量上限、D15 删除孤儿常量与 `&category=` 死模板

## 验证证据

- 双 tsc（main + renderer）exit 0 —— 第一轮还抓到并修复了 `Partial` 改造引入的 `TS18048`
- `npx vitest run` 多轮全绿：28 文件 / 384 用例
- **10 个变异测试全部转红**并按 md5 逐字节还原（B1 五连 + B2 五连），证明守卫用例非空转
- 端到端安装链测试 `install-platform-chain.test.ts`：直链 → zip 安装 → 落盘真目录（SKILL.md + 真实文件清单）
- ClawHub 注释数据复核：100 条中 `install.kind=clawhub` 恰 60 条（60%），注释准确

## 遗留 / 后续

| 项 | 性质 | 处置 |
|---|---|---|
| U1–U6 | 上游限制（ModelScope 网关抖动、SafeSkill 未部署、虾评需 Key、SkillsMP 无分类过滤、ClawHub 409、游标制） | 已在 plan.md 附实测证据与建议 UI 措辞，无法代码修复 |
| D16 / A10 | 百炼接线或删除 | 产品决策，需时单独立项 |
| E1 / E2 | 可选增强（放开 ClawHub/SkillHub 安装、ModelScope 连接级退避） | 非缺陷，backlog |

详细档案：[plan.md](plan.md)
