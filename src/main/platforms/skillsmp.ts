/**
 * SkillsMP 平台适配器。
 * 接口形态：GET https://skillsmp.com/api/v1/skills?q=... 等，q 为必填，存在限流。
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

const SKILLSMP_BASE = 'https://skillsmp.com';
const SEARCH_TPLS = [
    '/api/v1/skills/search?q={q}&page={page}&limit={size}&sortBy={sort}&category={category}',
    '/api/v1/skills?q={q}&page={page}&page_size={size}',
    '/api/skills?q={q}&page={page}&page_size={size}',
];

// SkillsMP 分类（doc 第2节记录的叶子分类，扁平为一级；实际 62 类，此处收录代表项）
const SKILLSMP_CATEGORIES: CategoryNode[] = [
    {id: 'development', name: '开发工具'},
    {id: 'code-generation', name: '代码生成'},
    {id: 'code-review', name: '代码审查'},
    {id: 'debugging', name: '调试排错'},
    {id: 'data-science', name: '数据科学'},
    {id: 'data-analysis', name: '数据分析'},
    {id: 'ml', name: '机器学习'},
    {id: 'search', name: '搜索检索'},
    {id: 'rag', name: 'RAG 检索'},
    {id: 'web-search', name: '网络搜索'},
    {id: 'productivity', name: '效率办公'},
    {id: 'writing', name: '写作内容'},
    {id: 'translation', name: '翻译'},
    {id: 'design', name: '设计创意'},
    {id: 'image-gen', name: '图像生成'},
    {id: 'cloud', name: '云与运维'},
    {id: 'devops', name: 'DevOps'},
    {id: 'database', name: '数据库'},
    {id: 'finance', name: '金融财务'},
    {id: 'education', name: '教育学习'},
    {id: 'health', name: '健康医疗'},
    {id: 'social', name: '社交沟通'},
    {id: 'other', name: '其他'},
];

// 语言过滤（doc 第3节：language 维度）
const SKILLSMP_LANGUAGES = ['Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'C++', 'Shell'];

const SKILLSMP_SORTS: SortOption[] = [
    {id: 'relevance', name: '相关度', field: 'relevance', order: 'desc'},
    {id: 'stars', name: '星标最多', field: 'stars', order: 'desc'},
    {id: 'updated', name: '最近更新', field: 'recent', order: 'desc'},
];

interface RawSkillsmp {
    id?: string;
    uuid?: string;
    name?: string;
    title?: string;
    description?: string;
    summary?: string;
    tags?: string[];
    category?: string;
    stars?: number;
    downloads?: number;
    iconUrl?: string;
    repoUrl?: string;
    repo?: string;
    author?: string;
    updatedAt?: string;
}

function mapEntry(raw: RawSkillsmp): PlatformSkillListItem {
    const id = raw.id || raw.uuid || raw.name || '';
    const desc = raw.summary || raw.description || '';
    const repo = raw.repoUrl || raw.repo || `https://skillsmp.com/skills/${id}`;
    return {
        id,
        name: raw.name || raw.title || id,
        description: desc,
        source: 'skillsmp',
        sourceUrl: repo,
        downloadUrl: repo,
        stars: typeof raw.stars === 'number' ? raw.stars : undefined,
        updatedAt: raw.updatedAt,
        category: raw.category || (Array.isArray(raw.tags) ? raw.tags[0] : undefined),
        extra: {iconUrl: raw.iconUrl, author: raw.author, downloads: raw.downloads},
    };
}

export const skillsmpAdapter: PlatformAdapter = {
    id: 'skillsmp',
    name: 'SkillsMP',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        const {query, page, pageSize, baseUrl, category, sort} = params;
        const safePage = Math.max(1, page);
        const base = baseUrl || SKILLSMP_BASE;
        const started = Date.now();

        // sortBy 映射：前端 stars → stars，updated → recent
        const sortBy = (sort === 'stars' || sort === 'updated') ? (sort === 'updated' ? 'recent' : sort) : '';

        const probe = await probeEndpoints(
            'skillsmp',
            base,
            SEARCH_TPLS,
            query,
            safePage,
            pageSize,
            category || '',
            sortBy
        );

        setDiagnostics('skillsmp', {
            platform: 'skillsmp',
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
                : buildHint('skillsmp', 'SkillsMP', probe.attempts, safePage),
        });

        if (!probe.matchedUrl) {
            return {
                items: [],
                pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
                unsupported: probe.attempts.length > 0 && probe.attempts.every(a => a.reason === 'non-json'),
            };
        }

        const items = probe.items.map(mapEntry);
        const pageInfo = extractPageInfo(probe.json, safePage, pageSize, items.length);
        return {items, pageInfo, pagingMode: 'client', complete: false};
    },

    getFacets() {
        return {
            categories: SKILLSMP_CATEGORIES,
            sortOptions: SKILLSMP_SORTS,
            tags: SKILLSMP_LANGUAGES,
            supportsSubcategories: false,
        };
    },
};