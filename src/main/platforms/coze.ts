/**
 * 虾评（Coze）Skill 平台适配器。
 * 接口形态：公开分页 GET `https://xiaping.coze.com/api/skills`，无需凭证（列表浏览）。
 * 支持 page/limit（1-based 服务端真分页，响应含 total/hasMore）、search、category、sort。
 *
 * 安装：已实现。列表匿名可读，但下载需 `Authorization: Bearer {api_key}`
 * （见 fetchSkillDownload）；key 由用户在「编辑源 → 绑定 Token」处自行填写，
 * 本适配器不代用户注册（注册属创建外部账号 + 消耗 IP 配额）。
 *
 * 2026-09-10 实测约束：
 * - 分类仅官方 8 个中文名（GET /api/categories），其余值返回空/非法；
 * - sort 仅 avg_stars / downloads / comment_count 合法，stars/rating/latest/hot/featured/newest 等均 500；
 * - avg_stars 为千分制评分（490 = 4.90 分）。
 */
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformFacets,
    PlatformSearchPage,
    PlatformSearchParams,
    PlatformSkillDownload,
    PlatformSkillDownloadParams,
    PlatformSkillListItem,
    SortOption,
} from './types';
import {UA} from './shared';

const COZE_BASE = 'https://xiaping.coze.com';

/** 虾评对接指南（注册 / 下载 / 排错），多处错误提示与 UI 文案指向它。 */
const COZE_SKILL_MD_URL = 'https://xiaping.coze.com/skill.md';

/** 官方分类（内嵌避免每会话请求 /api/categories；分类 id 本就是中文名）。 */
const COZE_CATEGORIES: CategoryNode[] = [
    {id: '效率工具', name: '效率工具'},
    {id: '社交互动', name: '社交互动'},
    {id: '学习教育', name: '学习教育'},
    {id: '创意设计', name: '创意设计'},
    {id: '数据分析', name: '数据分析'},
    {id: '娱乐休闲', name: '娱乐休闲'},
    {id: '生活实用', name: '生活实用'},
    {id: '其他', name: '其他'},
];

/** sort option 的 id 直接等同接口 sort 值。 */
const COZE_SORTS: SortOption[] = [
    {id: 'avg_stars', name: '评分最高', field: 'avg_stars', order: 'desc'},
    {id: 'downloads', name: '下载最多', field: 'downloads', order: 'desc'},
    {id: 'comment_count', name: '讨论最多', field: 'comment_count', order: 'desc'},
];

interface RawCozeSkill {
    id?: string;
    name?: string;
    description?: string;
    category?: string[];
    tags?: string[];
    owner_name?: string;
    current_version?: string;
    downloads?: number;
    avg_stars?: number;
    star_count?: number;
    comment_count?: number;
    requires_api_key?: boolean | null;
    security_status?: string;
    created_at?: string;
    updated_at?: string;
}

interface RawCozePage {
    skills?: RawCozeSkill[];
    total?: number;
    hasMore?: boolean;
}

/**
 * 下载接口响应。成功体 `{success, data:{download_url, version, coins_spent}}` 依据官方 skill.md，
 * 未实测（缺真实 key），故全部字段可选并做防御式解析。
 */
interface CozeDownloadResponse {
    success?: boolean;
    error?: string;
    data?: { download_url?: string; version?: string; coins_spent?: number };
}

export function mapCozeSkill(raw: RawCozeSkill): PlatformSkillListItem {
    // 站点技能可打多个分类标签，去空/去重后全量透传，卡片据此显示完整分类（而非仅第一个）
    const categoriesRaw = Array.isArray(raw.category) ? raw.category.map(c => (typeof c === 'string' ? c.trim() : '')).filter(Boolean) : [];
    const categories = [...new Set(categoriesRaw)];
    const category = categories[0];
    return {
        id: raw.id || raw.name || 'coze-unknown',
        name: raw.name || '',
        description: raw.description || '',
        source: 'coze',
        // 站点为 SPA 无稳定单一详情直链，列表浏览以站点根为打开地址
        sourceUrl: COZE_BASE,
        downloads: typeof raw.downloads === 'number' ? raw.downloads : undefined,
        // avg_stars 为千分制评分（490=4.90），保持平台原生量纲
        stars: typeof raw.avg_stars === 'number' ? raw.avg_stars : undefined,
        category,
        // 分类 id 本就是中文名，直接同值，卡片 tag 显示中文与分类下拉一致
        categoryName: category,
        updatedAt: raw.updated_at,
        extra: {
            author: raw.owner_name,
            version: raw.current_version,
            commentCount: raw.comment_count,
            securityStatus: raw.security_status,
            requiresApiKey: raw.requires_api_key === true,
            categories,
        },
    };
}

export const cozeAdapter: PlatformAdapter = {
    id: 'coze',
    name: '虾评 Coze',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        const {query, page, pageSize, category, sort, baseUrl} = params;
        const safePage = Math.max(1, page);
        const base = baseUrl || COZE_BASE;

        const qs = new URLSearchParams();
        qs.set('page', String(safePage));
        qs.set('limit', String(pageSize));
        if (query) qs.set('search', query);
        if (category && category !== 'all') qs.set('category', category);
        if (sort && sort !== 'relevance') qs.set('sort', sort);

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await fetch(`${base}/api/skills?${qs.toString()}`, {
                headers: {'User-Agent': UA, Accept: 'application/json'},
                signal: controller.signal,
            });
            if (!res.ok) {
                return {
                    items: [],
                    pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
                    message: `请求失败(HTTP ${res.status})`,
                };
            }
            const json = (await res.json()) as RawCozePage;
            const items = (json.skills ?? []).map(mapCozeSkill);
            const total = typeof json.total === 'number' ? json.total : null;
            return {
                items,
                serverTotal: total ?? undefined,
                pageInfo: {
                    page: safePage,
                    pageSize,
                    total,
                    totalPages: total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null,
                    hasMore: json.hasMore === true,
                },
                pagingMode: 'server',
            };
        } catch {
            return {
                items: [],
                pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
            };
        } finally {
            clearTimeout(t);
        }
    },

    /**
     * 取虾评 Skill 的 zip 下载直链。
     *
     * 实测（2026-09-10）：未携带 / 携带无效 key 均返回 401，错误体指向 COZE_SKILL_MD_URL。
     * 成功响应 `{success, data:{download_url, version, coins_spent}}` 依据官方 skill.md，**未实测**
     * （缺少真实 key），故做防御式解析，不假定结构。
     *
     * 注意：正式版技能下载会扣 2 虾米（重试不重复扣），因此失败不自动重试，
     * 由用户确认后再次触发。
     */
    async fetchSkillDownload({baseUrl, skillId, secret}: PlatformSkillDownloadParams): Promise<PlatformSkillDownload> {
        if (!secret) {
            throw new Error(
                `虾评下载需要 API Key：请在「编辑源」的「绑定 Token」处填入，获取方式见 ${COZE_SKILL_MD_URL}`
            );
        }

        const base = baseUrl || COZE_BASE;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch(`${base}/api/skills/${encodeURIComponent(skillId)}/download`, {
                headers: {
                    'User-Agent': UA,
                    Accept: 'application/json',
                    Authorization: `Bearer ${secret}`,
                },
                signal: controller.signal,
            });

            // 平台在鉴权失败时也会返回 JSON 错误体，尽量透出原始原因（key 无效 / 未注册）
            const raw = await res.text();
            let json: CozeDownloadResponse | null = null;
            try {
                json = JSON.parse(raw) as CozeDownloadResponse;
            } catch {
                json = null;
            }

            if (!res.ok || !json?.success) {
                const reason = json?.error || raw.slice(0, 200) || `HTTP ${res.status}`;
                throw new Error(`获取虾评下载链接失败：${reason}`);
            }

            const downloadUrl = json.data?.download_url;
            if (!downloadUrl) {
                throw new Error('虾评未返回下载链接（响应缺少 download_url）。');
            }
            return {
                downloadUrl,
                version: json.data?.version,
                coinsSpent: json.data?.coins_spent,
            };
        } finally {
            clearTimeout(timer);
        }
    },

    getFacets(_resourceType?: 'mcp' | 'skills'): PlatformFacets {
        return {categories: COZE_CATEGORIES, sortOptions: COZE_SORTS, supportsSubcategories: false};
    },
};