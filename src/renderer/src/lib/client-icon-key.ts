/** 自定义客户端 id 的前缀（见 config-manager.addCustomClient：id 形如 custom:<slug>） */
const CUSTOM_PREFIX = 'custom:';

/**
 * 解析实际用于选取图标的客户端 key。
 *
 * 自定义客户端 id 形如 `custom:<slug>`，slug 由名称转小写、非字母数字统一替换为 `-` 派生
 * （例：「Trae Work」→ `custom:trae-work`），本身没有图标资源，默认会落到灰色兜底图标。
 * 此处在候选 key 中做关键字匹配，命中则复用对应内置客户端的图标，命中不了再兜底。
 *
 * 采用【最长匹配】：slug 同时命中多个候选时取最长的那个。
 * 否则 `trae-cn-2` 这类 slug 会先撞上更短的 `trae` 而选错图标。
 *
 * @param clientId 原始客户端 id（内置 id 或 custom:<slug>）
 * @param candidates 可匹配的候选 key（内置客户端 id）
 * @returns 用于选图标的 key；未命中时原样返回 clientId
 */
export function resolveIconKey(clientId: string, candidates: string[]): string {
    if (!clientId.startsWith(CUSTOM_PREFIX)) return clientId;

    const slug = clientId.slice(CUSTOM_PREFIX.length).toLowerCase();
    if (!slug) return clientId;

    let best = '';
    for (const key of candidates) {
        if (slug.includes(key) && key.length > best.length) {
            best = key;
        }
    }
    return best || clientId;
}
