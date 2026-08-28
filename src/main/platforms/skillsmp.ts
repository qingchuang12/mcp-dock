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

const SKILLSMP_BASE = 'https://api.skillsmp.com'; // 实测 api.skillsmp.com 可用（skillsmp.ai 不可用）
const SEARCH_TPLS = [
    '/api/v1/skills/search?q={q}&page={page}&limit={size}&category={category}',
    '/api/v1/skills/search?q={q}&page={page}&limit={size}',
    '/api/v1/skills?q={q}&page={page}&page_size={size}',
];

// SkillsMP 叶子分类（实测 #14-#75，剔除组级 #1-#13 的 slug，共 62 项）
const SKILLSMP_CATEGORIES: CategoryNode[] = [
    {id: '#14', name: 'AI Agent'},
    {id: '#15', name: 'Business Ops'},
    {id: '#16', name: 'Content & Writing'},
    {id: '#17', name: 'Data & Engineering'},
    {id: '#18', name: 'Dev Tools'},
    {id: '#19', name: 'Design & Media'},
    {id: '#20', name: 'Finance'},
    {id: '#21', name: 'Knowledge & Search'},
    {id: '#22', name: 'Productivity'},
    {id: '#23', name: 'Research'},
    {id: '#24', name: 'Automation'},
    {id: '#25', name: 'Marketing'},
    {id: '#26', name: 'Sales'},
    {id: '#27', name: 'HR'},
    {id: '#28', name: 'Legal'},
    {id: '#29', name: 'Education'},
    {id: '#30', name: 'Healthcare'},
    {id: '#31', name: 'Customer Support'},
    {id: '#32', name: 'Social Media'},
    {id: '#33', name: 'Translation'},
    {id: '#34', name: 'Image Generation'},
    {id: '#35', name: 'Video'},
    {id: '#36', name: 'Audio'},
    {id: '#37', name: 'Code Review'},
    {id: '#38', name: 'Testing'},
    {id: '#39', name: 'DevOps'},
    {id: '#40', name: 'Security'},
    {id: '#41', name: 'Database'},
    {id: '#42', name: 'Cloud'},
    {id: '#43', name: 'API'},
    {id: '#44', name: 'Web Scraping'},
    {id: '#45', name: 'Browser Automation'},
    {id: '#46', name: 'Document'},
    {id: '#47', name: 'Spreadsheet'},
    {id: '#48', name: 'Presentation'},
    {id: '#49', name: 'Email'},
    {id: '#50', name: 'Calendar'},
    {id: '#51', name: 'Note'},
    {id: '#52', name: 'Task'},
    {id: '#53', name: 'Workflow'},
    {id: '#54', name: 'Integration'},
    {id: '#55', name: 'Chatbot'},
    {id: '#56', name: 'Voice Assistant'},
    {id: '#57', name: 'Recommendation'},
    {id: '#58', name: 'Analytics'},
    {id: '#59', name: 'Monitoring'},
    {id: '#60', name: 'Logging'},
    {id: '#61', name: 'Deployment'},
    {id: '#62', name: 'CI/CD'},
    {id: '#63', name: 'Container'},
    {id: '#64', name: 'Kubernetes'},
    {id: '#65', name: 'Serverless'},
    {id: '#66', name: 'IoT'},
    {id: '#67', name: 'Blockchain'},
    {id: '#68', name: 'Game'},
    {id: '#69', name: 'Music'},
    {id: '#70', name: 'Art'},
    {id: '#71', name: 'Fashion'},
    {id: '#72', name: 'Travel'},
    {id: '#73', name: 'Food'},
    {id: '#74', name: 'Sports'},
    {id: '#75', name: 'Other'},
];

// 语言过滤（doc 第3节：language 维度）
const SKILLSMP_LANGUAGES = ['Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'C++', 'Shell'];

const SKILLSMP_SORTS: SortOption[] = [
    {id: 'relevance', name: '相关度', field: 'relevance', order: 'desc'},
    {id: 'stars', name: '星标最多', field: 'stars', order: 'desc'},
    {id: 'updated', name: '最近更新', field: 'recent', order: 'desc'},
];

const SKILLSMP_PAGE_LIMIT = 50; // API 上限 50，超限返回 400

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

export function mapEntry(raw: RawSkillsmp, category?: string): PlatformSkillListItem {
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
        // 单条结果无分类字段，用请求时的 category 回填
        category: raw.category || category,
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

        // q 必填：空串或纯符号（如 *）会触发 400 INVALID_QUERY，兜底为含字母数字的默认词
        const isSymbolOnly = !query || !/[a-zA-Z0-9\u4e00-\u9fa5]/.test(query);
        const q = isSymbolOnly ? 'skill' : query.trim();

        // sortBy 映射：前端 stars → stars，updated → recent；空 sort 省略参数避免非法值回退
        const sortBy = (sort === 'stars' || sort === 'updated') ? (sort === 'updated' ? 'recent' : sort) : '';

        // limit 钳制到 API 上限 50
        const limit = Math.min(pageSize, SKILLSMP_PAGE_LIMIT);

        const probe = await probeEndpoints(
            'skillsmp',
            base,
            SEARCH_TPLS,
            q,
            safePage,
            limit,
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
                : buildHint('skillsmp', probe.attempts, safePage),
        });

        if (!probe.matchedUrl) {
            return {
                items: [],
                pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
                unsupported: probe.attempts.length > 0 && probe.attempts.every(a => a.reason === 'non-json'),
            };
        }

        const items = probe.items.map(r => mapEntry(r as RawSkillsmp, category));
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