/**
 * 由 SKILL.md 的 raw 基址派生「Raw SKILL.md」外链（从 SkillDetail 组件抽出的纯逻辑，便于单测）。
 *
 * 为什么需要单独收口：本地已安装 skill 的 `.source.json` 中 `rawBaseUrl` 可能为空串——
 * zip / 平台压缩包通道安装的 skill 不再持久化（会过期的）预签名直链，故 `rawBaseUrl` 恒为 ''。
 * 若组件仍以 `${rawBaseUrl}/SKILL.md` 拼接，会得到 `/SKILL.md` 这种 **truthy 的死链**，
 * 被 `skillView.skillMdRawUrl && (...)` 渲染成外链、点击必然打不开。
 *
 * 契约：`rawBaseUrl` 去空白后非空 → 返回 `${rawBaseUrl}/SKILL.md`；否则返回 undefined（UI 据此不渲染）。
 * 注意：判断依据是**字段是否非空**，而不是外层对象是否存在——只判对象存在正是原缺陷的成因。
 */
export function deriveSkillMdRawUrl(rawBaseUrl?: string): string | undefined {
    const base = (rawBaseUrl ?? '').trim();
    if (!base) return undefined;
    return `${base}/SKILL.md`;
}
