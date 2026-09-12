/**
 * GitHub / HTML 抓取相关工具
 *
 * 原实现位于 skills-manager.ts（SkillsManager 的 private 方法），
 * 现整体下沉为模块级纯函数，行为完全一致。原文件中保留薄转发层
 * （parseGitHubUrl 等），外部 import 路径不变。
 *
 * 注意：本文件仅依赖全局 fetch / AbortController（Node 18+ 与 DOM lib 已提供），
 * 无需额外 import。
 *
 * 目录枚举健壮性（背景）：本机网络到 api.github.com 存在约 33% 的间歇性失败
 * （`TypeError: fetch failed`，耗时约 10.5s）。旧的「多目录串行请求 + catch 静默吞错」
 * 会把 N 次请求的失败率放大成 ≈ 1-p^N，并把「请求失败」伪装成「目录为空」。
 * 因此本模块统一采用：
 *   1) 单请求的 Git Trees API 递归树为枚举首选（把请求数降到 1）；
 *   2) 网络类错误指数退避重试（HTTP 4xx/5xx 视为确定性错误，不重试）；
 *   3) 枚举失败必须向上抛出，绝不静默返回 []，以便上层区分「空目录」与「网络失败」。
 */

export const GITHUB_HEADERS = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'MCP-Dock',
};

export const REQUEST_TIMEOUT_MS = 15000;

/**
 * 网络抖动重试的退避序列（毫秒）。
 * 数组长度即重试次数：首次请求失败后等待 300ms 重试，再失败等 900ms，再失败等 2700ms。
 */
export const GITHUB_RETRY_DELAYS_MS = [300, 900, 2700];

/** 简单 sleep（供退避重试使用） */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * GitHub HTTP 状态错误：表示拿到了响应但状态码异常（4xx/5xx）。
 * 与「网络层错误」区分——这类错误是确定性的，重试无意义（甚至放大配额消耗），故不重试。
 */
export class GitHubHttpError extends Error {
    readonly status: number;
    /** 服务端返回的 message（如 403 的 "API rate limit exceeded"），用于给出准确提示 */
    readonly detail: string;
    constructor(status: number, message: string, detail = '') {
        super(message);
        this.name = 'GitHubHttpError';
        this.status = status;
        this.detail = detail;
    }
}

/** Git Trees 响应被截断（仓库过大）时抛出；结果不完整，调用方必须回退到其它枚举方式 */
export class GitHubTreeTruncatedError extends Error {
    constructor() {
        super('GitHub 文件树响应被截断（truncated=true），结果不完整');
        this.name = 'GitHubTreeTruncatedError';
    }
}

/**
 * 判断错误是否为「瞬时网络类错误」——只有这类错误才值得重试。
 *
 * Node 的 fetch 在 DNS/TCP/TLS 失败时统一抛 `TypeError: fetch failed`，真实原因
 * （ECONNRESET / ETIMEDOUT / EAI_AGAIN 等）藏在 `err.cause` 里，故需连同 cause 递归判定。
 * HTTP 状态错误（GitHubHttpError）不算网络抖动。
 */
export function isRetryableNetworkError(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof GitHubHttpError) return false;
    const name = (err as Error)?.name;
    if (name === 'AbortError') return true; // fetchWithTimeout 触发的超时
    const msg = String((err as Error)?.message ?? err);
    if (/fetch failed|network|socket hang up|timed out|timeout/i.test(msg)) return true;
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return true;
    const cause = (err as any)?.cause;
    if (cause && cause !== err) return isRetryableNetworkError(cause);
    return false;
}

/** fetch 重试/注入配置 */
export interface GitHubFetchRetryOptions {
    headers?: Record<string, string>;
    /** 退避序列（毫秒），长度即重试次数；测试可传短值/空数组以加速 */
    retryDelaysMs?: number[];
    /** 可注入的底层请求实现（便于单测 mock，不依赖真实网络）；缺省用带超时的 fetchWithTimeout */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * 带超时的 fetch 封装
 */
export async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {...options, signal: controller.signal});
        return res;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 指数退避重试的 GitHub 请求封装。
 *
 * 只对网络类错误重试（超过退避序列长度后抛出最后一个错误）；
 * HTTP 4xx/5xx（鉴权失败 / 不存在 / 限流 / 服务端错误）视为确定性响应，直接抛 GitHubHttpError，
 * 不消耗额外重试与配额。返回原始 Response 供调用方自行解析。
 */
export async function githubFetchWithRetry(
    url: string,
    options: GitHubFetchRetryOptions = {}
): Promise<Response> {
    const delays = options.retryDelaysMs ?? GITHUB_RETRY_DELAYS_MS;
    const fetchImpl = options.fetchImpl ?? ((u: string, i?: RequestInit) => fetchWithTimeout(u, i));
    const headers = options.headers ?? GITHUB_HEADERS;

    let lastError: unknown;
    // attempt 从 0 起：0 为首次请求，之后最多 delays.length 次重试
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            const res = await fetchImpl(url, {headers});
            if (res.status >= 400) {
                // 403 时顺带取回 message，便于上层给出「限流」还是「无权限」的准确提示
                let detail = '';
                if (res.status === 403) {
                    try {
                        const body: any = await res.json();
                        detail = String(body?.message ?? '');
                    } catch { /* body 不可读则忽略 */ }
                }
                throw new GitHubHttpError(res.status, `GitHub 接口返回 HTTP ${res.status}`, detail);
            }
            return res;
        } catch (err) {
            if (!isRetryableNetworkError(err)) throw err; // HTTP 错误 / 非网络错误：不重试
            lastError = err;
            if (attempt >= delays.length) throw err; // 已是最后一次尝试
            await sleep(delays[attempt]);
        }
    }
    // 理论不可达（循环内必 return 或 throw），仅作兜底保证函数有返回值
    throw lastError instanceof Error ? lastError : new Error('GitHub 请求失败');
}

/**
 * 解析 GitHub URL，提取仓库信息（原 SkillsManager.parseGitHubUrl，纯逻辑）
 */
export function githubParseGitHubUrl(
    url: string
): { owner: string; repo: string; branch?: string; subPath?: string } | null {
    // 清理空白字符（包括不可见的 Unicode 空格）和尾部斜杠
    const cleaned = url.trim().replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/\/+$/, '');

    // owner/repo 简写
    const shortMatch = cleaned.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (shortMatch) {
        return {owner: shortMatch[1], repo: shortMatch[2]};
    }

    // GitHub URL: /tree/branch/path
    const treeMatch = cleaned.match(
        /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/tree\/([^\/]+)(?:\/(.+))?$/
    );
    if (treeMatch) {
        return {
            owner: treeMatch[1],
            repo: treeMatch[2],
            branch: treeMatch[3],
            subPath: treeMatch[4] || undefined,
        };
    }

    // GitHub URL: 基础格式（可能带 /blob/、/issues 等尾部，只提取 owner/repo）
    const baseMatch = cleaned.match(
        /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/
    );
    if (baseMatch) {
        return {
            owner: baseMatch[1],
            repo: baseMatch[2].replace(/\.git$/, ''),
        };
    }

    // raw.githubusercontent.com URL
    const rawMatch = cleaned.match(
        /^https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/
    );
    if (rawMatch) {
        const filePath = rawMatch[4];
        const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : undefined;
        return {
            owner: rawMatch[1],
            repo: rawMatch[2],
            branch: rawMatch[3],
            subPath: dir,
        };
    }

    return null;
}

/**
 * GitHub API 请求封装（含错误处理 + 网络抖动重试）。
 * 将 GitHubHttpError 映射为对用户友好的中文错误信息。
 */
export async function githubFetch(url: string, options: GitHubFetchRetryOptions = {}): Promise<any> {
    let res: Response;
    try {
        res = await githubFetchWithRetry(url, options);
    } catch (err) {
        if (err instanceof GitHubHttpError) {
            if (err.status === 403 && /rate limit/i.test(err.detail)) {
                throw new Error('GitHub API rate limit exceeded. Please try again later or use a more specific URL (e.g. with /tree/main/skills)');
            }
            if (err.status === 403) {
                throw new Error('GitHub API access denied (403). The repository may be private');
            }
            if (err.status === 404) {
                throw new Error('Repository not found. Please check the URL');
            }
            throw new Error(`GitHub API error: ${err.status}`);
        }
        throw err;
    }
    return res.json();
}

/**
 * 通过 GitHub API 获取仓库默认分支，API 不可用时 fallback 到 HTML 解析
 */
export async function getDefaultBranch(owner: string, repo: string): Promise<string> {
    try {
        const data = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`);
        return data.default_branch || 'main';
    } catch {
        try {
            const res = await fetchWithTimeout(`https://github.com/${owner}/${repo}`, {
                headers: {'User-Agent': 'MCP-Dock'},
                redirect: 'follow',
            });
            if (res.ok) {
                const html = await res.text();
                const match = html.match(/default-branch="([^"]+)"/);
                if (match) return match[1];
            }
        } catch { /* ignore */
        }
        return 'main';
    }
}

/** Git Trees 条目（path + git 对象类型） */
export interface GitHubTreeEntry {
    path: string;
    type: string;
}

/** Git Trees 递归枚举结果 */
export interface GitHubTreeResult {
    /** 完整条目（含 type），供调用方按需过滤 */
    entries: GitHubTreeEntry[];
    /** 所有条目的 path 列表（tree[].path 顺序） */
    paths: string[];
    /** 仅文件（type === 'blob'）的 path，目录枚举直接用 */
    blobPaths: string[];
    /** 响应被截断（仓库过大 / 单页上限）时为 true，结果不完整，调用方必须回退 */
    truncated: boolean;
}

/**
 * 通过 Git Trees API 一次请求拿到完整递归文件树。
 *
 * 这是目录枚举的首选方案：相对逐目录串行 Contents API，请求数从 N 降到 1，
 * 在弱网下把「全部成功概率 ≈ p^N」的失败率放大问题彻底规避。
 * 注意 `truncated: true` 表示响应被截断，调用方**必须**回退，不可当作完整结果。
 */
export async function fetchGitHubTree(
    owner: string,
    repo: string,
    ref: string,
    options: GitHubFetchRetryOptions = {}
): Promise<GitHubTreeResult> {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
    const data: any = await githubFetch(url, options);
    const rawTree: any[] = Array.isArray(data?.tree) ? data.tree : [];
    const entries: GitHubTreeEntry[] = rawTree
        .filter(it => it && typeof it.path === 'string')
        .map(it => ({path: it.path as string, type: String(it.type ?? '')}));
    return {
        entries,
        paths: entries.map(e => e.path),
        blobPaths: entries.filter(e => e.type === 'blob').map(e => e.path),
        truncated: data?.truncated === true,
    };
}

/**
 * 使用 Contents API 列出目录内容
 */
export async function listDirContents(
    owner: string, repo: string, branch: string, dirPath: string, options: GitHubFetchRetryOptions = {}
): Promise<any[]> {
    const apiPath = dirPath ? `contents/${dirPath}` : 'contents';
    const data = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/${apiPath}?ref=${branch}`,
        options
    );
    return Array.isArray(data) ? data : [];
}

/**
 * 通过 GitHub HTML 页面解析目录中的子目录名（不消耗 API 配额）
 */
export async function listSubdirsViaHtml(
    owner: string, repo: string, branch: string, dirPath: string
): Promise<string[]> {
    const pageUrl = `https://github.com/${owner}/${repo}/tree/${branch}/${dirPath}`;
    const res = await fetchWithTimeout(pageUrl, {
        headers: {'User-Agent': 'MCP-Dock'},
    });
    if (!res.ok) return [];
    const html = await res.text();

    const prefix = `/${owner}/${repo}/tree/${branch}/${dirPath}/`;
    const regex = new RegExp(`href="${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^"/]+)"`, 'g');
    const dirs = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
        dirs.add(m[1]);
    }
    return [...dirs];
}

/**
 * 扫描目录下的子目录，找出包含 SKILL.md 的（HEAD 到 raw.githubusercontent.com 不消耗 API 配额）。
 *
 * 语义约定：**全部探针都因网络异常而失败且未命中**时抛错，绝不静默返回 []——
 * 否则「网络失败」会被上层误判为「目录里没有 SKILL.md」。
 */
export async function probeSkillMdInSubdirs(
    owner: string, repo: string, branch: string, parentPath: string, subdirNames: string[]
): Promise<string[]> {
    const BATCH_SIZE = 10;
    const found: string[] = [];
    let hadNetworkError = false;

    for (let i = 0; i < subdirNames.length; i += BATCH_SIZE) {
        const batch = subdirNames.slice(i, i + BATCH_SIZE);
        const checks = batch.map(async (name) => {
            const fullPath = parentPath ? `${parentPath}/${name}` : name;
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fullPath}/SKILL.md`;
            try {
                const res = await fetchWithTimeout(rawUrl, {method: 'HEAD'});
                return res.ok ? fullPath : null; // 非 ok（404）= 确定不存在
            } catch {
                hadNetworkError = true;
                return null;
            }
        });
        const results = await Promise.all(checks);
        for (const r of results) {
            if (r) found.push(r);
        }
    }

    if (found.length === 0 && hadNetworkError) {
        throw new Error('探测 SKILL.md 时网络异常，无法判定目录内容');
    }
    return found;
}

/**
 * 扫描目录，找出包含 SKILL.md 的子目录。
 *
 * 首选 Git Trees 单请求（覆盖该目录及任意深度的子目录）；trees 不可用（网络失败/截断）时
 * 回退到 Contents API（含 HTML 兜底）。枚举失败向上抛出（不吞错），
 * 只有真正列到目录且确无 SKILL.md 时才返回 []。
 */
export async function findSkillDirsViaContents(
    owner: string, repo: string, branch: string, dirPath: string, options: GitHubFetchRetryOptions = {}
): Promise<string[]> {
    // 首选：trees 单请求（一次拿全树，按前缀过滤出 SKILL.md 所在目录）
    try {
        const viaTree = await findSkillDirsViaTree(owner, repo, branch, dirPath, options);
        if (viaTree.length > 0) return viaTree;
    } catch { /* trees 不可用 → 继续走 Contents */ }

    // 回退：Contents API 列一层目录，再配合 raw HEAD 探测子目录
    let items: any[];
    try {
        items = await listDirContents(owner, repo, branch, dirPath, options);
    } catch (err) {
        // Contents API 失败：尝试 HTML 解析（不消耗配额）。HTML 也拿不到则视为枚举失败抛错。
        const subdirs = await listSubdirsViaHtml(owner, repo, branch, dirPath);
        if (subdirs.length === 0) throw err;
        return probeSkillMdInSubdirs(owner, repo, branch, dirPath, subdirs);
    }

    const hasDirectSkillMd = items.some((f: any) => f.type === 'file' && f.name === 'SKILL.md');
    if (hasDirectSkillMd) return [dirPath];

    const subdirNames = items.filter((f: any) => f.type === 'dir').map((f: any) => f.name as string);
    if (subdirNames.length === 0) {
        // 无子目录：用 raw HEAD 确认该目录本身是否含 SKILL.md（404 = 确定无）
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dirPath}/SKILL.md`;
        const res = await fetchWithTimeout(rawUrl, {method: 'HEAD'});
        return res.ok ? [dirPath] : [];
    }

    return probeSkillMdInSubdirs(owner, repo, branch, dirPath, subdirNames);
}

/**
 * 使用 GitHub Search API 查找 SKILL.md 文件
 */
export async function searchSkillFiles(
    owner: string, repo: string, dirPath: string, options: GitHubFetchRetryOptions = {}
): Promise<string[]> {
    const pathQualifier = dirPath ? `+path:${dirPath}` : '';
    const query = encodeURIComponent(`filename:SKILL.md repo:${owner}/${repo}${pathQualifier}`);
    const url = `https://api.github.com/search/code?q=${query}&per_page=100`;

    const data = await githubFetch(url, options);
    const skillDirs = new Set<string>();
    for (const item of (data.items || []) as any[]) {
        const p: string = item.path;
        if (p.endsWith('/SKILL.md') || p === 'SKILL.md') {
            const dir = p.lastIndexOf('/') >= 0 ? p.substring(0, p.lastIndexOf('/')) : '';
            if (!dirPath || dir === dirPath || dir.startsWith(dirPath + '/')) {
                skillDirs.add(dir);
            }
        }
    }
    return [...skillDirs];
}

/**
 * 使用 Git Trees API 递归扫描（一次请求拿到全量文件树）。
 * 网络失败或响应被截断（truncated）时抛错，交由上层回退到其它策略（不静默返回 []）。
 */
export async function findSkillDirsViaTree(
    owner: string, repo: string, branch: string, dirPath: string, options: GitHubFetchRetryOptions = {}
): Promise<string[]> {
    const tree = await fetchGitHubTree(owner, repo, branch, options);
    if (tree.truncated) throw new GitHubTreeTruncatedError();

    const skillDirs = new Set<string>();
    const prefix = dirPath ? `${dirPath}/` : '';

    for (const p of tree.blobPaths) {
        if (dirPath && !p.startsWith(prefix)) continue;
        if (p.endsWith('/SKILL.md') || p === 'SKILL.md') {
            const dir = p.lastIndexOf('/') >= 0 ? p.substring(0, p.lastIndexOf('/')) : '';
            skillDirs.add(dir);
        }
    }

    return [...skillDirs];
}

/** findSkillDirs 的富结果：可区分「仓库确实没有 SKILL.md」与「因网络/限流无法枚举」 */
export interface FindSkillDirsResult {
    dirs: string[];
    /** 所有枚举策略都因网络/限流/截断失败时为 true（无法判定仓库是否真的存在 SKILL.md） */
    enumerationFailed: boolean;
    /** enumerationFailed 为真时的原因描述（供 UI 如实提示） */
    error?: string;
}

/** 未指定子路径时探测的常见 skills 目录结构 */
const COMMON_SKILL_PARENTS = ['skills', '.cursor/skills', '.agents/skills', '.claude/skills'];

/**
 * 查找 SKILL.md 所在目录（多策略自动降级）。
 *
 * 策略顺序：trees 单请求 → （指定子路径时）Contents 递归 → Search API → 常见父目录/根目录探测。
 * 关键：只有当**至少有一个策略成功枚举但确无 SKILL.md**时才判定为「仓库没有 SKILL.md」；
 * 若所有策略都是网络/限流失败，则返回 enumerationFailed=true，绝不谎报「没有 SKILL.md」。
 */
export async function findSkillDirsEx(
    owner: string, repo: string, branch: string, dirPath: string, options: GitHubFetchRetryOptions = {}
): Promise<FindSkillDirsResult> {
    const failures: string[] = [];
    let sawAuthoritativeEmpty = false;

    // 执行单个策略：命中返回目录数组；成功枚举但为空 → 记录「确定性为空」并返回 null；失败 → 记录原因并返回 null
    const runStrategy = async (label: string, fn: () => Promise<string[]>): Promise<string[] | null> => {
        try {
            const dirs = await fn();
            if (dirs.length > 0) return dirs;
            sawAuthoritativeEmpty = true;
            return null;
        } catch (err) {
            failures.push(`${label}: ${(err as Error).message}`);
            return null;
        }
    };

    // 策略 1: trees 单请求（覆盖子路径与未指定子路径两种场景）
    const viaTree = await runStrategy('trees', () => findSkillDirsViaTree(owner, repo, branch, dirPath, options));
    if (viaTree) return {dirs: viaTree, enumerationFailed: false};

    // 策略 2: Search API（大仓库 / trees 被截断时的兜底）
    const viaSearch = await runStrategy('search', () => searchSkillFiles(owner, repo, dirPath, options));
    if (viaSearch) return {dirs: viaSearch, enumerationFailed: false};

    // 策略 3: Contents 递归（指定子路径直接扫该目录；未指定子路径则探测常见父目录 + 根 SKILL.md）
    const parents = dirPath ? [dirPath] : COMMON_SKILL_PARENTS;
    for (const parent of parents) {
        const viaContents = await runStrategy(`contents(${parent})`, () =>
            findSkillDirsViaContents(owner, repo, branch, parent, options)
        );
        if (viaContents) return {dirs: viaContents, enumerationFailed: false};
    }
    if (!dirPath) {
        const root = await runStrategy('root-skill.md', async () => {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/SKILL.md`;
            const res = await fetchWithTimeout(rawUrl, {method: 'HEAD'});
            return res.ok ? [''] : []; // 404 = 确定无根 SKILL.md
        });
        if (root) return {dirs: root, enumerationFailed: false};
    }

    // 有任一策略「成功枚举但无 SKILL.md」→ 可如实告知「仓库无 SKILL.md」
    if (sawAuthoritativeEmpty) {
        return {dirs: [], enumerationFailed: false};
    }
    return {
        dirs: [],
        enumerationFailed: true,
        error: `无法枚举仓库文件：GitHub 接口网络异常或被限流，请稍后重试。${failures[0] ?? ''}`.trim(),
    };
}

/**
 * 查找 SKILL.md 所在目录（多策略自动降级）。
 * 兼容旧签名：仅返回目录列表；无法区分「空」与「网络失败」时统一为 []。
 * 需要区分两者时请改用 findSkillDirsEx。
 */
export async function findSkillDirs(
    owner: string, repo: string, branch: string, dirPath: string, options: GitHubFetchRetryOptions = {}
): Promise<string[]> {
    return (await findSkillDirsEx(owner, repo, branch, dirPath, options)).dirs;
}

/**
 * 递归获取指定目录下的所有文件（含子目录），用于完整安装一个 Skill。
 *
 * 首选 Git Trees 单请求（按 dirPath 前缀过滤出 blob）；trees 不可用或截断时回退到
 * Contents API 逐层递归 / HTML 兜底。
 * 关键：Contents 递归失败必须向上抛出（不再静默返回 []），否则「请求失败」会被上层误判为「目录为空」。
 */
export async function listDirFiles(
    owner: string, repo: string, branch: string, dirPath: string, options: GitHubFetchRetryOptions = {}
): Promise<Array<{ name: string; path: string; rawUrl: string }>> {
    const baseRaw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;

    // 策略 1（首选）: Git Trees API 一次请求拿全量递归树，按 dirPath 前缀过滤出文件。
    try {
        const tree = await fetchGitHubTree(owner, repo, branch, options);
        if (!tree.truncated) {
            const prefix = dirPath ? `${dirPath}/` : '';
            return tree.blobPaths
                .filter(p => (dirPath ? p.startsWith(prefix) : true))
                .map(absPath => (dirPath ? absPath.slice(prefix.length) : absPath))
                .filter(rel => rel.length > 0)
                .map(rel => ({name: rel, path: rel, rawUrl: `${baseRaw}/${rel}`}));
        }
        // truncated：树不完整，不可当作结果 → 回退递归枚举
    } catch { /* trees 不可用（网络/限流/截断）→ 回退递归枚举 */ }

    // 策略 2: Contents API 逐层递归。失败抛错（不许吞成空目录）。
    const walk = async (
        apiPath: string,
        relPrefix: string
    ): Promise<Array<{ name: string; path: string; rawUrl: string }>> => {
        const items = await githubFetch(
            `https://api.github.com/repos/${owner}/${repo}/${apiPath}?ref=${branch}`,
            options
        );
        if (!Array.isArray(items)) {
            throw new Error(`GitHub 目录枚举返回非数组结果（${apiPath}）`);
        }

        const out: Array<{ name: string; path: string; rawUrl: string }> = [];
        for (const f of items) {
            const rel = relPrefix ? `${relPrefix}/${f.name}` : f.name;
            if (f.type === 'file') {
                out.push({name: rel, path: rel, rawUrl: `${baseRaw}/${rel}`});
            } else if (f.type === 'dir') {
                out.push(...(await walk(`${apiPath}/${f.name}`, rel)));
            }
        }
        return out;
    };

    let walkError: unknown;
    try {
        // relPrefix 从空开始：返回「相对 dirPath 的子路径」。
        // 成功（含空目录）即返回，不再走 HTML——HTML 只是 API 失败时的兜底。
        return await walk(dirPath ? `contents/${dirPath}` : 'contents', '');
    } catch (err) {
        walkError = err;
    }

    // 策略 3: HTML 页面解析文件名（不消耗 API 配额，作为兜底）
    try {
        const pageUrl = `https://github.com/${owner}/${repo}/tree/${branch}/${dirPath}`;
        const res = await fetchWithTimeout(pageUrl, {
            headers: {'User-Agent': 'MCP-Dock'},
        });
        if (res.ok) {
            const html = await res.text();
            const prefix = `/${owner}/${repo}/blob/${branch}/${dirPath}/`;
            const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`href="${escapedPrefix}([^"/]+)"`, 'g');
            const fileNames = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = regex.exec(html)) !== null) {
                fileNames.add(m[1]);
            }
            if (fileNames.size > 0) {
                const dirPrefix = dirPath ? `${dirPath}/` : '';
                // name 统一为「相对 dirPath 的子路径」，与 walk/trees 分支保持一致
                return [...fileNames].map(name => ({
                    name,
                    path: name,
                    rawUrl: `${baseRaw}/${dirPrefix}${name}`,
                }));
            }
        }
    } catch { /* fallback */
    }

    // 全部失败：抛错，让上层区分「网络失败」与「目录为空」
    throw new Error(
        `枚举 Skill 目录失败（GitHub 接口网络异常或限流）：${(walkError as Error)?.message ?? '未知原因'}`
    );
}

/**
 * 当 GitHub Contents API 限流 / 网络失败时，绕开 API 直接通过 raw.githubusercontent.com 探测并补全文件清单。
 *
 * 说明：本函数是 installFromDiscovered 中「目录枚举失败」后的**尽力而为**兜底——
 * 探测不到 SKILL.md 即返回 []；调用方在得到空清单时会抛出「无法获取文件」的明确错误，
 * 不会产出空壳安装结果。
 */
export async function resolveFilesViaRaw(
    owner: string,
    repo: string,
    branch: string,
    skillPath: string
): Promise<string[]> {
    const baseRaw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
    const prefix = skillPath ? `${skillPath}/` : '';

    const existsOnRaw = async (rel: string): Promise<boolean> => {
        try {
            const res = await fetchWithTimeout(`${baseRaw}/${prefix}${rel}`, {method: 'HEAD'});
            return res.ok;
        } catch {
            return false;
        }
    };

    const files: string[] = [];
    const seen = new Set<string>();
    const push = (rel: string) => {
        if (rel && !seen.has(rel)) {
            seen.add(rel);
            files.push(rel);
        }
    };

    // 1) SKILL.md 必须存在
    const skillMdRel = 'SKILL.md';
    if (await existsOnRaw(skillMdRel)) {
        push(skillMdRel);
    } else {
        return []; // raw 上连 SKILL.md 都拿不到，直接放弃
    }

    // 2) 下载 SKILL.md 正文，解析本地相对路径引用
    let mdText = '';
    try {
        const mdRes = await fetchWithTimeout(`${baseRaw}/${prefix}${skillMdRel}`);
        if (mdRes.ok) mdText = await mdRes.text();
    } catch { /* ignore */
    }

    if (mdText) {
        // 匹配形如 `references/foo.md`、`scripts/run.py`、`assets/img.png` 的本地相对引用
        const refRe = /(?:\[[^\]]*\]\(\s*|\b(?:include|reference|source)\s*[=:]\s*)(?:\.\/)?([\w./-]+\.(?:md|markdown|txt|json|ya?ml|py|js|ts|sh|bash|png|jpg|jpeg|gif|svg|csv|html|css))(?:\s*\)|\s*$)/gi;
        const candidates = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = refRe.exec(mdText)) !== null) {
            const rel = m[1].replace(/^\.\//, '');
            if (!rel.includes('://') && !rel.startsWith('/')) candidates.add(rel);
        }

        for (const rel of candidates) {
            if (await existsOnRaw(rel)) push(rel);
        }

        // 3) 常见子目录探测：references/、scripts/、assets/、templates/
        for (const dir of ['references', 'scripts', 'assets', 'templates']) {
            // 目录无法直接 HEAD，尝试探测几个常见文件名；若 SKILL.md 提到该目录则更激进
            const probeNames =
                dir === 'references'
                    ? ['references/reference.md', 'references/README.md']
                    : dir === 'scripts'
                        ? ['scripts/main.py', 'scripts/run.py', 'scripts/main.js']
                        : dir === 'assets'
                            ? ['assets/icon.png', 'assets/cover.png']
                            : ['templates/template.md', 'templates/index.html'];
            for (const p of probeNames) {
                if (await existsOnRaw(p)) push(p);
            }
        }
    }

    return files;
}
