# plan-10.0 · SkillsMP 分类/排序修复

> 版本：10.0（2026-09-11）· 前任：[archive/plan-9.0.md](archive/plan-9.0.md)（E1：放开 ClawHub / SkillHub 商店内安装，已完结归档）

## 背景与目标

川哥要求：「商店 skillsmp 的分类排序检查一下，有问题就修复」。实测复核（plan-8.0 U4 结论依旧成立）：

- 上游 `filters` 仅支持 `search` / `sortBy`，**没有** category 过滤（任何 category 取值均 HTTP 400）。
- `sortBy=recent`（对应前端"最近更新"）实测有效改变结果顺序；stars/downloads/relevance/newest 均静默回退默认序。

由此确认三个真实缺陷：

1. **排序静默失效**：`sortBy` 计算了但 `SEARCH_TPLS` 无 `{sort}` 占位符 → 用户选任何排序都被丢弃。
2. **分类错标**：`mapEntry(raw, category?)` 把请求级 category 回填进每条结果 → 未过滤的结果被贴上分类标签，纯误导。
3. **假分类面板**：`getFacets` 声明了 62 项分类（上游根本不支持），UI 出现「选了分类但结果不过滤还被错标」的假筛选项。

## 范围与边界

- 仅 `src/main/platforms/skillsmp.ts` 与其测试；不动其它平台。

## 实现思路

- `SEARCH_TPLS` 全部补上 `&sortBy={sort}`，sort 无效值映射为空串（上游静默回退默认序，无害）。
- 删除 `SKILLSMP_CATEGORIES`（62 行）与 `SKILLSMP_LANGUAGES`；`getFacets` 如实返回 `categories: []`。
- `mapEntry` 去掉 category 参数，仅透传 `raw.category`。
- `searchSkills` 对 probeEndpoints 传空 category，category 仅保留在诊断字段。

## TODOS

- [x] T1 SEARCH_TPLS 接线 sortBy，排序真实生效
- [x] T2 删除分类回填与假分类面板（mapEntry / getFacets / 常量）
- [x] T3 测试：no-refill 断言 + getFacets 如实断言（+2 用例，全量 392 绿）
- [x] T4 变异测试 M1（getFacets 复发）M2（category 回填复发）均 RED_OK，md5 恢复
- [x] T5 双 tsc 通过；测试执行备注见下

## 测试执行备注（环境异常，非本仓库问题）

默认 `threads` / `forks` 池在本机当前环境下全部套件挂载失败（`getRunner()` 状态缺失，最小用例亦复现）；
`vmForks` / `vmThreads` 池正常。已排除：环境变量（env -i 最小环境仍复现）、node_modules 损坏（重装 no-op）、
依赖双实例（pnpm 软链全部完好）。临时方案：`npx vitest run --pool=vmForks`。是否将 `pool: 'vmForks'`
固化进 vitest.config.ts 待川哥拍板。

## 本轮：分类筛选 / 列表查询复核（2026-09-11 15:41）

川哥：「商店 skillsmp 数据源，分类筛选和列表查询检查一下，并完善功能」。

### 实测复核（真实请求取证，非凭推断）
- **列表查询正常**：`/api/skills?search=test&page=1&limit=10&sortBy=recent` 返回 10 条，`pagination.total=11, totalPages=2, hasNext`，q 必填兜底、`limit` 钳到 50 均已在上一轮接线。注意 `totalIsExact:false`（总量为近似值，UI「共 N 个」为约数，非精确）。
- **排序真假**：`relevance`/`stars`/`newest`/`downloads` 四种排序**首条 ID 完全一致**（均为 `openclaw-openclaw-...`），证明上游忽略未识别 sortBy 而回退默认序；只有 `recent` 真正重排（`chulioz-...` 置顶）。→ `stars` 是「选了没反应」的假排序。
- **分类彻底不可行**：5 个候选端点（`/api/categories`、`/api/filters`、`/api/categories/tags`、`/api/category`、`/api/skills/categories`）全部 404；每条 item 字段为 `id/name/author/contentLanguage/githubUrl/stars/forks/updatedAt/path/route`，**无 category 字段**（10 条皆 `undefined`）；带 `category=` 参数直接 400。`path` 恒 `"SKILL.md"`、`route` 为仓库路由对象，均非分类维度。

### 完善（仅做真实有效的，不造假）
- [x] T6 删除 `SKILLSMP_SORTS` 中无效的 `stars` 项，仅保留 `relevance`（默认）+ `updated`(→recent) 两个实测真生效排序；同步改注释与测试断言（`sortOptions` 期望 `['relevance','updated']`）。
- [x] T7 分类保持 `categories: []` 如实声明（UI 自动不出分类筛选项）；不补任何假分类/假控件，理由见 plan-10.0「不挂假面板」原则。
- [x] T8 双 tsc + 全量 392 测试绿（`--pool=vmForks`）。

### 结论
列表查询本身已可用；本轮唯一的实质完善是**剔除假排序 `stars`**。分类筛选因上游零支持、且 item 无分类字段，客观上无法在本源实现，已维持如实空声明。若未来想给该源加分类，需 SkillsMP 上游提供分类 API 或分类字段。

## 待用户决策的候选任务（未确认前不执行）

| # | 事项 | 性质 | 说明 |
|---|---|---|---|
| A10 | 百炼 Bailian 接线或删除 | 产品决策 | 适配器已写已注册但类型/配置层未接线（D16 死代码）；接线属启用新源，删除属移除资产。接线需一并修复 icon URL 404 |
| E2 | 为 ModelScope 域名增加连接级退避 | 可选增强 | 上游新建连接超时率 33–50%，现有 2 次重试可缓解但首次等待可达 ~10s |
