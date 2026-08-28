/**
 * 平台 Skill 解析器 —— 共享分页 / 请求工具。
 * 这些纯函数被各平台专用模块与统一分发逻辑复用（提取自原 platform-skill-resolver.ts）。
 */

import type {PlatformPageInfo, PlatformSkillListItem, SupportedPlatform} from './types';
import {DIRECT_UA} from './types';

/**
 * 从平台响应中提取分页元信息。
 *
 * 实测各平台契约：
 *  - ModelScope：请求 ?name=&page_number=&page_size=（见 PLATFORM_SEARCH_ENDPOINTS）；响应分页字段经下方回退链同时兼容 page/size 与 page_number/page_size
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
    //  - ModelScope：请求用 page + page_size；响应分页字段兼容 page/size 与 page_number/page_size（见下方回退链）
    //  - 其它/兜底：json.pagination 或 json 顶层
    const p =
        json?.data?.pagination ||
        json?.pagination ||
        json?.Data?.McpServer ||
        json?.Data ||
        json?.data ||
        json ||
        {};

    const num = (v: unknown): number | null => {
        const n = typeof v === 'string' ? Number(v) : v;
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    };

    const total =
        num(p.total) ??
        num(p.total_count) ??
        num(p.totalCount) ??
        num(json?.Data?.McpServer?.TotalCount) ??
        num(json?.Data?.totalCount) ??
        num(json?.Data?.total) ??
        num(json?.total);
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

export {
    extractPageInfo,
    buildUrl,
    fillTpl,
    pickSkillLike,
    toListItem,
    locateSkillArray,
    emptyPageInfo,
    fetchText,
};
