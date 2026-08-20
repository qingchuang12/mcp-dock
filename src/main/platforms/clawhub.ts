/**
 * ClawHub 平台适配器。
 * 接口形态：Convex RPC，POST https://api.clawhub.ai/api/mutation/listSkills 等端点。
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

const CLAWHUB_CATEGORIES: CategoryNode[] = [
    {id: 'devtools', name: '开发工具'},
    {id: 'coding', name: '代码助手'},
    {id: 'data', name: '数据处理'},
    {id: 'search', name: '搜索检索'},
    {id: 'productivity', name: '效率办公'},
    {id: 'writing', name: '写作内容'},
    {id: 'design', name: '设计创意'},
    {id: 'cloud', name: '云与运维'},
    {id: 'other', name: '其他'},
];

const CLAWHUB_SORTS: SortOption[] = [
    {id: 'relevance', name: '相关度', field: 'relevance', order: 'desc'},
    {id: 'stars', name: '星标最多', field: 'stars', order: 'desc'},
    {id: 'downloads', name: '下载最多', field: 'downloads', order: 'desc'},
    {id: 'newest', name: '最新', field: 'createdAt', order: 'desc'},
];

const CLAWHUB_DEPLOY = 'api.clawhub.ai';
const CLAWHUB_BASE = 'https://api.clawhub.ai';

interface RawClawhub {
    _id?: string;
    skillId?: string;
    name?: string;
    title?: string;
    description?: string;
    summary?: string;
    tags?: string[];
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

function mapEntry(raw: RawClawhub): PlatformSkillListItem {
    const id = raw.skillId || raw._id || raw.name || '';
    const desc = raw.summary || raw.description || '';
    const repo = raw.repoUrl || raw.repo || `https://clawhub.ai/skills/${id}`;
    return {
        id,
        name: raw.name || raw.title || id,
        description: desc,
        source: 'clawhub',
        sourceUrl: repo,
        downloadUrl: repo,
        stars: typeof raw.stars === 'number' ? raw.stars : undefined,
        updatedAt: raw.updatedAt || raw.createdAt,
        category: Array.isArray(raw.tags) ? raw.tags[0] : Array.isArray(raw.categories) ? raw.categories[0] : undefined,
        extra: {iconUrl: raw.iconUrl, author: raw.author, downloads: raw.downloads},
    };
}

async function loadOffline(): Promise<RawClawhub[]> {
    try {
        const p = path.join(__dirname, '..', 'platforms', 'clawhub', 'data', 'clawhub.json');
        if (fs.existsSync(p)) {
            const json = JSON.parse(fs.readFileSync(p, 'utf8'));
            return Array.isArray(json) ? json : json?.skills || [];
        }
    } catch {
        /* ignore */
    }
    return [];
}

async function convexQuery(
    url: string,
    body: Record<string, unknown>,
    timeoutMs = 15000
): Promise<{ok: boolean; json?: any; reason?: string}> {
    const controller = new AbortController();
    const t = setTimeout(() => (controller as any).abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'},
            body: JSON.stringify(body),
            signal: (controller as any).signal,
        });
        if (!res.ok) return {ok: false, reason: `HTTP ${res.status}`};
        const json = await res.json();
        return {ok: true, json};
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
        const {query, page, pageSize, baseUrl} = params;
        const safePage = Math.max(1, page);
        const deploy = baseUrl ? baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : CLAWHUB_DEPLOY;
        const base = `https://${deploy}`;
        const started = Date.now();

        // ClawHub 的 Convex 列表端点（query/mutation 命名依部署而异）
        const endpoints = [
            `${base}/api/query/listSkills`,
            `${base}/api/mutation/listSkills`,
            `${base}/api/query/searchSkills`,
            `${base}/api/query/getSkills`,
        ];

        const attempts: any[] = [];
        for (const ep of endpoints) {
            const r = await convexQuery(ep, {
                query: query || '',
                page: safePage,
                limit: pageSize,
            });
            attempts.push({
                url: ep,
                ok: r.ok,
                durationMs: Date.now() - started,
                reason: r.ok ? undefined : r.reason,
                message: r.ok ? undefined : r.reason,
            });
            if (r.ok && Array.isArray(r.json)) {
                const items = r.json.map(mapEntry);
                const pageInfo = extractPageInfo({data: {total: null}}, safePage, pageSize, items.length);
                setDiagnostics('clawhub', {
                    platform: 'clawhub',
                    baseUrl,
                    query,
                    page: safePage,
                    authorized: false,
                    attempts,
                    matchedUrl: ep,
                    totalDurationMs: Date.now() - started,
                });
                return {items, pageInfo, pagingMode: 'client', complete: false};
            }
        }

        // 联网全部失败：回退离线索引
        const offline = await loadOffline();
        if (offline.length > 0) {
            const q = query.trim().toLowerCase();
            const filtered = q
                ? offline.filter(
                      s =>
                          (s.name || '').toLowerCase().includes(q) ||
                          (s.title || '').toLowerCase().includes(q) ||
                          (s.description || '').toLowerCase().includes(q)
                  )
                : offline;
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
            return {
                items: slice.map(mapEntry),
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
            hint: buildHint('clawhub', 'ClawHub', attempts, safePage),
        });
        return {items: [], pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false}};
    },

    getFacets() {
        // 若离线索引存在，聚合其 tags 作为分类；否则用默认分类
        try {
            const p = path.join(__dirname, '..', 'platforms', 'clawhub', 'data', 'clawhub.json');
            if (fs.existsSync(p)) {
                const json = JSON.parse(fs.readFileSync(p, 'utf8'));
                const raw: RawClawhub[] = Array.isArray(json) ? json : json?.skills || [];
                const tagCount = new Map<string, number>();
                for (const r of raw) {
                    for (const t of r.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
                }
                if (tagCount.size > 0) {
                    const cats: CategoryNode[] = [...tagCount.entries()].map(([id, count]) => ({
                        id,
                        name: id,
                        count,
                    }));
                    return {categories: cats, sortOptions: CLAWHUB_SORTS, supportsSubcategories: false};
                }
            }
        } catch {
            /* ignore */
        }
        return {categories: CLAWHUB_CATEGORIES, sortOptions: CLAWHUB_SORTS, supportsSubcategories: false};
    },
};
