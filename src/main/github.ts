/**
 * GitHub / HTML 抓取相关工具
 *
 * 原实现位于 skills-manager.ts（SkillsManager 的 private 方法），
 * 现整体下沉为模块级纯函数，行为完全一致。原文件中保留薄转发层
 * （parseGitHubUrl 等），外部 import 路径不变。
 *
 * 注意：本文件仅依赖全局 fetch / AbortController（Node 18+ 与 DOM lib 已提供），
 * 无需额外 import。
 */

export const GITHUB_HEADERS = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'MCP-Dock',
};

export const REQUEST_TIMEOUT_MS = 15000;

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
 * GitHub API 请求封装（含错误处理）
 */
export async function githubFetch(url: string): Promise<any> {
    const res = await fetchWithTimeout(url, {headers: GITHUB_HEADERS});
    if (res.status === 403) {
        const body: any = await res.json().catch(() => ({}));
        if (body.message?.includes('rate limit')) {
            throw new Error('GitHub API rate limit exceeded. Please try again later or use a more specific URL (e.g. with /tree/main/skills)');
        }
        throw new Error('GitHub API access denied (403). The repository may be private');
    }
    if (res.status === 404) {
        throw new Error('Repository not found. Please check the URL');
    }
    if (!res.ok) {
        throw new Error(`GitHub API error: ${res.status}`);
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

/**
 * 使用 Contents API 列出目录内容
 */
export async function listDirContents(
    owner: string, repo: string, branch: string, dirPath: string
): Promise<any[]> {
    const apiPath = dirPath ? `contents/${dirPath}` : 'contents';
    const data = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/${apiPath}?ref=${branch}`
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
 * 扫描目录下的子目录，找出包含 SKILL.md 的（HEAD 到 raw.githubusercontent.com 不消耗 API 配额）
 */
export async function probeSkillMdInSubdirs(
    owner: string, repo: string, branch: string, parentPath: string, subdirNames: string[]
): Promise<string[]> {
    const BATCH_SIZE = 10;
    const found: string[] = [];

    for (let i = 0; i < subdirNames.length; i += BATCH_SIZE) {
        const batch = subdirNames.slice(i, i + BATCH_SIZE);
        const checks = batch.map(async (name) => {
            const fullPath = parentPath ? `${parentPath}/${name}` : name;
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fullPath}/SKILL.md`;
            try {
                const res = await fetchWithTimeout(rawUrl, {method: 'HEAD'});
                return res.ok ? fullPath : null;
            } catch {
                return null;
            }
        });
        const results = await Promise.all(checks);
        for (const r of results) {
            if (r) found.push(r);
        }
    }

    return found;
}

/**
 * 通过 Contents API 扫描目录，找出包含 SKILL.md 的子目录
 * 如果 API 不可用，fallback 到 HTML 页面解析
 */
export async function findSkillDirsViaContents(
    owner: string, repo: string, branch: string, dirPath: string
): Promise<string[]> {
    let subdirNames: string[] = [];
    let hasDirectSkillMd = false;

    try {
        const items = await listDirContents(owner, repo, branch, dirPath);
        hasDirectSkillMd = items.some((f: any) => f.type === 'file' && f.name === 'SKILL.md');
        if (hasDirectSkillMd) return [dirPath];
        subdirNames = items.filter((f: any) => f.type === 'dir').map((f: any) => f.name as string);
    } catch {
        subdirNames = await listSubdirsViaHtml(owner, repo, branch, dirPath);
    }

    if (subdirNames.length === 0) {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dirPath}/SKILL.md`;
        try {
            const res = await fetchWithTimeout(rawUrl, {method: 'HEAD'});
            if (res.ok) return [dirPath];
        } catch { /* ignore */
        }
        return [];
    }

    return probeSkillMdInSubdirs(owner, repo, branch, dirPath, subdirNames);
}

/**
 * 使用 GitHub Search API 查找 SKILL.md 文件
 */
export async function searchSkillFiles(owner: string, repo: string, dirPath: string): Promise<string[]> {
    const pathQualifier = dirPath ? `+path:${dirPath}` : '';
    const query = encodeURIComponent(`filename:SKILL.md repo:${owner}/${repo}${pathQualifier}`);
    const url = `https://api.github.com/search/code?q=${query}&per_page=100`;

    const data = await githubFetch(url);
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
 * 使用 Git Trees API 递归扫描（仅适用于中小仓库）
 */
export async function findSkillDirsViaTree(owner: string, repo: string, branch: string, dirPath: string): Promise<string[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const data = await githubFetch(url);

    if (data.truncated) return [];

    const skillDirs = new Set<string>();
    const prefix = dirPath ? `${dirPath}/` : '';

    for (const item of (data.tree || []) as any[]) {
        if (item.type !== 'blob') continue;
        const p: string = item.path;
        if (dirPath && !p.startsWith(prefix)) continue;
        if (p.endsWith('/SKILL.md') || p === 'SKILL.md') {
            const dir = p.lastIndexOf('/') >= 0 ? p.substring(0, p.lastIndexOf('/')) : '';
            skillDirs.add(dir);
        }
    }

    return [...skillDirs];
}

/**
 * 查找 SKILL.md 所在目录（多策略自动降级）
 */
export async function findSkillDirs(owner: string, repo: string, branch: string, dirPath: string): Promise<string[]> {
    // 策略 1: 如果指定了子路径，用 Contents API（含 HTML fallback）扫描该目录及其子目录
    if (dirPath) {
        try {
            const dirs = await findSkillDirsViaContents(owner, repo, branch, dirPath);
            if (dirs.length > 0) return dirs;
        } catch { /* continue */
        }
    }

    // 策略 2: 尝试 Git Trees API（中小仓库，一次请求拿到全部文件树）
    try {
        const dirs = await findSkillDirsViaTree(owner, repo, branch, dirPath);
        if (dirs.length > 0) return dirs;
    } catch { /* fallback */
    }

    // 策略 3: Search API（大仓库 fallback）
    try {
        const dirs = await searchSkillFiles(owner, repo, dirPath);
        if (dirs.length > 0) return dirs;
    } catch { /* continue */
    }

    // 策略 4: 未指定子路径时，探测常见 skills 目录结构（含 HTML fallback）
    if (!dirPath) {
        const commonParents = ['skills', '.cursor/skills', '.agents/skills', '.claude/skills'];
        for (const parent of commonParents) {
            try {
                const dirs = await findSkillDirsViaContents(owner, repo, branch, parent);
                if (dirs.length > 0) return dirs;
            } catch { /* continue */
            }
        }

        // 最后检查根目录 SKILL.md
        try {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/SKILL.md`;
            const res = await fetchWithTimeout(rawUrl, {method: 'HEAD'});
            if (res.ok) return [''];
        } catch { /* ignore */
        }
    }

    return [];
}

/**
 * 递归获取指定目录下的所有文件（含子目录），用于完整安装一个 Skill。
 */
export async function listDirFiles(
    owner: string, repo: string, branch: string, dirPath: string
): Promise<Array<{ name: string; path: string; rawUrl: string }>> {
    const baseRaw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;

    // 策略 1: 通过 GitHub Contents API 递归遍历（一次请求拿一层，自动下钻子目录）
    const walk = async (
        apiPath: string,
        relPrefix: string
    ): Promise<Array<{ name: string; path: string; rawUrl: string }>> => {
        let items: any[] = [];
        try {
            items = await githubFetch(
                `https://api.github.com/repos/${owner}/${repo}/${apiPath}?ref=${branch}`
            );
        } catch {
            return [];
        }
        if (!Array.isArray(items)) return [];

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

    // relPrefix 从空开始：返回「相对 dirPath 的子路径」
    const files = await walk(dirPath ? `contents/${dirPath}` : 'contents', '');
    if (files.length > 0) return files;

    // 策略 2: HTML 页面解析文件名（不消耗 API 配额，作为兜底）
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
                return [...fileNames].map(name => ({
                    name,
                    path: dirPath ? `${dirPath}/${name}` : name,
                    rawUrl: `${baseRaw}/${dirPath ? `${dirPath}/` : ''}${name}`,
                }));
            }
        }
    } catch { /* fallback */
    }

    return [];
}

/**
 * 当 GitHub Contents API 限流 / 网络失败时，绕开 API 直接通过 raw.githubusercontent.com 探测并补全文件清单。
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
