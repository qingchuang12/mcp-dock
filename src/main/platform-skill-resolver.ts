/**
 * 平台 Skill 链接解析器
 *
 * 目标：让用户粘贴社区 skill 页面 URL（支持 ModelScope / SafeSkill / SkillHub / SkillsMP），
 * 软件自动解析出可下载的源（GitHub 仓库或 SKILL.md / zip 直链），复用现有安装通道。
 *
 * 设计要点：
 *  - 各站点形态不同：SkillsMP 为服务端渲染（SSR），列表/详情页直接包含
 *    “仓库: owner/repo” 文本，可稳定提取 GitHub 源；而 ModelScope / SkillHub / SafeSkill
 *    多为前端 SPA，静态 HTML 常是空壳（数据由运行时 JS 异步加载）。
 *  - 因此本解析器采用「多策略尽力解析」：
 *      策略 1：从 URL 路径本身提取 GitHub owner/repo 或平台 skill 标识；
 *      策略 2：fetch 页面 HTML，提取其中的 github.com 链接、仓库路径（owner/repo）、
 *              内联 JSON（window.__INITIAL_STATE__ / __NEXT_DATA__ / __remixContext 等）、
 *              <meta> 标签、以及 SKILL.md / raw / zip 等直链；
 *      策略 3：SkillsMP 列表页可一次性提取多个 “仓库: owner/repo”，批量解析为多个 Skill；
 *      策略 4：若命中 GitHub 仓库，转交已有的 parseImportUrl 处理（已验证稳定）；
 *      策略 5：若命中 SKILL.md / zip 直链，构造 DiscoveredSkill 直接安装。
 *  - 任何策略失败都返回清晰错误，不会静默挂起。
 */

import {execFile} from 'child_process';
import os from 'os';
import path from 'path';
import {Dirent, promises as fsp} from 'fs';
import {DiscoveredSkill, ImportParseResult, SkillsManager} from './skills-manager';
import type {PlatformType} from '../shared/platform-constants';
import {
    CLAWHUB_DOWNLOAD_BASE,
    CLAWHUB_MAX_ITEMS,
    CLAWHUB_PAGE_LIMIT,
    CLAWHUB_TRENDING_BASE,
    CLAWHUB_TRENDING_URL,
} from '../shared/platform-constants';
import {parseFrontmatter} from '../shared/frontmatter';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export type SupportedPlatform = 'modelscope' | 'safeskill' | 'skillhub' | 'skillsmp' | 'clawhub' | 'unknown';

export interface ResolvePlatformResult extends ImportParseResult {
    platform: SupportedPlatform;
    /** 解析过程中命中的源类型，便于调试与用户提示 */
    resolvedVia?: 'github' | 'direct-skill-md' | 'zip' | 'list' | 'unknown';
}

const PLATFORM_NAMES: Record<SupportedPlatform, string> = {
    modelscope: 'ModelScope',
    safeskill: 'SafeSkill',
    skillhub: 'SkillHub',
    skillsmp: 'SkillsMP',
    clawhub: 'ClawHub',
    unknown: 'Unknown',
};

/**
 * 判断 URL 属于哪个平台
 */
export function detectPlatform(url: string): SupportedPlatform {
    const u = url.toLowerCase();
    if (u.includes('modelscope.cn')) return 'modelscope';
    if (u.includes('safeskill.cn')) return 'safeskill';
    if (u.includes('skillhub.cn')) return 'skillhub';
    if (u.includes('skillsmp.com')) return 'skillsmp';
    if (u.includes('clawhub.ai')) return 'clawhub';
    return 'unknown';
}

/**
 * 从一段 HTML 中提取所有 github.com 仓库链接（去重）
 */
function extractGithubUrls(html: string): string[] {
    const urls = new Set<string>();
    // 标准仓库链接
    const repoRe = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
    let m: RegExpExecArray | null;
    while ((m = repoRe.exec(html)) !== null) {
        // 去掉尾部可能的 /tree/、/blob/ 等，保留 owner/repo 主体（parseImportUrl 也能处理带子路径的）
        urls.add(m[0]);
    }
    return [...urls];
}

/**
 * 从文本中提取 “仓库: owner/repo” / “repo: owner/repo” 形态的 GitHub 路径。
 * 主要用于 SkillsMP 这类 SSR 页面（直接展示仓库路径而非链接）。
 */
function extractRepoPaths(text: string): string[] {
    const repos = new Set<string>();
    const re = /(?:仓库|repo|repository)\s*[:：]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        repos.add(m[1].trim());
    }
    return [...repos];
}

/**
 * 将一组 owner/repo 或 github URL 归一化为 https://github.com/owner/repo
 */
function toGithubUrl(repoOrUrl: string): string {
    if (/^https?:\/\//i.test(repoOrUrl)) return repoOrUrl;
    return `https://github.com/${repoOrUrl}`;
}

/**
 * 从内联 JSON 脚本（window.__X__ = {...}）中提取文本，用于二次搜索 github 链接
 */
function extractInlineJson(html: string): string {
    const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    let collected = '';
    for (const s of scripts) {
        if (/window\.__|self\.__|__NEXT_DATA__|__remixContext|__INITIAL_STATE__/.test(s)) {
            collected += s + '\n';
        }
    }
    return collected;
}

/**
 * 提取 SKILL.md / raw / zip 等可能的直链
 */
function extractDirectLinks(html: string): string[] {
    const links: string[] = [];
    const re = /https?:\/\/[^\s"'<>]+?\.(?:md|zip)(?:\?[^\s"'<>]*)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        links.push(m[0]);
    }
    // 也匹配常见的 raw 托管（如 raw.githubusercontent / gitee / 对象存储）
    const rawRe = /https?:\/\/(?:raw\.githubusercontent\.com|gitee\.com|[^"'<>]+\/raw\/)[^\s"'<>]+/gi;
    while ((m = rawRe.exec(html)) !== null) {
        links.push(m[0]);
    }
    return links;
}

/**
 * 解析平台 skill 页面 URL → 可安装的 Skill 信息
 *
 * 兼容两类输入：
 *  - 列表页（如 SkillsMP 的 /zh/skills）：返回页面中包含的多个仓库对应的 Skill；
 *  - 详情页（各平台单个 skill）：返回该 skill 对应的源。
 */
export async function resolvePlatformSkillUrl(
    skillsManager: SkillsManager,
    url: string
): Promise<ResolvePlatformResult> {
    const platform = detectPlatform(url);

    if (platform === 'unknown') {
        // 不是受支持的平台，交由 GitHub 解析器处理（兼容原有行为）
        const fallback = await skillsManager.parseImportUrl(url);
        return {...fallback, platform: 'unknown', resolvedVia: fallback.success ? 'github' : 'unknown'};
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let html = '';
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
            signal: controller.signal,
        });
        if (res.ok) {
            html = await res.text();
        }
    } catch {
        // 网络错误继续走下方兜底
    } finally {
        clearTimeout(timer);
    }

    // SkillsMP：SSR 页面直接展示 “仓库: owner/repo”，优先按列表批量解析
    if (platform === 'skillsmp') {
        const repoPaths = extractRepoPaths(html || url);
        if (repoPaths.length > 0) {
            const merged: DiscoveredSkill[] = [];
            let lastError = '';
            for (const repo of repoPaths) {
                const ghUrl = toGithubUrl(repo);
                try {
                    const r = await skillsManager.parseImportUrl(ghUrl);
                    if (r.success && r.skills.length > 0) merged.push(...r.skills);
                    else if (r.error) lastError = r.error;
                } catch {
                    // 单个解析失败不影响其它
                }
            }
            if (merged.length > 0) {
                return {success: true, skills: merged, platform, resolvedVia: 'list'};
            }
            if (lastError) {
                return {success: false, skills: [], platform, resolvedVia: 'list', error: lastError};
            }
        }
    }

    // 策略 2a：HTML 或内联 JSON 中的 GitHub 仓库链接
    const inlineJson = extractInlineJson(html);
    const githubUrls = [
        ...extractGithubUrls(html),
        ...extractGithubUrls(inlineJson),
    ];

    // 策略 2a'：HTML/内联 JSON 中的 “仓库: owner/repo” 路径（兜底，覆盖未渲染为链接的情况）
    const repoPaths = extractRepoPaths(html || '') || extractRepoPaths(inlineJson || '');
    for (const repo of repoPaths) {
        const gh = toGithubUrl(repo);
        if (!githubUrls.includes(gh)) githubUrls.push(gh);
    }

    if (githubUrls.length > 0) {
        // 批量尝试，返回所有成功解析的 Skill（支持详情页 + 列表页）
        const merged: DiscoveredSkill[] = [];
        let lastError = '';
        for (const gh of githubUrls) {
            try {
                const ghResult = await skillsManager.parseImportUrl(gh);
                if (ghResult.success && ghResult.skills.length > 0) {
                    merged.push(...ghResult.skills);
                } else if (ghResult.error) {
                    lastError = ghResult.error;
                }
            } catch {
                // 单个链接解析失败不影响其它
            }
        }
        if (merged.length > 0) {
            return {success: true, skills: merged, platform, resolvedVia: 'github'};
        }
        if (lastError) {
            // GitHub 解析失败（如该链接不是 skill 仓库），继续尝试直链
            // 仅保留错误用于后续兜底提示
        }
    }

    // 策略 2b：直链（SKILL.md / zip / raw）
    const directLinks = extractDirectLinks(html);
    const skillMd = directLinks.find(l => l.toLowerCase().endsWith('.md'));
    const zip = directLinks.find(l => l.toLowerCase().endsWith('.zip'));

    if (skillMd) {
        const discovered: DiscoveredSkill = {
            name: skillMd.split('/').filter(Boolean).pop()?.replace(/\.md$/, '') || 'skill',
            path: '',
            skillMdUrl: skillMd,
            skillMdContent: '',
            files: [{name: 'SKILL.md', path: 'SKILL.md', rawUrl: skillMd}],
            repository: {url, branch: '', owner: platform, repo: 'skill'},
        };
        return {
            success: true,
            skills: [discovered],
            platform,
            resolvedVia: 'direct-skill-md',
        };
    }

    if (zip) {
        // zip 需要下载后解压，当前安装通道面向 SKILL.md 目录；返回明确提示
        return {
            success: false,
            skills: [],
            platform,
            resolvedVia: 'zip',
            error:
                'Detected a zip download link but the installer requires a SKILL.md-based source. ' +
                'Please paste the GitHub repository URL of this skill instead.',
        };
    }

    // 全部策略失败：给出可操作的错误提示
    return {
        success: false,
        skills: [],
        platform,
        resolvedVia: 'unknown',
        error:
            `Could not extract a downloadable skill source from ${PLATFORM_NAMES[platform]}. ` +
            `The page may load its data dynamically (SPA) or require login. ` +
            `Tip: open the skill page in your browser, find the "GitHub" / "Source" / "Download" link, ` +
            `and paste that URL here here instead.`,
    };
}

// ============================================================================
//  API 直连搜索 / 下载（带鉴权）
//  用于「设置 → API 直连」驱动 Store 页对三平台 skill 的搜索与下载。
//  因三站多为 SPA（运行时 API 契约不稳定），采用「候选端点自适应探测」：
//  对每个平台预置若干候选端点模板，带 UA/Bearer 请求，命中即用；
//  日志输出实际请求与响应，便于真实 Electron 环境修正确切契约。
// ============================================================================

/** 直连搜索返回的归一化 skill 列表项（对齐渲染端 SkillListItem） */
export interface PlatformSkillListItem {
    id: string;
    name: string;
    description: string;
    /**
     * 平台显式标注语言的描述变体（key 为语言码，如 { zh: '…' }）。
     * 主进程拿不到界面语言，故不在此处决定展示哪一份，全部透传给渲染端按设置择优。
     */
    descriptions?: Record<string, string>;
    /** 来源平台 */
    source: SupportedPlatform;
    /** 详情/安装用的源 URL（GitHub 仓库或平台直链） */
    sourceUrl: string;
    /** 下载直链（优先，可空） */
    downloadUrl?: string;
    stars?: number;
    updatedAt?: string;
    /** 缩略信息（平台返回的原始摘要） */
    extra?: Record<string, unknown>;
    /** 服务端返回的真实分类 slug（如 architecture-patterns），默认源无此字段 */
    category?: string;
}

const DIRECT_UA = UA;

/**
 * 各平台候选搜索端点模板（{q}=关键词, {page}=页码, {size}=每页条数）
 *
 * 端点顺序 = 探测优先级，已按真实环境实测结果排序（2026-08 实测）：
 *  - modelscope：`/openapi/v1/skills` 为唯一可用契约，返回 {success,data:{skills,total,page_number,page_size}}。
 *    注意：`/api/v1/*` 与 `/api/skills/*` 在直连环境下会 **连接超时**（UND_ERR_CONNECT_TIMEOUT，约 10s），
 *    并非 404 —— 这类路径疑似被网关按 Referer/浏览器上下文限制，故必须排在最后或移除，
 *    否则每次搜索会先白白阻塞 10~20s 再降级。
 *  - skillsmp：`/api/skills?search=` 返回标准 JSON（{skills,pagination,filters}），
 *    优先于 SSR HTML 抓取（更快且字段完整）。
 *  - safeskill / skillhub：实测所有候选 API 均返回 HTML（SPA 壳或 404 页），
 *    暂无公开 JSON 契约，保留候选以便平台开放后自动命中。
 */
const PLATFORM_SEARCH_ENDPOINTS: Record<Exclude<SupportedPlatform, 'unknown'>, string[]> = {
    modelscope: [
        '/openapi/v1/skills?name={q}&page_number={page}&page_size={size}',
        '/openapi/v1/skills?name={q}&page={page}',
    ],
    safeskill: [
        '/api/v1/skills?query={q}&page={page}',
        '/hub/api/skills?search={q}&page={page}',
    ],
    skillhub: [
        '/api/v1/skills?search={q}&page={page}',
        '/api/skills?keyword={q}&page={page}',
    ],
    clawhub: [
        // 无公开关键词搜索契约：走专用趋势榜单实现（loadClawhubTrending），此处仅占位
        '/api/v1/trending?kind=skills&limit=20',
    ],
    skillsmp: [
        // 扁平搜索端点：实测 /api/skills?search={q} 对「空 q」也返回 40 条（total≈1200），
        // 而 v1 的 /api/v1/skills/search?q= 在空 q 时返回 MISSING_QUERY，会导致 Store 默认（空）搜索整条失败。
        // 故优先用扁平端点；其 {skills,pagination} 结构与 githubUrl/stars/updatedAt 字段已被 locateSkillArray/extractPageInfo/toListItem 兼容。
        '/api/skills?search={q}&page={page}&limit={size}',
        '/api/skills?search={q}&page={page}',
    ],
};

/** 分页元信息（尽力从平台响应中提取，缺失时按启发式推断） */
export interface PlatformPageInfo {
    /** 当前页码（1 起） */
    page: number;
    /** 每页条数 */
    pageSize: number;
    /** 总条数；平台未返回时为 null（此时只能依赖 hasMore 翻页） */
    total: number | null;
    /** 总页数；无 total 时为 null */
    totalPages: number | null;
    /** 是否还有下一页 */
    hasMore: boolean;
}

/** 直连搜索的分页结果 */
export interface PlatformSearchPage {
    items: PlatformSkillListItem[];
    pageInfo: PlatformPageInfo;
    /**
     * 上游真实总量（如 ClawHub 趋势榜单的 totalItems）。
     * 当数据源为「本地分页 + 截断拉取」（例如 ClawHub 只拉前 N 条但上游有数千条）时，
     * 此值应回填上游真实总量，前端据此显示准确的「总数 / 分页」而非被截断的本地条数。
     * 本地全量拉取的源无需设置（缺省 undefined，前端回退到本地条数）。
     */
    serverTotal?: number;
    /**
     * 分页模式，前端据此决定翻页行为：
     *  - `'server'`：后端按 page/pageSize 真分页（如 SkillHub 公开 API），翻页需重新请求对应页，
     *    且 pageInfo.total/totalPages 为上游真实值，前端直接用其驱动分页控件。
     *  - `'client'`（缺省）：后端一次返回本地全量（受拉取上限约束，如 ClawHub 最多 600 条），
     *    前端在本地对已累积列表做切片分页，pageInfo.total 可能为截断值。
     */
    pagingMode?: 'server' | 'client';
    /**
     * 该平台未提供公开的 skills 列表接口（如 SPA 站点所有候选端点均返回 HTML 壳）。
     * 此时 items 恒为空，并非网络/加载故障，前端应给出针对性的友好提示而非「加载失败」。
     */
    unsupported?: boolean;
}

// ============================================================================
//  平台 MCP Server 搜索（复用同一套连接 / 令牌机制）
//  用于「设置 → Skill 源管理」里的连接（如 ModelScope）驱动 Store 页对
//  MCP 广场的服务端分页搜索。各平台形态不同：ModelScope 以 PUT + JSON body
//  暴露 /openapi/v1/mcp/servers，无需令牌即可列；其它平台暂无已知公开契约。
// ============================================================================

/** 直连搜索返回的归一化 MCP server 列表项（对齐渲染端 ServerListItem） */
export interface PlatformServerListItem {
    id: string;
    name: string;
    displayName: string;
    description: string;
    /** 平台返回的分类 slug 数组（如 ['browser-automation']） */
    categories: string[];
    /** 热度（view_count / stars 等），用于卡片展示 */
    stars?: number;
    /** 图标地址（如 ModelScope 的 logo_url） */
    iconUrl?: string;
    /** 详情 / 源码地址（GitHub 等） */
    sourceUrl?: string;
    /** 来源平台 */
    source: SupportedPlatform;
    /** 平台返回的原始摘要 */
    extra?: Record<string, unknown>;
}

/** 平台 MCP server 搜索的分页结果 */
export interface PlatformServerSearchPage {
    items: PlatformServerListItem[];
    pageInfo: PlatformPageInfo;
}

/** 平台 MCP server 详情（归一化，对齐渲染端安装所需字段） */
export interface PlatformServerDetail {
    id: string;
    name: string;
    displayName: string;
    description: string;
    iconUrl?: string;
    categories: string[];
    stars?: number;
    sourceUrl?: string;
    author?: string;
    publisher?: string;
    isHosted?: boolean;
    isVerified?: boolean;
    tags: string[];
    /** README 内容（优先 zh，其次 en，最后顶层 readme） */
    readme: string;
    /** 安装配置：直接对应 McpServerConfig 的 command / args / env；无则为 null */
    install: {
        command: string;
        args: string[];
        env?: Record<string, string>;
    } | null;
    /** 平台返回的环境变量 Schema（有必填项时渲染配置表单） */
    envSchema?: { properties?: Record<string, unknown>; required?: string[]; type?: string };
    source: SupportedPlatform;
    extra?: Record<string, unknown>;
}

/**
 * 各平台 MCP server 搜索端点定义。
 *  - method：GET（查询串）或 PUT（JSON body）；
 *  - body/getParams：按 (query, page, size, category) 构造请求体 / 查询参数。
 * 当前仅 ModelScope 有稳定公开契约；其它平台保持空（返回空结果 + 提示）。
 */
interface PlatformServerEndpoint {
    method: 'GET' | 'PUT';
    path: string;
    buildBody?: (q: string, page: number, size: number, category: string) => Record<string, unknown>;
    buildQuery?: (q: string, page: number, size: number, category: string) => Record<string, string>;
}

const PLATFORM_SERVER_SEARCH: Partial<Record<Exclude<SupportedPlatform, 'unknown'>, PlatformServerEndpoint>> = {
    // ModelScope MCP 广场：PUT /openapi/v1/mcp/servers，body {search, filter:{category}, page_number, page_size}
    modelscope: {
        method: 'PUT',
        path: '/openapi/v1/mcp/servers',
        buildBody: (q, page, size, category) => {
            const body: Record<string, unknown> = {search: q, page_number: page, page_size: size};
            if (category) body.filter = {category};
            return body;
        },
    },
};

/** 将平台返回的原始 MCP server 条目归一化为 PlatformServerListItem */
function toServerListItem(raw: Record<string, unknown>, platform: SupportedPlatform): PlatformServerListItem {
    const id = String(raw.id || raw.qualifiedName || raw.name || 'server');
    const display = String(raw.chinese_name || raw.displayName || raw.name || id);
    const desc = String(raw.description || raw.desc || raw.summary || raw.detail || '');
    const repo = raw.repo || raw.repository || raw.repo_path;

    const categories = Array.isArray(raw.categories)
        ? (raw.categories as unknown[]).map(String)
        : typeof raw.category === 'string' && raw.category
            ? [raw.category]
            : [];

    const sourceUrl = raw.source_url
        ? String(raw.source_url)
        : raw.github_url
            ? String(raw.github_url)
            : raw.url
                ? String(raw.url)
                : repo
                    ? `https://github.com/${String(repo)}`
                    : undefined;

    const stars =
        typeof raw.view_count === 'number'
            ? raw.view_count
            : typeof raw.stars === 'number'
                ? raw.stars
                : typeof raw.downloads === 'number'
                    ? raw.downloads
                    : undefined;

    const iconUrl =
        typeof raw.logo_url === 'string' && raw.logo_url
            ? raw.logo_url
            : typeof raw.icon_url === 'string' && raw.icon_url
                ? raw.icon_url
                : undefined;

    return {
        id,
        name: String(raw.name || id),
        displayName: display,
        description: desc,
        categories,
        stars,
        iconUrl,
        sourceUrl,
        source: platform,
        extra: raw,
    };
}

/**
 * 用 API 直连（带 Bearer 令牌，可选）分页搜索某平台的 MCP server 列表。
 * 与 {@link searchPlatformDirectPaged} 共用 extractPageInfo / buildUrl，
 * 但支持 PUT + JSON body（ModelScope 契约）。
 */
export async function searchPlatformServersPaged(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    query: string,
    page = 1,
    pageSize = DIRECT_SEARCH_PAGE_SIZE,
    category = ''
): Promise<PlatformServerSearchPage> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DIRECT_SEARCH_PAGE_SIZE;

    const sp = platform as Exclude<SupportedPlatform, 'unknown'>;
    const def = PLATFORM_SERVER_SEARCH[sp];
    const log = (...args: unknown[]) => console.log('[direct-server-search]', ...args);

    if (!def) {
        log(`platform=${sp} 暂未实现 MCP server 搜索（无公开契约），返回空结果`);
        return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
    }

    const headers: Record<string, string> = {
        'User-Agent': DIRECT_UA,
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    // ModelScope 列表接口无需令牌即可访问；带了无效 Bearer 反而可能 401，
    // 故仅在有令牌时附带 Authorization。
    if (secret) headers['Authorization'] = `Bearer ${secret}`;
    if (def.method === 'PUT') headers['Content-Type'] = 'application/json';

    const url = buildUrl(baseUrl, def.path);
    const controller = new AbortController();
    const timeoutMs = sp === 'modelscope' ? 20000 : 15000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const init: RequestInit = {
            method: def.method,
            headers,
            redirect: 'follow',
            signal: controller.signal,
        };
        let requestUrl = url;
        if (def.method === 'PUT' && def.buildBody) {
            init.body = JSON.stringify(def.buildBody(query, safePage, safeSize, category));
        } else if (def.method === 'GET' && def.buildQuery) {
            const qp = def.buildQuery(query, safePage, safeSize, category);
            const qs = Object.entries(qp).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
            requestUrl = buildUrl(baseUrl, `${def.path}?${qs}`);
        }

        log(`begin platform=${sp} ${def.method} ${requestUrl} q="${query}" page=${safePage} size=${safeSize} cat=${category} auth=${!!secret}`);
        const started = Date.now();
        const res = await fetch(requestUrl, init);
        const text = await res.text();
        const durationMs = Date.now() - started;

        if (!res.ok) {
            log(`  ✗ ${url} -> HTTP ${res.status} (${durationMs}ms)`);
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }
        if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
            log(`  ✗ ${url} -> 非 JSON 响应（${text.length} 字节）`);
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }

        let json: any;
        try {
            json = JSON.parse(text);
        } catch (e) {
            log(`  ✗ ${url} -> JSON 解析失败：${(e as Error).message}`);
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }

        // 定位 mcp_server_list / servers 数组
        const arr: unknown[] =
            json?.data?.mcp_server_list ||
            json?.mcp_server_list ||
            json?.data?.servers ||
            json?.servers ||
            json?.data?.list ||
            json?.list ||
            [];
        const liked = arr.filter(
            (x): x is Record<string, unknown> =>
                !!x && typeof x === 'object' && ('id' in x || 'name' in x || 'qualifiedName' in x)
        );

        const pageInfo = extractPageInfo(json, safePage, safeSize, liked.length);
        log(`  ✓ ${url} -> ${liked.length} servers in ${durationMs}ms (total=${pageInfo.total ?? '?'}, hasMore=${pageInfo.hasMore})`);
        return {items: liked.map(r => toServerListItem(r, sp)), pageInfo};
    } catch (e) {
        const err = e as Error & { name?: string };
        log(`  ✗ ${url} -> ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 获取单个平台 MCP server 的详情（含安装配置 / README）。
 *
 * 当前仅 ModelScope 有稳定公开契约：
 *   GET {baseUrl}/openapi/v1/mcp/servers/{id}
 * 返回字段（实测 @modelcontextprotocol/fetch）：
 *   - server_config[].mcpServers[name] = { command, args, env? }  ← 即为安装所需配置
 *   - readme：顶层或 locales.{zh,en}.readme
 *   - source_url / categories / view_count / is_hosted / is_verified / tags 等元信息
 * 其它平台（SafeSkill / SkillHub / SkillsMP）暂无已知公开契约，直接抛错提示。
 */
export async function fetchPlatformServerDetail(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    serverId: string
): Promise<PlatformServerDetail> {
    const sp = platform as Exclude<SupportedPlatform, 'unknown'>;
    const log = (...args: unknown[]) => console.log('[direct-server-detail]', ...args);

    if (sp !== 'modelscope') {
        const msg = `平台 ${sp} 暂不支持 MCP server 详情（无公开契约）`;
        log(msg);
        throw new Error(msg);
    }

    const headers: Record<string, string> = {
        'User-Agent': DIRECT_UA,
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    // ModelScope 详情接口无需令牌即可访问；有令牌才附带 Bearer
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const url = buildUrl(baseUrl, `/openapi/v1/mcp/servers/${encodeURIComponent(serverId)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
        log(`begin platform=${sp} GET ${url} auth=${!!secret}`);
        const started = Date.now();
        const res = await fetch(url, {headers, redirect: 'follow', signal: controller.signal});
        const text = await res.text();
        const durationMs = Date.now() - started;

        if (!res.ok) {
            log(`  ✗ ${url} -> HTTP ${res.status} (${durationMs}ms)`);
            throw new Error(`获取详情失败（HTTP ${res.status}）`);
        }
        if (!text.trimStart().startsWith('{')) {
            log(`  ✗ ${url} -> 非 JSON 响应（${text.length} 字节）`);
            throw new Error('详情接口返回了非 JSON 内容');
        }

        let json: any;
        try {
            json = JSON.parse(text);
        } catch (e) {
            log(`  ✗ ${url} -> JSON 解析失败：${(e as Error).message}`);
            throw new Error('详情接口返回无法解析的 JSON');
        }

        const d = json?.data;
        if (!d || typeof d !== 'object') {
            log(`  ✗ ${url} -> 未返回 data 字段`);
            throw new Error('详情接口未返回数据');
        }

        // 安装配置：server_config[].mcpServers[name] = { command, args, env }
        let install: PlatformServerDetail['install'] = null;
        const cfgList: unknown[] = Array.isArray(d.server_config) ? d.server_config : [];
        for (const entry of cfgList) {
            const mcp = (entry as any)?.mcpServers;
            if (mcp && typeof mcp === 'object') {
                const key = Object.keys(mcp)[0];
                if (key) {
                    const c = mcp[key];
                    install = {
                        command: String(c.command || ''),
                        args: Array.isArray(c.args) ? c.args.map(String) : [],
                        env: c.env && typeof c.env === 'object' ? c.env : undefined,
                    };
                    break;
                }
            }
        }

        const readme: string =
            d.locales?.zh?.readme || d.locales?.en?.readme || d.readme || '';

        const categories = Array.isArray(d.categories)
            ? (d.categories as unknown[]).map(String)
            : typeof d.category === 'string' && d.category
                ? [d.category]
                : [];

        const stars =
            typeof d.view_count === 'number'
                ? d.view_count
                : typeof d.github_stars === 'number'
                    ? d.github_stars
                    : undefined;

        log(`  ✓ ${url} -> ok (${durationMs}ms, install=${install ? install.command : 'none'})`);
        return {
            id: String(d.id || serverId),
            name: String(d.name || serverId),
            displayName: String(d.chinese_name || d.name || d.id || serverId),
            description: String(d.description || ''),
            iconUrl: typeof d.logo_url === 'string' && d.logo_url ? d.logo_url : undefined,
            categories,
            stars,
            sourceUrl: typeof d.source_url === 'string' && d.source_url ? d.source_url : undefined,
            author: typeof d.author === 'string' && d.author ? d.author : undefined,
            publisher: typeof d.publisher === 'string' && d.publisher ? d.publisher : undefined,
            isHosted: typeof d.is_hosted === 'boolean' ? d.is_hosted : undefined,
            isVerified: typeof d.is_verified === 'boolean' ? d.is_verified : undefined,
            tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [],
            readme,
            install,
            envSchema: d.env_schema,
            source: sp,
            extra: d,
        };
    } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === 'AbortError') {
            log(`  ✗ ${url} -> 请求超时`);
            throw new Error('获取详情超时，请检查网络或连接配置');
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/** 默认每页条数（与 fillTpl 的 size 默认值保持一致） */
export const DIRECT_SEARCH_PAGE_SIZE = 20;

/**
 * 从平台响应中提取分页元信息。
 *
 * 实测各平台契约：
 *  - ModelScope：{data:{skills,total,page_number,page_size}}
 *  - SkillsMP  ：{skills,pagination:{page,limit,total,totalPages}}
 *  - 其它/兜底 ：无分页字段时，用「本页条数 == 请求 size」推断是否还有下一页
 */
function extractPageInfo(
    json: any,
    requestedPage: number,
    requestedSize: number,
    itemCount: number
): PlatformPageInfo {
    // 分页元信息可能位于不同层级：
    //  - SkillsMP：json.data.pagination = {page, limit, total, totalPages, hasNext, hasPrev, ...}
    //  - ModelScope：json.data = {skills, total, page_number, page_size}
    //  - 其它/兜底：json.pagination 或 json 顶层
    const p =
        json?.data?.pagination ||
        json?.pagination ||
        json?.data ||
        json ||
        {};

    const num = (v: unknown): number | null => {
        const n = typeof v === 'string' ? Number(v) : v;
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    };

    const total = num(p.total) ?? num(p.total_count) ?? num(p.totalCount) ?? num(json?.total);
    const pageSize =
        num(p.page_size) ?? num(p.pageSize) ?? num(p.limit) ?? num(p.per_page) ?? requestedSize;
    const page = num(p.page_number) ?? num(p.pageNumber) ?? num(p.page) ?? requestedPage;

    const effectiveSize = pageSize && pageSize > 0 ? pageSize : requestedSize;

    let totalPages = num(p.total_pages) ?? num(p.totalPages) ?? num(p.pages);
    if (totalPages === null && total !== null && effectiveSize > 0) {
        totalPages = Math.ceil(total / effectiveSize);
    }

    // 优先使用服务端明确给出的 hasNext（SkillsMP 直接返回，最可靠）；
    // 否则有 total 时精确判断，有 totalPages 时按页号判断，最后回退到「本页满页」启发式。
    let hasMore: boolean;
    if (typeof p.hasNext === 'boolean') {
        hasMore = p.hasNext;
    } else if (total !== null) {
        hasMore = page * effectiveSize < total;
    } else if (totalPages !== null) {
        hasMore = page < totalPages;
    } else {
        hasMore = itemCount >= effectiveSize;
    }

    return {
        page: page > 0 ? page : requestedPage,
        pageSize: effectiveSize,
        total,
        totalPages,
        hasMore,
    };
}

/** 单个端点探测的诊断记录，用于向渲染层回传"为什么没有结果" */
export interface DirectSearchAttempt {
    url: string;
    ok: boolean;
    status?: number;
    contentType?: string;
    bytes?: number;
    itemCount?: number;
    durationMs: number;
    /** 失败原因：http / non-json / empty / timeout / network / parse */
    reason?: string;
    errorCode?: string;
    message?: string;
}

/** 直连搜索的完整结果（含调用链路诊断） */
export interface DirectSearchDiagnostics {
    platform: SupportedPlatform;
    baseUrl: string;
    query: string;
    page: number;
    /** 分类过滤条件（透传给服务端做过滤） */
    category?: string;
    authorized: boolean;
    attempts: DirectSearchAttempt[];
    /** 命中的端点（无命中为 null） */
    matchedUrl: string | null;
    totalDurationMs: number;
    /** 面向用户的可操作提示（无结果时给出） */
    hint?: string;
}

/** 最近一次直连搜索的诊断信息（按平台缓存，供 IPC 查询） */
const lastDiagnostics = new Map<string, DirectSearchDiagnostics>();

export function getLastDirectSearchDiagnostics(platform: string): DirectSearchDiagnostics | null {
    return lastDiagnostics.get(platform) || null;
}

function buildUrl(base: string, path: string): string {
    const b = base.replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return b + p;
}

function fillTpl(tpl: string, q: string, page: number, size = 20, category = ''): string {
    return tpl
        .replace(/\{q\}/g, encodeURIComponent(q))
        .replace(/\{page\}/g, String(page))
        .replace(/\{size\}/g, String(size))
        .replace(/\{category\}/g, category ? encodeURIComponent(category) : '');
}

/** 从任意 JSON 对象数组里抽取出像 skill 的条目（含 name/title/id 之一） */
function pickSkillLike(arr: unknown[]): Record<string, unknown>[] {
    return arr.filter(
        (x): x is Record<string, unknown> =>
            !!x &&
            typeof x === 'object' &&
            ('name' in x || 'title' in x || 'id' in x || 'slug' in x || 'repo' in x)
    );
}

/**
 * 将平台返回的原始条目归一化为 PlatformSkillListItem。
 *
 * 已按真实响应补齐各平台字段别名（2026-08 实测）：
 *  - ModelScope：display_name / description / source_url（GitHub tree 链接）/ downloads / last_modified
 *  - SkillsMP  ：name / description / githubUrl / stars / updatedAt(unix 秒)
 */
function toListItem(raw: Record<string, unknown>, platform: SupportedPlatform): PlatformSkillListItem {
    const name = String(
        raw.display_name || raw.name || raw.title || raw.slug || raw.id || 'skill'
    );
    const desc = String(raw.description || raw.desc || raw.summary || raw.detail || '');
    // 带语言后缀的描述别名（description_zh / desc-en …）单独收集，供渲染端按界面语言择优
    const descriptions: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        const m = k.match(/^desc(?:ription)?[_-]([a-z]{2})$/i);
        if (m && typeof v === 'string' && v.trim()) descriptions[m[1].toLowerCase()] = v.trim();
    }
    const repo = raw.repo || raw.repository || raw.repo_path;

    // source_url（ModelScope）/ githubUrl（SkillsMP）都是可直接安装的 GitHub 源
    const sourceUrl = raw.source_url
        ? String(raw.source_url)
        : raw.githubUrl
            ? String(raw.githubUrl)
            : repo
                ? `https://github.com/${String(repo)}`
                : String(raw.url || raw.html_url || raw.link || '');

    // updatedAt 可能是 unix 秒（SkillsMP）或 ISO 字符串（ModelScope last_modified）
    let updatedAt: string | undefined;
    const rawUpdated = raw.updatedAt ?? raw.updated_at ?? raw.last_modified;
    if (typeof rawUpdated === 'number' && rawUpdated > 0) {
        updatedAt = new Date(rawUpdated * (rawUpdated < 1e12 ? 1000 : 1)).toISOString();
    } else if (rawUpdated) {
        updatedAt = String(rawUpdated);
    }

    const stars =
        typeof raw.stars === 'number'
            ? raw.stars
            : typeof raw.downloads === 'number'
                ? raw.downloads
                : undefined;

    // SkillsMP 服务端在条目上返回真实分类 slug（如 architecture-patterns）
    const category =
        typeof raw.category === 'string' && raw.category ? raw.category : undefined;

    // downloadUrl：优先用服务端返回的 download_url；否则对 ModelScope 非 GitHub 源，
    // 按 /skills/<owner>/<slug>/archive/zip/master 规律合成 zip 下载直链（实测可用）。
    //
    // 这里**不能**要求 sourceUrl 非空：ModelScope 有大量技能的 source_url 就是空串
    // （如 PantherAng/alipay-payment-integration），旧实现因此既给不出 sourceUrl 也给不出
    // downloadUrl，这些技能在商店里点安装必然失败。它们恰恰只能靠 zip 直链下载。
    let downloadUrl: string | undefined;
    if (raw.download_url) {
        downloadUrl = String(raw.download_url);
    } else if (
        platform === 'modelscope' &&
        !/(^|\.)github\.com\//.test(sourceUrl)
    ) {
        const skillId = String(raw.id || raw.slug || raw._id || '').trim();
        if (skillId) {
            const encodedId = skillId
                .split('/')
                .map((seg) => encodeURIComponent(seg).replace(/%40/g, '@'))
                .join('/');
            downloadUrl = `https://www.modelscope.cn/skills/${encodedId}/archive/zip/master`;
        }
    }

    return {
        id: String(raw.id || raw.slug || raw._id || name),
        name,
        description: desc,
        descriptions: Object.keys(descriptions).length > 0 ? descriptions : undefined,
        source: platform,
        sourceUrl,
        downloadUrl,
        stars,
        updatedAt,
        category,
        extra: raw,
    };
}

/**
 * 从任意 JSON 响应中定位 skill 数组。
 * 覆盖实测结构：{data:{skills:[]}}（ModelScope）、{skills:[]}（SkillsMP）、
 * 以及常见的 items/data/results/list 形态。
 */
function locateSkillArray(json: any): unknown[] {
    if (Array.isArray(json)) return json;
    const candidates = [
        json?.data?.skills,
        json?.skills,
        json?.items,
        json?.data?.list,
        json?.data?.items,
        json?.data,
        json?.results,
        json?.list,
    ];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return [];
}

/** 空结果的分页信息（保持结构稳定，避免渲染层判空） */
function emptyPageInfo(page: number, pageSize: number): PlatformPageInfo {
    return {page, pageSize, total: 0, totalPages: 0, hasMore: false};
}

// ============================================================================
//  SkillHub 专用数据源
//
//  SkillHub 提供公开分页接口 https://api.skillhub.cn/api/skills，无需凭证即可查询，
//  支持 page / pageSize / sortBy / order / keyword / category 参数，响应结构为
//  { code:0, data:{ skills:[...], total:N }, message }，data.total 即上游真实总量
//  （实测 10 万+）。故 SkillHub 走服务端真分页（pagingMode:'server'）：搜索与翻页
//  均直接转发到该接口，无需本地清单或 HTML 端点探测。
// ============================================================================

// SkillHub 公开分页接口（无凭证即可查询），真实服务端分页 + 搜索 + 排序。
// 实测：page/pageSize/sortBy/order/keyword 均生效，响应 data.total 给出上游真实总量。
const SKILLHUB_API_BASE = 'https://api.skillhub.cn/api/skills';

/**
 * SkillHub 技能包 zip 下载直链（`?slug=<slug>`，无凭证，实测返回 application/zip）。
 *
 * 列表接口的 `upstream_url` 绝大多数为 null，旧实现只能回退到站内详情页
 * `https://skillhub.cn/skills/<slug>`——那是个 Next.js SPA 壳，抓 HTML 提取不到任何源，
 * 导致 SkillHub 源的技能**全部无法安装**。该直链取自官方前端的 getSkillDownloadUrl，
 * zip 内含完整的 SKILL.md + scripts/ + references/。
 *
 * 注意：不要附带 `namespace` 参数——实测带上会 404，仅传 slug 才能命中。
 */
const SKILLHUB_DOWNLOAD_BASE = 'https://api.skillhub.cn/api/v1/download';

/** SkillHub 列表单条原始记录（仅取映射所需字段，其余按需扩展） */
interface SkillhubApiEntry {
    slug: string;
    name: string;
    description?: string;
    description_zh?: string;
    category?: string;
    homepage?: string;
    upstream_url?: string | null;
    namespace?: { publicSlug?: string };
    iconUrl?: string;
    stars?: number;
    downloads?: number;
    installs?: number;
    score?: number;
    version?: string;
    source?: string;
    verified?: boolean;
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: {'User-Agent': DIRECT_UA, 'Accept': 'text/plain,application/json,*/*'},
            redirect: 'follow',
            signal: controller.signal,
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

/** 把 SkillHub 列表单条记录映射成通用 skill 列表项；无法识别 slug 时返回 null */
function mapSkillhubEntry(e: SkillhubApiEntry): PlatformSkillListItem | null {
    const slug = e.slug;
    if (!slug) return null;
    // 这里不再写死「中文优先」：主进程不知道界面语言。description 作为主描述（语言未知，
    // 渲染端按内容判定），description_zh 作为显式中文变体一并透传，由界面语言决定展示哪一份。
    const descZh = (e.description_zh || '').trim();
    const desc = (e.description || '').trim() || descZh;
    const category = typeof e.category === 'string' && e.category ? e.category : 'general';
    return {
        id: `skillhub-${slug}`,
        name: e.name || slug,
        description: desc,
        descriptions: descZh ? {zh: descZh} : undefined,
        source: 'skillhub' as SupportedPlatform,
        // 优先用上游原始仓库地址（若接口提供），否则回退到 SkillHub 站内详情页（用于查看/外链）
        sourceUrl:
            (typeof e.upstream_url === 'string' && e.upstream_url) ||
            `https://skillhub.cn/skills/${slug}`,
        // 下载一律走站内 zip 直链：upstream_url 多为 null，且 zip 内容与站上展示一致，
        // 比按 GitHub 仓库猜 skill 子目录更可靠。
        downloadUrl: `${SKILLHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}`,
        category,
        stars: typeof e.stars === 'number' ? e.stars : undefined,
        extra: {
            slug,
            iconUrl: typeof e.iconUrl === 'string' ? e.iconUrl : undefined,
            downloads: typeof e.downloads === 'number' ? e.downloads : undefined,
            installs: typeof e.installs === 'number' ? e.installs : undefined,
            namespace: e.namespace?.publicSlug || undefined,
            version: e.version,
            source: e.source,
            verified: typeof e.verified === 'boolean' ? e.verified : undefined,
            homepage: e.homepage,
        },
    };
}

/**
 * 调用 SkillHub 公开分页接口取单页数据，并透传上游真实总量（data.total）。
 * 接口原生支持 page / pageSize / sortBy / order / keyword，故搜索与分页均在服务端完成。
 */
async function fetchSkillhubPage(
    query: string,
    page: number,
    pageSize: number,
    category: string
): Promise<{ items: PlatformSkillListItem[]; total: number }> {
    const log = (...args: unknown[]) => console.log('[skillhub]', ...args);

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    params.set('sortBy', 'score');
    params.set('order', 'desc');
    const q = query.trim();
    if (q) params.set('keyword', q);
    if (category && category !== 'all') params.set('category', category);

    const url = `${SKILLHUB_API_BASE}?${params.toString()}`;
    log(`GET ${url}`);

    const raw = await fetchText(url, 20000);
    if (!raw) {
        log(`✗ 无法获取 SkillHub 列表（${url}）`);
        throw new Error('无法获取 SkillHub 技能列表，请检查网络连接');
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        log(`✗ 响应不是合法 JSON`);
        throw new Error('SkillHub 返回了非预期的数据格式');
    }

    const body = (json ?? {}) as {
        code?: number;
        data?: { skills?: unknown[]; total?: number };
        message?: string;
    };
    if (body.code !== 0 || !body.data) {
        const msg = body.message || `接口返回 code=${body.code}`;
        log(`✗ ${msg}`);
        throw new Error(`SkillHub 接口错误：${msg}`);
    }

    const list = (Array.isArray(body.data.skills) ? body.data.skills : []) as SkillhubApiEntry[];
    const total = typeof body.data.total === 'number' ? body.data.total : list.length;
    const items = list.map(mapSkillhubEntry).filter((it): it is PlatformSkillListItem => it !== null);

    log(`✓ 第 ${page} 页 ${items.length} 条（上游共 ${total} 条）`);
    return {items, total};
}

/**
 * SkillHub 分页搜索：直接转发到公开分页接口（服务端真分页 + 搜索）。
 * 用上游 data.total 作为真实总量，并透传 serverTotal 给前端驱动「总数 / 分页」。
 */
async function searchSkillhubPaged(
    query: string,
    page: number,
    pageSize: number,
    category: string
): Promise<PlatformSearchPage> {
    const {items, total} = await fetchSkillhubPage(query, page, pageSize, category);

    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    const start = (page - 1) * pageSize;
    const hasMore = start + pageSize < total;

    return {
        items,
        pageInfo: {
            page,
            pageSize,
            total,
            totalPages,
            hasMore,
        },
        // 上游真实总量（10 万+），前端据此显示准确「共 N 个」并正确分页
        serverTotal: total,
        pagingMode: 'server',
    };
}

// ============================================================================
//  ClawHub 趋势榜单（https://clawhub.ai/api/v1/trending?kind=skills）
//  公开接口、无凭证即可查询，返回「skills 趋势」扁平列表（items[]），
//  不支持关键词搜索，故走本地模糊匹配 + 分页。
//
//  该接口用游标翻页：响应带 `nextCursor`，回传即取下一页；`limit` 上限 100，
//  `totalItems` 给出上游总量（实测数千条）。早期实现只取首屏 20 条，导致
//  商店里 ClawHub 源永远只有一页 —— 现改为按游标连续拉取到 CLAWHUB_MAX_ITEMS。
// ============================================================================

/** 趋势榜单缓存 TTL：10 分钟，避免每次搜索重打接口 */
const CLAWHUB_CACHE_TTL = 10 * 60 * 1000;
let clawhubCache: { ts: number; items: PlatformSkillListItem[]; total: number } | null = null;
let clawhubInflight: Promise<{ items: PlatformSkillListItem[]; total: number }> | null = null;

/** 把趋势榜单的单条原始记录映射成通用 skill 列表项，无法识别 id 时返回 null */
function mapClawhubEntry(entry: unknown): PlatformSkillListItem | null {
    const e = (entry ?? {}) as Record<string, unknown>;
    // 稳定 id：优先用 install.reference（如 tuobadaidai/consult-report 或
    // skills-sh:heygen-com/...），缺省回退到顶层 id / slug
    const install = (e.install as Record<string, unknown> | undefined) || {};
    const ref = String(install.reference ?? '');
    const id = ref || String(e.id ?? '') || String(e.slug ?? '');
    if (!id) return null;
    const installSourceUrl = String(install.sourceUrl ?? '');
    const linkSource = String((e.links as Record<string, unknown> | undefined)?.source ?? '');
    const canonical = String(e.canonicalUrl ?? '');
    const kind = String(install.kind ?? '');
    const slug = String(e.slug ?? '');

    // 下载通道按 install.kind 区分（实测榜单只有 clawhub / skills-sh 两类）：
    //  - clawhub 原生：install.reference 是 "<owner>/<slug>" 但 **不是** GitHub 仓库
    //    （如 plato-1/fable-method，github.com 上并不存在），拼 github 链接必然 404。
    //    正确通道是站内 zip 直链 /api/v1/download?slug=<slug>，包内含 SKILL.md。
    //  - skills-sh：install.sourceUrl 指向 skills.sh 详情页（SPA，抓 HTML 拿不到源），
    //    但 sourceIdentity 给出了真实的 GitHub owner/repo，交给 resolveSkillsShSkill
    //    在安装时定位具体 skill 子目录。
    let downloadUrl: string | undefined;
    let sourceUrl = '';
    if (kind === 'clawhub') {
        downloadUrl = `${CLAWHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug || id)}`;
        sourceUrl = canonical ? `https://clawhub.ai${canonical}` : `https://clawhub.ai/skills/${id}`;
    } else {
        sourceUrl = installSourceUrl || linkSource;
        if (!sourceUrl && ref && !ref.includes(':')) {
            sourceUrl = `https://github.com/${ref}`;
        }
        if (!sourceUrl) {
            sourceUrl = canonical ? `https://clawhub.ai${canonical}` : `https://clawhub.ai/skills/${id}`;
        }
    }

    const metrics = (e.metrics as Record<string, unknown> | undefined) || {};
    const lifetimeInstalls = typeof metrics.lifetimeInstalls === 'number' ? metrics.lifetimeInstalls : undefined;
    const updatedAt = typeof metrics.updatedAt === 'number' ? new Date(metrics.updatedAt).toISOString() : undefined;
    return {
        id,
        name: String(e.displayName ?? e.name ?? id),
        description: String(e.summary ?? e.description ?? ''),
        source: 'clawhub',
        sourceUrl,
        downloadUrl,
        stars: lifetimeInstalls,
        updatedAt,
        category: typeof e.lane === 'string' && e.lane ? e.lane : undefined,
        extra: {
            ref,
            slug: e.slug,
            installKind: install.kind,
            installSourceUrl,
            source: e.source,
            lane: e.lane,
            canonicalUrl: canonical,
            lifetimeInstalls,
            sourceIdentity: e.sourceIdentity,
            trust: e.trust,
        },
    };
}

async function loadClawhubTrending(): Promise<{ items: PlatformSkillListItem[]; total: number }> {
    const log = (...args: unknown[]) => console.log('[clawhub]', ...args);

    if (clawhubCache && Date.now() - clawhubCache.ts < CLAWHUB_CACHE_TTL) {
        return {items: clawhubCache.items, total: clawhubCache.total};
    }
    if (clawhubInflight) return clawhubInflight;

    clawhubInflight = (async () => {
        const list: PlatformSkillListItem[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        let upstreamTotal = 0;

        // 游标翻页：最多 CLAWHUB_MAX_ITEMS 条，或上游 nextCursor 耗尽为止
        while (list.length < CLAWHUB_MAX_ITEMS) {
            const remaining = CLAWHUB_MAX_ITEMS - list.length;
            const limit = Math.min(CLAWHUB_PAGE_LIMIT, remaining);
            const url =
                `${CLAWHUB_TRENDING_BASE}&limit=${limit}` +
                (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

            const raw = await fetchText(url);
            if (!raw) {
                // 首页就失败视为不可用；后续页失败则保留已拿到的部分，不整体报错
                if (list.length === 0) {
                    log(`✗ 无法获取趋势榜单（${url}）`);
                    throw new Error('无法获取 ClawHub 技能榜单，请检查网络连接');
                }
                log(`! 第 ${list.length / CLAWHUB_PAGE_LIMIT + 1} 页拉取失败，使用已获取的 ${list.length} 条`);
                break;
            }

            let json: unknown;
            try {
                json = JSON.parse(raw);
            } catch {
                if (list.length === 0) {
                    log(`✗ 响应不是合法 JSON`);
                    throw new Error('ClawHub 返回了非预期的数据格式');
                }
                break;
            }

            const body = (json ?? {}) as { items?: unknown; nextCursor?: unknown; totalItems?: unknown };
            if (typeof body.totalItems === 'number') upstreamTotal = body.totalItems;

            const pageItems = Array.isArray(body.items) ? body.items : [];
            if (pageItems.length === 0) break;

            for (const entry of pageItems) {
                const mapped = mapClawhubEntry(entry);
                // 上游按趋势快照排序，翻页时偶有重复条目，按 id 去重
                if (!mapped || seen.has(mapped.id)) continue;
                seen.add(mapped.id);
                list.push(mapped);
            }

            const next = typeof body.nextCursor === 'string' ? body.nextCursor : '';
            if (!next || next === cursor) break;
            cursor = next;
        }

        clawhubCache = {ts: Date.now(), items: list, total: upstreamTotal};
        log(`✓ 拉取 ${list.length} 个 trending skill（上游共 ${upstreamTotal || '未知'} 条）`);
        return {items: list, total: upstreamTotal};
    })();

    try {
        return await clawhubInflight;
    } finally {
        clawhubInflight = null;
    }
}

async function searchClawhubPaged(
    query: string,
    page: number,
    pageSize: number,
    category: string
): Promise<PlatformSearchPage> {
    const {items: all, total: upstreamTotal} = await loadClawhubTrending();
    let filtered = all;

    if (category) {
        filtered = filtered.filter(it => it.category === category);
    }

    const q = query.trim().toLowerCase();
    if (q) {
        filtered = filtered.filter(it => {
            const slug = String((it.extra as Record<string, unknown> | undefined)?.slug || '');
            return (
                it.name.toLowerCase().includes(q) ||
                it.description.toLowerCase().includes(q) ||
                slug.toLowerCase().includes(q)
            );
        });
    }

    // 无搜索、无分类时展示上游真实总量（totalItems，可能 > 本地已拉取条数）；
    // 有搜索/分类时本地过滤，只能用本地条数（上游不提供子集总量）。
    const noFilter = !q && !category;
    const total = noFilter && upstreamTotal > 0 ? upstreamTotal : filtered.length;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
        items,
        pageInfo: {page, pageSize, total, totalPages, hasMore: start + pageSize < total},
        serverTotal: upstreamTotal > 0 ? upstreamTotal : undefined,
        // 本地全量拉取后前端切片分页（受 CLAWHUB_MAX_ITEMS 截断，翻页范围以本地为准）
        pagingMode: 'client',
    };
}

/**
 * 用 API 直连（带 Bearer 令牌）搜索某平台 skill 列表（仅返回条目）。
 *
 * 保留此签名以兼容既有调用方；需要分页元信息时请使用
 * {@link searchPlatformDirectPaged}。
 */
export async function searchPlatformDirect(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    query: string,
    page = 1,
    pageSize = DIRECT_SEARCH_PAGE_SIZE,
    category = ''
): Promise<PlatformSkillListItem[]> {
    const {items} = await searchPlatformDirectPaged(platform, baseUrl, secret, query, page, pageSize, category);
    return items;
}

/**
 * 用 API 直连（带 Bearer 令牌）分页搜索某平台 skill 列表。
 * 自适应探测候选端点；命中即映射返回，并附带平台分页元信息。
 */
export async function searchPlatformDirectPaged(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    query: string,
    page = 1,
    pageSize = DIRECT_SEARCH_PAGE_SIZE,
    category = ''
): Promise<PlatformSearchPage> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DIRECT_SEARCH_PAGE_SIZE;

    if (platform === 'custom') {
        return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
    }
    const sp = platform as Exclude<SupportedPlatform, 'unknown'>;
    const startedAll = Date.now();

    // SkillHub：站点为 Next.js SPA，无任何公开 JSON 列表接口（所有候选端点均返回
    // HTML 壳），直接改用其开源清单仓库 iflytek/skillhub 的 builtin-skills 目录。
    // 提前返回可跳过必然失败的端点探测，避免每次搜索白等数秒。
    if (sp === 'skillhub') {
        try {
            const res = await searchSkillhubPaged(query, safePage, safeSize, category);
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: SKILLHUB_API_BASE,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: SKILLHUB_API_BASE,
                        ok: true,
                        itemCount: res.items.length,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: SKILLHUB_API_BASE,
                totalDurationMs: Date.now() - startedAll,
            });
            return res;
        } catch (e) {
            const msg = (e as Error).message;
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: SKILLHUB_API_BASE,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: SKILLHUB_API_BASE,
                        ok: false,
                        reason: 'network',
                        message: msg,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: null,
                totalDurationMs: Date.now() - startedAll,
                hint: `获取 SkillHub 技能清单失败：${msg}`,
            });
            // 网络失败属于真实故障，不能标记 unsupported（否则前端会误报"平台不支持"）
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }
    }

    // ClawHub：公开趋势榜单接口（无凭证），不支持关键词搜索，走专用本地分页实现
    if (sp === 'clawhub') {
        try {
            const res = await searchClawhubPaged(query, safePage, safeSize, category);
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: CLAWHUB_TRENDING_URL,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: CLAWHUB_TRENDING_URL,
                        ok: true,
                        itemCount: res.items.length,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: CLAWHUB_TRENDING_URL,
                totalDurationMs: Date.now() - startedAll,
            });
            return res;
        } catch (e) {
            const msg = (e as Error).message;
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: CLAWHUB_TRENDING_URL,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: CLAWHUB_TRENDING_URL,
                        ok: false,
                        reason: 'network',
                        message: msg,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: null,
                totalDurationMs: Date.now() - startedAll,
                hint: `获取 ClawHub 技能榜单失败：${msg}`,
            });
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }
    }

    const diag: DirectSearchDiagnostics = {
        platform: sp,
        baseUrl,
        query,
        page: safePage,
        category,
        authorized: !!secret,
        attempts: [],
        matchedUrl: null,
        totalDurationMs: 0,
    };

    const headers: Record<string, string> = {
        'User-Agent': DIRECT_UA,
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    // 仅在有令牌时附带 Authorization：部分平台（如 ModelScope 公开接口）
    // 对携带无效 Bearer 的请求会直接 401，反而不如匿名可用。
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const log = (...args: unknown[]) => console.log('[direct-search]', ...args);

    log(`begin platform=${sp} base=${baseUrl} q="${query}" page=${safePage} size=${safeSize} auth=${!!secret}`);

    const endpoints = PLATFORM_SEARCH_ENDPOINTS[sp] || [];

    for (const ep of endpoints) {
        const url = buildUrl(baseUrl, fillTpl(ep, query, safePage, safeSize, category));
        const controller = new AbortController();
        // ModelScope 首字节较慢（实测 6s+），给足 20s；其余 15s
        const timeoutMs = sp === 'modelscope' ? 20000 : 15000;
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const started = Date.now();
        const attempt: DirectSearchAttempt = {url, ok: false, durationMs: 0};

        try {
            const res = await fetch(url, {headers, redirect: 'follow', signal: controller.signal});
            attempt.status = res.status;
            attempt.contentType = res.headers.get('content-type') || '';

            if (!res.ok) {
                attempt.reason = 'http';
                attempt.message =
                    res.status === 401 || res.status === 403
                        ? `鉴权失败（HTTP ${res.status}）：令牌无效或无该接口权限`
                        : `HTTP ${res.status}`;
                log(`  ✗ ${url} -> ${attempt.message}`);
                continue;
            }

            const text = await res.text();
            attempt.bytes = text.length;

            // 关键：SPA 平台常以 200 返回 HTML 壳，必须按内容而非状态码判定
            if (!attempt.contentType.includes('json') && !text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
                attempt.reason = 'non-json';
                attempt.message = `返回 HTML 而非 JSON（SPA 壳页，${text.length} 字节），该端点非数据接口`;
                log(`  ✗ ${url} -> ${attempt.message}`);
                continue;
            }

            let json: any;
            try {
                json = JSON.parse(text);
            } catch (e) {
                attempt.reason = 'parse';
                attempt.message = `JSON 解析失败：${(e as Error).message}`;
                log(`  ✗ ${url} -> ${attempt.message}`);
                continue;
            }

            const arr = locateSkillArray(json);
            const liked = pickSkillLike(arr);
            attempt.itemCount = liked.length;

            if (liked.length > 0) {
                attempt.ok = true;
                attempt.durationMs = Date.now() - started;
                diag.attempts.push(attempt);
                diag.matchedUrl = url;
                diag.totalDurationMs = Date.now() - startedAll;
                lastDiagnostics.set(sp, diag);

                const pageInfo = extractPageInfo(json, safePage, safeSize, liked.length);
                log(
                    `  ✓ ${url} -> ${liked.length} items in ${attempt.durationMs}ms ` +
                    `(page ${pageInfo.page}/${pageInfo.totalPages ?? '?'}, total=${pageInfo.total ?? '?'}, hasMore=${pageInfo.hasMore})`
                );
                return {items: liked.map(r => toListItem(r, sp)), pageInfo};
            }

            attempt.reason = 'empty';
            attempt.message = `响应为合法 JSON 但未找到 skill 数组（topKeys=${Object.keys(json || {}).join(',')}）`;
            log(`  ✗ ${url} -> ${attempt.message}`);
        } catch (e) {
            const err = e as Error & { cause?: { code?: string } };
            const code = err.cause?.code || err.name;
            attempt.errorCode = code;
            attempt.reason = err.name === 'AbortError' ? 'timeout' : 'network';
            attempt.message =
                err.name === 'AbortError'
                    ? `请求超时（>${timeoutMs}ms），该端点可能被网关限制或不可达`
                    : `网络错误 ${code}：${err.message}`;
            log(`  ✗ ${url} -> ${attempt.message}`);
        } finally {
            clearTimeout(t);
            if (!attempt.ok) {
                attempt.durationMs = Date.now() - started;
                diag.attempts.push(attempt);
            }
        }
    }

    // 兜底：SkillsMP 的 SSR 列表页可提取 "仓库: owner/repo"
    if (sp === 'skillsmp') {
        const listUrl = buildUrl(
            baseUrl,
            `/zh/skills?q=${encodeURIComponent(query)}&page=${safePage}`
        );
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        const started = Date.now();
        const attempt: DirectSearchAttempt = {url: listUrl, ok: false, durationMs: 0};
        try {
            const res = await fetch(listUrl, {headers, signal: controller.signal});
            attempt.status = res.status;
            if (res.ok) {
                const html = await res.text();
                attempt.bytes = html.length;
                const repos = extractRepoPaths(html);
                attempt.itemCount = repos.length;
                if (repos.length > 0) {
                    attempt.ok = true;
                    attempt.durationMs = Date.now() - started;
                    diag.attempts.push(attempt);
                    diag.matchedUrl = listUrl;
                    diag.totalDurationMs = Date.now() - startedAll;
                    lastDiagnostics.set(sp, diag);

                    // SSR 页面无分页契约：若该页已按 page 参数返回对应内容，则整页使用；
                    // 否则（服务端忽略 page）在本地切片，保证翻页行为一致、不重复。
                    const sliced = repos.length > safeSize
                        ? repos.slice((safePage - 1) * safeSize, safePage * safeSize)
                        : repos;

                    const pageInfo: PlatformPageInfo =
                        repos.length > safeSize
                            ? {
                                page: safePage,
                                pageSize: safeSize,
                                total: repos.length,
                                totalPages: Math.ceil(repos.length / safeSize),
                                hasMore: safePage * safeSize < repos.length,
                            }
                            : {
                                page: safePage,
                                pageSize: safeSize,
                                total: null,
                                totalPages: null,
                                hasMore: repos.length >= safeSize,
                            };

                    log(`  ✓ ${listUrl} (SSR) -> ${repos.length} repos, page ${safePage} -> ${sliced.length}`);
                    return {
                        items: sliced.map(r => ({
                            id: r,
                            name: r.split('/').pop() || r,
                            description: `GitHub 仓库 ${r}（来自 SkillsMP）`,
                            source: 'skillsmp' as SupportedPlatform,
                            sourceUrl: `https://github.com/${r}`,
                        })),
                        pageInfo,
                    };
                }
                attempt.reason = 'empty';
                attempt.message = 'SSR 页面未提取到仓库路径';
            } else {
                attempt.reason = 'http';
                attempt.message = `HTTP ${res.status}`;
            }
        } catch (e) {
            const err = e as Error & { cause?: { code?: string } };
            attempt.reason = err.name === 'AbortError' ? 'timeout' : 'network';
            attempt.errorCode = err.cause?.code || err.name;
            attempt.message = err.message;
        } finally {
            clearTimeout(t);
            if (!attempt.ok) {
                attempt.durationMs = Date.now() - started;
                diag.attempts.push(attempt);
            }
        }
    }

    // 全部候选端点未命中：生成可操作的用户提示
    const allNonJson = diag.attempts.length > 0 && diag.attempts.every(a => a.reason === 'non-json');
    const anyAuthFail = diag.attempts.some(a => a.status === 401 || a.status === 403);
    const allTimeout = diag.attempts.length > 0 && diag.attempts.every(a => a.reason === 'timeout');

    const allEmpty = diag.attempts.length > 0 && diag.attempts.every(a => a.reason === 'empty');

    if (anyAuthFail) {
        diag.hint = '令牌鉴权失败（401/403）。请在「设置 → API 令牌」确认令牌有效且具备读取权限。';
    } else if (allEmpty && safePage > 1) {
        // 翻页翻过头：接口正常但该页无数据，明确引导回上一页
        diag.hint = `第 ${safePage} 页没有更多技能了，请返回上一页。`;
    } else if (allTimeout) {
        diag.hint = '所有端点请求超时。请检查网络/代理，或该平台接口对客户端直连有网关限制。';
    } else if (allNonJson) {
        diag.hint =
            `${PLATFORM_NAMES[sp]} 当前未开放公开的 JSON 搜索接口（所有候选端点均返回 SPA 页面）。` +
            `请改用「粘贴 GitHub 仓库链接」方式导入该平台的技能。`;
    } else {
        diag.hint = `${PLATFORM_NAMES[sp]} 未返回可解析的技能列表，详见诊断信息。`;
    }

    diag.totalDurationMs = Date.now() - startedAll;
    lastDiagnostics.set(sp, diag);
    log(`end platform=${sp} NO MATCH in ${diag.totalDurationMs}ms; hint=${diag.hint}`);
    log('  attempts:', JSON.stringify(diag.attempts, null, 2));

    // 所有候选端点均返回 SPA 页面（非 JSON）：平台未提供公开列表接口，
    // 标记 unsupported 让前端区分「平台不支持」与「真实加载故障」。
    const unsupported = allNonJson;

    return {items: [], pageInfo: emptyPageInfo(safePage, safeSize), unsupported};
}

/**
 * 直连方式将某平台 skill 解析为可安装 Skill（复用 GitHub 通道 / 直链）。
 */
export async function resolveDirectSkill(
    skillsManager: SkillsManager,
    platform: PlatformType,
    sourceUrl: string
): Promise<ResolvePlatformResult> {
    // GitHub 仓库源 → 复用现有通道
    if (sourceUrl.includes('github.com')) {
        const gh = await skillsManager.parseImportUrl(sourceUrl);
        return {...gh, platform: platform as SupportedPlatform, resolvedVia: gh.success ? 'github' : 'unknown'};
    }
    // skills.sh 详情页（ClawHub 榜单里 install.kind='skills-sh' 的条目）→ 定位其 GitHub 源
    if (SKILLS_SH_URL_RE.test(sourceUrl)) {
        return resolveSkillsShSkill(skillsManager, sourceUrl, platform as SupportedPlatform);
    }
    // 各平台 zip 下载直链 → 下载解压后取 SKILL.md：
    //  - ModelScope：/skills/<owner>/<slug>/archive/zip/master
    //  - ClawHub / SkillHub：/api/v1/download?slug=<slug>
    if (isZipDownloadUrl(sourceUrl)) {
        return resolveZipSkill(skillsManager, sourceUrl, platform as SupportedPlatform);
    }
    // 平台直链（SKILL.md / zip）→ 复用详情页解析
    return resolvePlatformSkillUrl(skillsManager, sourceUrl);
}

/** 已知的平台 zip 下载直链形态（这些 URL 直接返回 application/zip，无需再抓 HTML） */
function isZipDownloadUrl(url: string): boolean {
    return (
        /modelscope\.cn\/skills\/.+\/archive\/zip/i.test(url) ||
        url.startsWith(CLAWHUB_DOWNLOAD_BASE) ||
        url.startsWith(SKILLHUB_DOWNLOAD_BASE)
    );
}

/** skills.sh 技能详情页：https://www.skills.sh/<owner>/<repo>/<skill...> */
const SKILLS_SH_URL_RE = /^https?:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)\/(.+?)\/?$/i;

/**
 * 把 skills.sh 详情页解析为可安装 Skill。
 *
 * skills.sh 本身是 Next.js SPA，页面里只能提取到仓库根链接（如 github.com/<owner>/<repo>），
 * 拿不到 skill 在仓库中的具体子目录；而同一仓库常含几十个 skill，装错目录等于装错技能。
 * 各仓库布局也不统一（实测 prisma/skills 在根、vercel-labs/skills 在 skills/、
 * mattpocock/skills 在 skills/productivity/ 这种二级目录）。
 *
 * 因此分两步：先用 raw.githubusercontent.com 逐个 HEAD 探测常见布局（命中即返回，
 * 不消耗 api.github.com 配额）；都不中再退回整仓解析，按名字挑出目标 skill
 * （覆盖任意深度的嵌套目录）。
 */
async function resolveSkillsShSkill(
    skillsManager: SkillsManager,
    url: string,
    platform: SupportedPlatform
): Promise<ResolvePlatformResult> {
    const m = url.match(SKILLS_SH_URL_RE);
    if (!m) {
        return {success: false, skills: [], platform, resolvedVia: 'unknown', error: `无法解析 skills.sh 链接：${url}`};
    }
    const [, owner, repo, rest] = m;
    const skillName = rest.split('/').filter(Boolean).pop() || rest;

    // raw 支持 HEAD 作为 ref（等价默认分支），省掉一次 getDefaultBranch 调用
    const candidates = [
        rest,
        skillName,
        `skills/${skillName}`,
        `.claude/skills/${skillName}`,
        `.agents/skills/${skillName}`,
        `.cursor/skills/${skillName}`,
    ];
    const tried = new Set<string>();
    for (const c of candidates) {
        const rel = c.replace(/^\/+|\/+$/g, '');
        if (!rel || tried.has(rel)) continue;
        tried.add(rel);
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${rel}/SKILL.md`;
        let hit = false;
        try {
            const res = await fetch(rawUrl, {method: 'HEAD', headers: {'User-Agent': UA}, redirect: 'follow'});
            hit = res.ok;
        } catch {
            // 网络抖动不影响后续候选
        }
        if (hit) {
            const gh = await skillsManager.parseImportUrl(`https://github.com/${owner}/${repo}/tree/HEAD/${rel}`);
            if (gh.success && gh.skills.length > 0) {
                return {...gh, platform, resolvedVia: 'github'};
            }
        }
    }

    // 兜底：整仓解析后按 skill 名精确匹配（覆盖 skills/<分类>/<skill> 这类嵌套布局）
    const all = await skillsManager.parseImportUrl(`https://github.com/${owner}/${repo}`);
    if (all.success && all.skills.length > 0) {
        const key = skillName.toLowerCase();
        const matched = all.skills.filter(
            s => s.name.toLowerCase() === key || s.path.split('/').pop()?.toLowerCase() === key
        );
        return {
            success: true,
            skills: matched.length > 0 ? matched : all.skills,
            platform,
            resolvedVia: 'github',
        };
    }

    return {
        success: false,
        skills: [],
        platform,
        resolvedVia: 'unknown',
        error: all.error || `未能在 github.com/${owner}/${repo} 中定位技能 ${skillName}`,
    };
}

/**
 * 从任意平台的 zip 下载直链解析 Skill：
 * 下载 zip → 解压到临时目录 → 读取其中的 SKILL.md 作为安装内容。
 * 该通道用于无 GitHub 源的 skill，覆盖 ModelScope / ClawHub / SkillHub 的压缩包直链。
 */
async function resolveZipSkill(
    _skillsManager: SkillsManager,
    zipUrl: string,
    platform: SupportedPlatform
): Promise<ResolvePlatformResult> {
    const tmpRoot = path.join(os.tmpdir(), 'mcp-dock-ms-zip');
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const zipPath = path.join(tmpRoot, `${token}.zip`);
    const extractDir = path.join(tmpRoot, token);
    try {
        await fsp.mkdir(tmpRoot, {recursive: true});
        // 1) 下载 zip
        const res = await fetch(zipUrl, {headers: {'User-Agent': UA}});
        if (!res.ok) {
            return {
                success: false,
                skills: [],
                platform,
                resolvedVia: 'zip',
                error: `下载 Skill 压缩包失败：HTTP ${res.status}（${zipUrl}）`,
            };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        await fsp.writeFile(zipPath, buf);
        // 2) 解压（优先系统 tar，回退 PowerShell Expand-Archive）
        await fsp.mkdir(extractDir, {recursive: true});
        let extracted = false;
        try {
            await execFileAsync('tar', ['-xf', zipPath, '-C', extractDir]);
            extracted = true;
        } catch {
            try {
                await execFileAsync('powershell', [
                    '-NoProfile',
                    '-Command',
                    `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}'`,
                ]);
                extracted = true;
            } catch (e) {
                extracted = false;
            }
        }
        if (!extracted) {
            return {
                success: false,
                skills: [],
                platform,
                resolvedVia: 'zip',
                error: '解压 Skill 压缩包失败：系统缺少 tar 或 PowerShell Expand-Archive 支持。',
            };
        }
        // 3) 定位 SKILL.md（zip 可能带顶层目录，递归查找）
        const skillMdPath = await findFileRecursive(extractDir, 'SKILL.md');
        if (!skillMdPath) {
            return {
                success: false,
                skills: [],
                platform,
                resolvedVia: 'zip',
                error: '压缩包内未找到 SKILL.md，无法识别为有效 Skill。',
            };
        }
        const skillMdContent = await fsp.readFile(skillMdPath, 'utf-8');
        const fm = parseFrontmatter(skillMdContent);
        const skillName = sanitizeSkillName(
            (fm?.name as string) || path.basename(path.dirname(skillMdPath)) || 'skill'
        );
        const skill: DiscoveredSkill = {
            name: skillName,
            path: '',
            skillMdUrl: zipUrl,
            skillMdContent,
            files: [],
            repository: {
                url: zipUrl,
                branch: 'master',
                owner: (platform === 'clawhub' || platform === 'skillhub') ? platform : 'modelscope',
                repo: skillName
            },
            downloadUrl: zipUrl,
        };
        return {success: true, skills: [skill], platform, resolvedVia: 'zip'};
    } catch (e) {
        return {
            success: false,
            skills: [],
            platform,
            resolvedVia: 'zip',
            error: `解析 Skill 压缩包失败：${(e as Error).message}`,
        };
    } finally {
        // 清理临时文件（解压内容已读入内存，本地临时产物可删）
        await fsp.rm(tmpRoot, {recursive: true, force: true}).catch(() => {
        });
    }
}

/** 递归查找首个匹配文件名的绝对路径 */
async function findFileRecursive(dir: string, fileName: string): Promise<string | null> {
    let entries: Dirent[];
    try {
        entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
        return null;
    }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            const found = await findFileRecursive(full, fileName);
            if (found) return found;
        } else if (ent.name.toLowerCase() === fileName.toLowerCase()) {
            return full;
        }
    }
    return null;
}

/** 将任意字符串规范化为安全的 skill 目录名（小写、仅保留字母数字与 -_） */
function sanitizeSkillName(raw: string): string {
    const cleaned = String(raw)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_\-./]+/g, '-')
        .replace(/^[.\-]+|[.\-]+$/g, '');
    return cleaned || 'skill';
}

/** promisify execFile 简化版（无 stdout 捕获需求时） */
function execFileAsync(file: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(file, args, {windowsHide: true}, (err) => (err ? reject(err) : resolve()));
    });
}
