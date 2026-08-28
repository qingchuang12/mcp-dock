/**
 * 平台 Skill 解析器 —— SkillHub 专用数据源。
 * SkillHub 提供公开分页接口（无凭证即可查询），服务端真分页；其余逻辑见原文件注释。
 */

import type {PlatformSearchPage, PlatformSkillListItem, SupportedPlatform} from './types';
import {fetchText} from './pagination';

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
export const SKILLHUB_DOWNLOAD_BASE = 'https://api.skillhub.cn/api/v1/download';

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
    const log = (..._args: unknown[]) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[resolver]', ..._args);
    };

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

export {SKILLHUB_API_BASE, searchSkillhubPaged};
