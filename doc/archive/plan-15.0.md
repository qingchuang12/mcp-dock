# plan-15.0 · 单一活动计划（商店全流程发布前检查）

> 版本：1.1（2026-09-12 模块 P：商店所有源查询/安装全流程发布前检查——QA 全面回归 + 3 条建议级收尾，最终放行）· 单一活动 plan：本仓库 `doc/` 同时仅保留此一份活动 plan。
> 前任归档：[archive/plan-14.0.md](archive/plan-14.0.md)（A 百炼远程 MCP 安装 + 建议级遗留收敛 + StoreFilterBar 未筛选基准收敛 + 详情接线外链纠正；遗留用户侧事项：统一提交，由川哥执行）。

## 规则（plan 管理铁律）
- `doc/` 下**同一时刻只保留一个活动 plan**（本文件）；新任务合并进本 plan，不另起 `plan-NN.N.md`。
- 任务**已执行完结** → 归档到 `doc/archive/`（plan 与 audit 一并归档）；**未执行** → 合并进活动 plan。
- 每次软件调整：细化进 plan → 确认 → 执行 → 归档检查。

---

## 模块 P · 商店全流程发布前检查（2026-09-12，川哥指令；QA 放行 + 收尾闭环）

### P.1 检查范围与结果（QA 严过关独立执行，一轮通过）
| 层面 | 结果 |
|---|---|
| 基线复跑 | 双 `tsc --noEmit` exit 0；vitest 全量 **29 文件 / 433 passed** |
| dist 产物直跑 | **15/15 PASS**：bailian 全参数矩阵（哨兵/分类/来源/双排序/分页零重复/远程详情+headersTemplate/getFacets/异常路径）；npm 离线快照（facets 6 类 + searchServers total=71841 + 详情 command 型 install）；clawhub 离线回退读码确认（有缓存本地过滤/无缓存空态不抛错） |
| 链路走查 | 查询参数透传与哨兵一致性（渲染层默认值 ↔ 各 adapter 判据全小写 'all'）；facets→StoreToolbar(optgroup)→StoreFilterBar→回写；hasActiveStoreFilters 新基准与清除回调交互正确；详情/安装双形态分支（远程 buildRemoteHeaders 模板替换正确 + 本地命令型行为不变）；安装落盘 4 类客户端序列化（cursor 透传/opencode remote/openclaw/zcode url 分支）；LocalInstall\|RemoteInstall 三端同源 |
| 静态一致性 | zh/en locale key 递归对比 **844=844 零差异**；死引用扫描干净（safeskill 仅存量兼容 / skillCategory.skillsmp 已删 / 'ALL' 无代码残留）；git 变更清单与已知改动吻合 |

在线源（skillsmp/skillhub/coze/modelscope）因限流不做真实调用，以链路走查替代——如实标注。

### P.2 QA 建议级事项 3 条（川哥「不留任何问题」拍板，工程师收尾 + QA 复验 3/3 闭环）
1. **renderer 类型同源**：`lib/electron.ts` 本地 `McpServerConfig`（缺 cwd/enable）删除，改 re-export `../../../main/config/types`——与 preload 同款，三端单一事实源彻底统一。
2. **codex-cli 远程安装明示不支持**：`PlatformServerDetail.tsx` handleInstall 远程分支在 `setIsInstalling` 前拦截 targets 含 `'codex-cli'` → `detail.remoteCodexUnsupported` 错误提示（zh/en 成对）；不产生坏配置条目（format-adapters 的 TOML 分支不写 url 的既有局限由 UI 层收口，主进程保持克制）。
3. **.gitignore** 追加 `.zcode/`（ZCode 客户端运行时目录，防误入库；目录本身保留）。

### P.3 验证
- 双 `tsc --noEmit` exit 0；vitest 全量 **29 文件 / 433 passed**；zh/en JSON.parse 合法；QA 复验 3/3 闭环无新增问题。
- **最终结论：放行**。无阻断/严重问题，建议级事项全部闭环。

- [x] P 商店全流程发布前检查（QA 全面回归 + 3 条建议级收尾 + 复验；最终放行）

---

## 跨版本遗留项

（暂无。codex-cli TOML 对远程 MCP 的支持属上游客户端能力边界，UI 已明示不支持；后续上游支持时可移除拦截。）

## TODOS（汇总）
- [x] P 商店全流程发布前检查（QA 全面回归 + 3 条建议级收尾 + 复验；最终放行）

