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
    PlatformSkillListItem,
    SortOption,
} from './types';
import {buildHint, extractPageInfo, probeEndpoints, setDiagnostics} from './shared';

const SKILLHUB_SEARCH_TPLS = [
    '/api/skills?page={page}&pageSize={size}&sortBy={sort}&order={order}&keyword={q}&category={category}',
];
const SKILLHUB_BASE = 'https://api.skillhub.cn';

/** 前端 sort id → SkillHub sortBy 字段。 */
const SORT_MAP: Record<string, string> = {
    relevance: 'score',
    stars: 'stars',
    downloads: 'downloads',
    installs: 'installs',
    newest: 'updated_at',
    updated: 'updated_at',
};

/** SkillHub 12 大类 + 子类（来自 doc 对接文档）。 */
const SKILLHUB_CATEGORIES: CategoryNode[] = [
    {
        id: 'development',
        name: '开发工具',
        children: [
            {id: 'dev-coding', name: '代码生成'},
            {id: 'dev-review', name: '代码审查'},
            {id: 'dev-debug', name: '调试排错'},
            {id: 'dev-doc', name: '文档生成'},
        ],
    },
    {
        id: 'data',
        name: '数据科学',
        children: [
            {id: 'data-analysis', name: '数据分析'},
            {id: 'data-viz', name: '数据可视化'},
            {id: 'data-etl', name: '数据管道'},
        ],
    },
    {
        id: 'search',
        name: '搜索检索',
        children: [
            {id: 'search-web', name: '网络搜索'},
            {id: 'search-vector', name: '向量检索'},
            {id: 'search-rag', name: 'RAG 检索'},
        ],
    },
    {
        id: 'productivity',
        name: '效率办公',
        children: [
            {id: 'prod-email', name: '邮件处理'},
            {id: 'prod-calendar', name: '日程管理'},
            {id: 'prod-note', name: '笔记整理'},
        ],
    },
    {
        id: 'design',
        name: '设计创意',
        children: [
            {id: 'design-ui', name: 'UI 设计'},
            {id: 'design-image', name: '图像生成'},
            {id: 'design-video', name: '视频处理'},
        ],
    },
    {
        id: 'cloud',
        name: '云与运维',
        children: [
            {id: 'cloud-deploy', name: '部署运维'},
            {id: 'cloud-monitor', name: '监控告警'},
            {id: 'cloud-iac', name: '基础设施'},
        ],
    },
    {
        id: 'writing',
        name: '写作内容',
        children: [
            {id: 'write-article', name: '文章写作'},
            {id: 'write-translate', name: '翻译'},
            {id: 'write-summary', name: '摘要总结'},
        ],
    },
    {
        id: 'education',
        name: '教育学习',
        children: [
            {id: 'edu-tutor', name: '辅导答疑'},
            {id: 'edu-quiz', name: '测验生成'},
        ],
    },
    {
        id: 'finance',
        name: '金融财务',
        children: [
            {id: 'fin-report', name: '财报分析'},
            {id: 'fin-trade', name: '交易辅助'},
        ],
    },
    {
        id: 'health',
        name: '健康医疗',
        children: [
            {id: 'health-fit', name: '健身计划'},
            {id: 'health-med', name: '医疗问答'},
        ],
    },
    {
        id: 'social',
        name: '社交沟通',
        children: [
            {id: 'social-chat', name: '对话助手'},
            {id: 'social-community', name: '社群运营'},
        ],
    },
    {id: 'other', name: '其他', children: [{id: 'other-misc', name: '未分类'}]},
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
    author?: string | {name?: string; username?: string};
    created_at?: string;
    updatedAt?: string;
    repo?: string;
}

export function mapEntry(raw: RawSkillhub): PlatformSkillListItem {
    const desc = raw.description_zh || raw.description || raw.long_description_zh || raw.long_description || '';
    const id = raw.slug;
    const sourceUrl = raw.upstream_url || `https://skillhub.cn/skills/${raw.slug}`;
    return {
        id,
        name: raw.display_name || raw.name || raw.title || raw.slug,
        description: desc,
        source: 'skillhub',
        sourceUrl,
        downloadUrl: sourceUrl,
        stars: typeof raw.stars === 'number' ? raw.stars : undefined,
        updatedAt: raw.updatedAt || raw.created_at,
        category: raw.category || (Array.isArray(raw.tags) ? raw.tags[0] : undefined),
        extra: {
            iconUrl: raw.icon_url,
            downloads: raw.downloads,
            installs: raw.installs,
            upstream_url: raw.upstream_url,
            author: typeof raw.author === 'object' ? raw.author?.name : raw.author,
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
        const base = baseUrl || SKILLHUB_BASE;
        const started = Date.now();

        const probe = await probeEndpoints(
            'skillhub',
            base,
            SKILLHUB_SEARCH_TPLS,
            query,
            safePage,
            pageSize,
            category || '',
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

    getFacets() {
        return {
            categories: SKILLHUB_CATEGORIES,
            sortOptions: SKILLHUB_SORTS,
            supportsSubcategories: true,
        };
    },
};