/**
 * ClawHub 平台适配器。
 * 接口形态：Convex RPC，POST https://wry-manatee-359.convex.cloud/api/action。
 * 离线回退：若联网失败，尝试读取内置离线索引（data/clawhub.json）。
 */
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformSearchPage,
    PlatformSearchParams,
    PlatformSkillListItem,
    SortOption,
} from './types';
import {buildHint, extractPageInfo, setDiagnostics} from './shared';
import * as path from 'path';
import * as fs from 'fs';

// 文档 14 类分类（integrations/automation/research 等）
const CLAWHUB_CATEGORIES: CategoryNode[] = [
    {id: 'integrations', name: '集成'},
    {id: 'automation', name: '自动化'},
    {id: 'research', name: '研究'},
    {id: 'development', name: '开发'},
    {id: 'productivity', name: '效率'},
    {id: 'communication', name: '沟通'},
    {id: 'creative', name: '创意'},
    {id: 'knowledge', name: '知识'},
    {id: 'agents', name: '智能体'},
    {id: 'operations', name: '运维'},
    {id: 'security', name: '安全'},
    {id: 'finance', name: '金融'},
    {id: 'lifestyle', name: '生活'},
    {id: 'other', name: '其他'},
];

// API 不支持服务端排序，仅保留客户端排序选项（按 score / downloads）
const CLAWHUB_SORTS: SortOption[] = [
    {id: 'relevance', name: '相关度', field: 'relevance', order: 'desc'},
    {id: 'downloads', name: '下载最多', field: 'downloads', order: 'desc'},
    {id: 'updated', name: '最近更新', field: 'updatedAt', order: 'desc'},
];

// Convex 部署地址（标准域名，非 api.clawhub.ai）
const CLAWHUB_BASE = 'https://wry-manatee-359.convex.cloud';
// 真实可用 RPC 方法名（其余猜测路径一律 500）
const CLAWHUB_RPC_PATH = 'search:searchSkills';
const CLAWHUB_PAGE_LIMIT = 100;

interface RawClawhub {
    _id?: string;
    id?: string;
    slug?: string;
    name?: string;
    title?: string;
    displayName?: string;
    description?: string;
    summary?: string;
    native?: {skill?: {summary?: string; categories?: string[]}; categories?: string[]};
    tags?: string[];
    score?: number;
    stars?: number;
    downloads?: number;
    iconUrl?: string;
    repoUrl?: string;
    repo?: string;
    author?: string;
    updatedAt?: string;
    createdAt?: string;
    categories?: string[];
}

export function mapEntry(raw: RawClawhub): PlatformSkillListItem {
    const id = raw.slug || raw.id || raw._id || raw.name || '';
    const desc = raw.summary || raw.native?.skill?.summary || raw.description || '';
    const cats: string[] = raw.native?.skill?.categories || raw.native?.categories || raw.categories || raw.tags || [];
    const repo = raw.repoUrl || raw.repo || `https://clawhub.ai/skills/${id}`;
    return {
        id,
        name: raw.displayName || raw.name || raw.title || id,
        description: desc,
        source: 'clawhub',
        sourceUrl: repo,
        downloadUrl: repo,
        stars: typeof raw.stars === 'number' ? raw.stars : undefined,
        updatedAt: raw.updatedAt || raw.createdAt,
        category: Array.isArray(cats) && cats.length > 0 ? cats[0] : undefined,
        extra: {
            iconUrl: raw.iconUrl,
            author: raw.author,
            downloads: raw.downloads,
            score: raw.score,
            categories: cats,
        },
    };
}

async function loadOffline(): Promise<RawClawhub[]> {
    try {
        const p = path.join(__dirname, 'clawhub', 'data', 'clawhub.json');
        if (fs.existsSync(p)) {
            const json = JSON.parse(fs.readFileSync(p, 'utf8'));
            return Array.isArray(json) ? json : json?.skills || [];
        }
    } catch {
        /* ignore */
    }
    return [];
}

/** Convex RPC 调用：POST /api/action，body 含 path/format/args。 */
async function convexQuery(
    base: string,
    body: Record<string, unknown>,
    timeoutMs = 15000
): Promise<{ok: boolean; json?: any; reason?: string}> {
    const controller = new AbortController();
    const t = setTimeout(() => (controller as any).abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/api/action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Convex-Client': 'npm-1.43.0',
                'Origin': 'https://clawhub.ai',
                'Referer': 'https://clawhub.ai/',
                'User-Agent': 'Mozilla/5.0',
            },
            body: JSON.stringify(body),
            signal: (controller as any).signal,
        });
        if (!res.ok) return {ok: false, reason: `HTTP ${res.status}`};
        const json = await res.json();
        // 响应结构：{ status:"success", value:[...] }，value 可能是 { skills:[...] }
        const value = json?.status === 'success' ? json.value : json;
        const arr: unknown[] = Array.isArray(value)
            ? value
            : (Array.isArray(value?.skills) ? value.skills : []);
        return {ok: true, json: arr};
    } catch (e) {
        const err = e as Error;
        return {ok: false, reason: err.name === 'AbortError' ? 'timeout' : err.message};
    } finally {
        clearTimeout(t);
    }
}

export const clawhubAdapter: PlatformAdapter = {
    id: 'clawhub',
    name: 'ClawHub',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        const {query, page, pageSize, baseUrl, category, sort} = params;
        const safePage = Math.max(1, page);
        // 单一真实 RPC 地址（不走 probeEndpoints，不依赖 baseUrl）
        const base = baseUrl ? baseUrl.replace(/\/+$/, '') : CLAWHUB_BASE;
        const started = Date.now();

        // query 永远非空（空串静默返回空数组）；分类浏览传默认 a
        const q = query && query.trim() ? query.trim() : 'a';
        // 全分类时省略 categorySlug（传空串恒返回 0 条）
        const args: Record<string, unknown> = {
            query: q,
            limit: Math.min(pageSize, CLAWHUB_PAGE_LIMIT),
            highlightedOnly: false,
        };
        if (category && category !== 'all') {
            args.categorySlug = category;
        }

        const attempts: any[] = [];
        const r = await convexQuery(base, {
            path: CLAWHUB_RPC_PATH,
            format: 'convex_encoded_json',
            args: [args],
        });
        attempts.push({
            url: `${base}/api/action`,
            ok: r.ok,
            durationMs: Date.now() - started,
            reason: r.ok ? undefined : r.reason,
            message: r.ok ? undefined : r.reason,
        });

        if (r.ok && Array.isArray(r.json)) {
            let items = r.json.map(mapEntry);
            // 客户端分类过滤（categorySlug 已带，兜底再筛一遍）
            if (category && category !== 'all') {
                items = items.filter(i => {
                    const cats = (i.extra as any)?.categories || [];
                    return cats.includes(category);
                });
            }
            // 客户端排序
            if (sort && sort !== 'relevance') {
                if (sort === 'downloads') {
                    items.sort((a, b) => ((b.extra as any)?.downloads || 0) - ((a.extra as any)?.downloads || 0));
                } else if (sort === 'updated') {
                    items.sort((a, b) => {
                        const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                        const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                        return db - da;
                    });
                } else if (sort === 'relevance') {
                    items.sort((a, b) => ((b.extra as any)?.score || 0) - ((a.extra as any)?.score || 0));
                }
            }
            // 在线 RPC 暂无游标分页：当本页装满（返回条数达到 limit）时推断还有下一页，
            // 允许翻第二页（否则比离线分支能力更弱，P1-18）。total 未知仍置 null。
            const limit = Math.min(pageSize, CLAWHUB_PAGE_LIMIT);
            const rawLen = r.json.length;
            const pageInfo = extractPageInfo({data: {}}, safePage, pageSize, items.length);
            pageInfo.total = null;
            pageInfo.totalPages = null;
            pageInfo.hasMore = rawLen >= limit;
            setDiagnostics('clawhub', {
                platform: 'clawhub',
                baseUrl,
                query,
                page: safePage,
                authorized: false,
                attempts,
                matchedUrl: `${base}/api/action`,
                totalDurationMs: Date.now() - started,
            });
            return {items, pageInfo, pagingMode: 'client', complete: false};
        }

        // 联网失败：回退离线索引
        const offline = await loadOffline();
        if (offline.length > 0) {
            const ql = q.toLowerCase();
            const filtered = ql === 'a'
                ? offline
                : offline.filter(
                      s =>
                          (s.name || '').toLowerCase().includes(ql) ||
                          (s.title || '').toLowerCase().includes(ql) ||
                          (s.description || '').toLowerCase().includes(ql)
                  );
            const start = (safePage - 1) * pageSize;
            const slice = filtered.slice(start, start + pageSize);
            setDiagnostics('clawhub', {
                platform: 'clawhub',
                baseUrl,
                query,
                page: safePage,
                authorized: false,
                attempts,
                matchedUrl: null,
                totalDurationMs: Date.now() - started,
                hint: '在线接口不可达，已回退内置离线索引。',
            });
            let offlineItems = slice.map(mapEntry);
                if (category && category !== 'all') {
                    offlineItems = offlineItems.filter(i => {
                        const cats = (i.extra as any)?.categories || [];
                        return cats.includes(category);
                    });
                }
                if (sort && sort !== 'relevance') {
                    if (sort === 'downloads') {
                        offlineItems.sort((a, b) => ((b.extra as any)?.downloads || 0) - ((a.extra as any)?.downloads || 0));
                    } else if (sort === 'updated') {
                        offlineItems.sort((a, b) => {
                            const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                            const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                            return db - da;
                        });
                    }
                }
                return {
                items: offlineItems,
                pageInfo: {
                    page: safePage,
                    pageSize,
                    total: filtered.length,
                    totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
                    hasMore: start + pageSize < filtered.length,
                },
                pagingMode: 'client',
                complete: true,
            };
        }

        setDiagnostics('clawhub', {
            platform: 'clawhub',
            baseUrl,
            query,
            page: safePage,
            authorized: false,
            attempts,
            matchedUrl: null,
            totalDurationMs: Date.now() - started,
            hint: buildHint('clawhub', attempts, safePage),
        });
        return {items: [], pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false}};
    },

    getFacets() {
        // 以文档 14 类为准；若离线索引存在，将其 tags 作为补充合并（避免分类过滤与列表结果不一致）
        try {
            const p = path.join(__dirname, 'clawhub', 'data', 'clawhub.json');
            if (fs.existsSync(p)) {
                const json = JSON.parse(fs.readFileSync(p, 'utf8'));
                const raw: RawClawhub[] = Array.isArray(json) ? json : json?.skills || [];
                const tagCount = new Map<string, number>();
                for (const r of raw) {
                    for (const t of r.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
                }
                if (tagCount.size > 0) {
                    const baseMap = new Map(CLAWHUB_CATEGORIES.map(c => [c.id, c]));
                    for (const [id, count] of tagCount) {
                        if (baseMap.has(id)) {
                            baseMap.get(id)!.count = (baseMap.get(id)!.count || 0) + count;
                        }
                    }
                    return {categories: [...baseMap.values()], sortOptions: CLAWHUB_SORTS, supportsSubcategories: false};
                }
            }
        } catch {
            /* ignore */
        }
        return {categories: CLAWHUB_CATEGORIES, sortOptions: CLAWHUB_SORTS, supportsSubcategories: false};
    },
};

