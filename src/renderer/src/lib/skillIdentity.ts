/**
 * Skill「是否已安装」的判定口径。
 *
 * 为什么需要单独收口：商店列表项的 name 是平台给的**展示名**（ModelScope 的 display_name，
 * 如「高德地图综合服务Skill」），而本地已安装集合来自各客户端 skills 目录下的**物理目录名**
 * （如 amap-lbs-skill，由安装时解析出的 skill slug 决定）。内置 GitHub Registry 源两者恰好
 * 同名（列表 name 就是仓库目录名），平台直连源则普遍不同——直接拿 name 比对会让「已安装」
 * 徽章在平台源上永远不亮（库里能看到、商店里不显示）。
 *
 * 统一口径：两侧都展开成 { 全名, 末段 } 的规范化别名集合，任一命中即认定已安装。
 * 末段是本项目既有的判定方式（SkillDetail 用 decodedId.split('/').pop() 匹配目录），
 * 与平台 id（owner/slug）落到磁盘的目录名一致。
 */

/** 参与判定的 Skill 标识；三个来源都不保证存在，故全部可选 */
export interface SkillIdentity {
    /** 平台标识（如 ModelScope 的 `@owner/slug`、内置源的 `skill-<dir>`） */
    id?: string;
    /** 展示名（平台 display_name；内置源即目录名） */
    name?: string;
    /** 来源地址（如 GitHub tree 链接）；仅在明确指向仓库子路径时才参与别名推导 */
    sourceUrl?: string;
}

/**
 * 只有形如 `/tree/<branch>/<子路径>`、`/blob/<branch>/<子路径>` 的链接才携带
 * 「skill 在仓库里的目录名」这一信息；仓库根链接（https://github.com/o/r）取末段
 * 只会拿到仓库名，既可能与 skill 名不同、也容易与同名仓库误判，故一律排除。
 */
const REPO_SUBPATH_RE = /\/tree\/|\/blob\//;

/**
 * 单个标识参与比对的所有别名：全名 + 末段（均小写去空白）。
 * 小写是因为 Windows 的目录名大小写不敏感，且平台 id 与目录名可能只是大小写不同。
 */
export function skillMatchKeys(value: string): string[] {
    const full = value.trim().toLowerCase();
    if (!full) return [];
    const keys = [full];
    // owner/slug → slug；不含分隔符时末段即全名，无需重复
    const segments = full.split('/').filter(Boolean);
    const tail = segments[segments.length - 1] ?? '';
    if (tail && tail !== full) keys.push(tail);
    return keys;
}

/**
 * 从来源地址推导别名：仅取指向仓库子路径的链接末段。
 *
 * 覆盖「平台 id 末段 ≠ 实际落盘目录名」的场景，例如
 * ModelScope 的 `BaiduDrive/baidu-drive` 其 source_url 为
 * `.../bdpan-storage/tree/main/skills/baidu-netdisk`，落盘目录是 baidu-netdisk。
 */
export function skillSourceUrlKeys(sourceUrl: string): string[] {
    if (!REPO_SUBPATH_RE.test(sourceUrl)) return [];
    const path = sourceUrl.split(/[?#]/)[0];
    const tail = path.split('/').filter(Boolean).pop() ?? '';
    return tail ? skillMatchKeys(tail) : [];
}

/**
 * 列表项（或详情页当前 Skill）参与判定的全部候选 key。
 * 同时纳入 name、id 与来源地址，才能覆盖三种口径：
 * - 内置 Registry 源：name 就是仓库目录名（id 形如 `skill-<dir>`，反而不匹配）；
 * - 平台直连源（ModelScope / 虾评 / ClawHub 等）：id 的末段才是落盘目录名；
 * - id 与目录名不同源的少数平台条目：靠 source_url 的子路径末段兜底。
 */
export function skillItemKeys(skill: SkillIdentity): string[] {
    return [
        ...skillMatchKeys(skill.name ?? ''),
        ...skillMatchKeys(skill.id ?? ''),
        ...skillSourceUrlKeys(skill.sourceUrl ?? ''),
    ];
}

/** 由已安装 Skill 的物理目录名构建判定集合 */
export function buildInstalledSkillKeys(names: Iterable<string>): Set<string> {
    const keys = new Set<string>();
    for (const name of names) {
        for (const key of skillMatchKeys(name)) keys.add(key);
    }
    return keys;
}

/** 候选 key 任一命中已安装集合即视为已安装 */
export function isSkillInstalled(installedKeys: Set<string>, itemKeys: string[]): boolean {
    return itemKeys.some(key => installedKeys.has(key));
}
