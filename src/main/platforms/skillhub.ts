/**
 * SkillHub 平台适配器。
 * 接口形态：公开分页 GET `https://api.skillhub.cn/api/skills`，无需凭证。
 * 支持 page/pageSize/sortBy=score/order=desc/keyword/category，
 * 响应 { code:0, data:{ skills:[...], total:N } }，服务端真分页无重复。
 */
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformSearchPage,
    PlatformSearchParams,
    PlatformSkillDownload,
    PlatformSkillDownloadParams,
    PlatformSkillListItem,
    SortOption,
} from './types';
import {SKILLHUB_DOWNLOAD_BASE} from '../../shared/platform-constants';
import {buildHint, extractPageInfo, probeEndpoints, setDiagnostics} from './shared';

const SKILLHUB_SEARCH_TPLS = [
    '/api/skills?page={page}&pageSize={size}&sortBy={sort}&order={order}&keyword={q}&category={category}',
];
const SKILLHUB_BASE = 'https://api.skillhub.cn';

/**
 * 纠正 skillhub 数据接口域名。默认 baseUrl 是站点 https://skillhub.cn（前端展示/打开链接用），
 * 若直接拿去探测 /api/skills 会命中 SPA 壳 → 误判"未提供公开列表接口"。skillhub 主域一律纠正到
 * API 子域 api.skillhub.cn；自建镜像/代理（非 skillhub.cn 主域）则保留用户配置。
 */
function resolveSkillhubBase(baseUrl?: string): string {
    if (!baseUrl) return SKILLHUB_BASE;
    try {
        if (new URL(baseUrl).hostname.endsWith('skillhub.cn')) return 'https://api.skillhub.cn';
        return baseUrl;
    } catch {
        return SKILLHUB_BASE;
    }
}

/** 前端 sort id → SkillHub sortBy 字段。 */
const SORT_MAP: Record<string, string> = {
    relevance: 'score',
    stars: 'stars',
    downloads: 'downloads',
    installs: 'installs',
    newest: 'updated_at',
    updated: 'updated_at',
};

/**
 * SkillHub 官方分类。来源权威端点 GET /api/v1/categories（2026-09-10 实测），
 * 接口分类为扁平单层（level 1，无子类），按 sortOrder 升序排列。
 * 注意：接口不接受 category={二级} 之类任意值，只有下列 key 合法，否则返回 400。
 */
const SKILLHUB_CATEGORIES: CategoryNode[] = [
    // 官方 nameEn 为 "Pay Skill"（付费技能分类），中文面板统一用中文名，与其它分类一致
    {id: 'pay-skill', name: '付费技能'},
    {id: 'office-efficiency', name: '办公效率'},
    {id: 'content-creation', name: '内容创作'},
    {id: 'dev-programming', name: '开发编程'},
    {id: 'data-analysis', name: '数据分析'},
    {id: 'design-media', name: '设计多媒体'},
    {id: 'ai-agent', name: 'AI Agent'},
    {id: 'knowledge-management', name: '知识管理'},
    {id: 'business-ops', name: '商业运营'},
    {id: 'education', name: '教育学习'},
    {id: 'professional', name: '行业专业'},
    {id: 'it-ops-security', name: 'IT 运维与安全'},
    {id: 'life-service', name: '生活服务'},
];

// 按文档 5 档对齐：score/stars/downloads/installs/updated_at
// 增补 installs 与 stars 两档，删除文档不存在的 name 档
const SKILLHUB_SORTS: SortOption[] = [
    {id: 'relevance', name: '相关度', field: 'score', order: 'desc'},
    {id: 'stars', name: '星标最多', field: 'stars', order: 'desc'},
    {id: 'downloads', name: '下载最多', field: 'downloads', order: 'desc'},
    {id: 'installs', name: '安装最多', field: 'installs', order: 'desc'},
    {id: 'updated', name: '最近更新', field: 'updated_at', order: 'desc'},
];

interface RawSkillhub {
    slug: string;
    name: string;
    title?: string;
    display_name?: string;
    description?: string;
    description_zh?: string;
    long_description?: string;
    long_description_zh?: string;
    category?: string;
    tags?: string[];
    stars?: number;
    downloads?: number;
    installs?: number;
    icon_url?: string;
    upstream_url?: string;
    labels?: Record<string, unknown>;
    author?: string | {name?: string; username?: string};
    created_at?: string;
    updatedAt?: string;
    repo?: string;
}

export function mapEntry(raw: RawSkillhub): PlatformSkillListItem {
    const desc = raw.description_zh || raw.description || raw.long_description_zh || raw.long_description || '';
    const id = raw.slug;
    const sourceUrl = raw.upstream_url || `https://skillhub.cn/skills/${raw.slug}`;
    // downloadUrl 对齐 D3 口径：upstream_url 是真 GitHub 仓库时保留（走 GitHub 解析通道），
    // 否则给站内 zip 直链——不再把详情页地址（SPA 壳，无源可取）当下载地址。
    const isGithubRepo = typeof raw.upstream_url === 'string' && /^https?:\/\/(?:www\.)?github\.com\//i.test(raw.upstream_url);
    const downloadUrl = isGithubRepo
        ? raw.upstream_url!
        : `${SKILLHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(id)}`;
    return {
        id,
        name: raw.display_name || raw.name || raw.title || raw.slug,
        description: desc,
        source: 'skillhub',
        sourceUrl,
        downloadUrl,
        stars: typeof raw.stars === 'number' ? raw.stars : undefined,
        updatedAt: raw.updatedAt || raw.created_at,
        category: raw.category || (Array.isArray(raw.tags) ? raw.tags[0] : undefined),
        // 中文分类显示名：与分类下拉（getFacets 的 SKILLHUB_CATEGORIES）保持一致，
        // 否则列表项分类 tag 会 fallback 到英文 slug（如 office-efficiency）。
        categoryName: SKILLHUB_CATEGORIES.find(c => c.id === (raw.category || ''))?.name,
        extra: {
            iconUrl: raw.icon_url,
            downloads: raw.downloads,
            installs: raw.installs,
            upstream_url: raw.upstream_url,
            author: typeof raw.author === 'object' ? raw.author?.name : raw.author,
            // 接口全局能力标记：labels.requires_api_key=true 表示该技能需要用户自备 API key
            requiresApiKey: raw.labels?.requires_api_key === true,
        },
    };
}

export const skillhubAdapter: PlatformAdapter = {
    id: 'skillhub',
    name: 'SkillHub',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        const {query, page, pageSize, category, sort, baseUrl} = params;
        const safePage = Math.max(1, page);
        const sortBy = (sort && SORT_MAP[sort]) || 'score';
        const order = sortBy === 'name' ? 'asc' : 'desc';
        const base = resolveSkillhubBase(baseUrl);
        // "全部/不选分类"=any → 不传 category：接口只接受合法分类 key，"all" 会 400 导致整个列表为空
        const normalizedCategory = category && category !== 'all' ? category : '';
        const started = Date.now();

        const probe = await probeEndpoints(
            'skillhub',
            base,
            SKILLHUB_SEARCH_TPLS,
            query,
            safePage,
            pageSize,
            normalizedCategory,
            sortBy,
            null,
            order
        );

        setDiagnostics('skillhub', {
            platform: 'skillhub',
            baseUrl: base,
            query,
            page: safePage,
            category,
            authorized: false,
            attempts: probe.attempts,
            matchedUrl: probe.matchedUrl,
            totalDurationMs: Date.now() - started,
            hint: probe.matchedUrl
                ? undefined
                : buildHint('skillhub', probe.attempts, safePage),
        });

        if (!probe.matchedUrl) {
            return {
                items: [],
                pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
                unsupported: probe.attempts.length > 0 && probe.attempts.every(a => a.reason === 'non-json'),
            };
        }

        const list: RawSkillhub[] = Array.isArray(probe.json?.data?.skills)
            ? probe.json.data.skills
            : probe.items as unknown as RawSkillhub[];
        const items = list.map(mapEntry);
        const total: number | null =
            typeof probe.json?.data?.total === 'number' ? probe.json.data.total : null;
        const pageInfo = extractPageInfo(probe.json, safePage, pageSize, items.length);
        return {
            items,
            pageInfo: total !== null ? {...pageInfo, total} : pageInfo,
            serverTotal: total ?? undefined,
            pagingMode: 'server',
            complete: true,
        };
    },

    /**
     * 取 SkillHub 技能的 zip 下载直链（匿名、无需凭证）。
     *
     * 实测契约：`https://api.skillhub.cn/api/v1/download?slug=<slug>` → 302 → COS 对象存储 zip
     * （200 / 504b0304，包内含 SKILL.md，plan-9.0 复核）。仅传 slug，带 namespace 参数会 404。
     * 下载端点只在 API 域名存在——实测站点域名 skillhub.cn 同路径返回 200 但是 HTML（SPA 壳），
     * 故固定用 SKILLHUB_DOWNLOAD_BASE，不拼用户 baseUrl。
     */
    async fetchSkillDownload({skillId}: PlatformSkillDownloadParams): Promise<PlatformSkillDownload> {
        const slug = (skillId || '').trim();
        if (!slug) {
            throw new Error('缺少技能 slug，无法生成 SkillHub 下载直链。');
        }
        return {downloadUrl: `${SKILLHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}`};
    },

    getFacets() {
        return {
            categories: SKILLHUB_CATEGORIES,
            sortOptions: SKILLHUB_SORTS,
            supportsSubcategories: false,
        };
    },
};