/**
 * ModelScope 平台适配器。
 * Skill 接口形态：GET /openapi/v1/skills，服务端过滤/排序缺失，靠客户端本地做。
 * MCP 接口形态：PUT /openapi/v1/mcp/servers，支持 search/category/is_hosted 过滤。
 * 两类资源走不同端点，各自独立实现。
 */
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformSearchPage,
    PlatformSearchParams,
    PlatformServerDetail,
    PlatformServerListItem,
    PlatformServerSearchPage,
    PlatformSkillListItem,
    SortOption,
} from './types';
import {buildHint, extractPageInfo, probeEndpoints, setDiagnostics,} from './shared';

const MS_BASE = 'https://modelscope.cn';

// Skill 搜索端点（doc：GET /openapi/v1/skills?name=&page_number=&page_size=）
const MS_SKILL_TPLS = [
    '/openapi/v1/skills?name={q}&page_number={page}&page_size={size}',
];

// MCP server 搜索端点（doc：PUT /openapi/v1/mcp/servers）
const MS_SERVER_TPLS = [
    '/openapi/v1/mcp/servers?search={q}&page_number={page}&page_size={size}',
];

// ModelScope 分类（doc 第2节：9 类）
const MS_CATEGORIES: CategoryNode[] = [
    {id: 'cv', name: '计算机视觉'},
    {id: 'nlp', name: '自然语言处理'},
    {id: 'audio', name: '语音/音频'},
    {id: 'multimodal', name: '多模态'},
    {id: 'science', name: '科学计算'},
    {id: 'rl', name: '强化学习'},
    {id: 'cag', name: '智能体（Agent）'},
    {id: 'other', name: '其他'},
];

// ModelScope 排序（API 不支持，纯客户端排序）
const MS_SORTS: SortOption[] = [
    {id: 'relevance', name: '相关度', field: 'relevance', order: 'desc'},
    {id: 'stars', name: '星标最多', field: 'stars', order: 'desc'},
    {id: 'updated', name: '最近更新', field: 'updatedAt', order: 'desc'},
];

// Skill 详情端点（仓库 README 探测）

interface RawMS {
    Name?: string;
    Id?: string;
    Path?: string;
    RepoId?: string;
    Repository?: string;
    Author?: {Name?: string; Username?: string} | string;
    Description?: string;
    Summary?: string;
    Tags?: string[];
    Downloads?: number;
    Stars?: number;
    CreatedAt?: string;
    UpdatedAt?: string;
    License?: string;
    CoverUrl?: string;
    Icon?: string;
}

function extractId(raw: RawMS): string {
    return raw.Id || raw.Path || raw.RepoId || raw.Repository || raw.Name || '';
}

function mapSkill(raw: RawMS, base: string): PlatformSkillListItem {
    const id = extractId(raw);
    const author = typeof raw.Author === 'object' ? raw.Author?.Name || raw.Author?.Username : raw.Author;
    const repoUrl = `https://modelscope.cn/${id}`;
    const isSkill = /skill/i.test(raw.Tags?.join(',') || '') || /skill/i.test(id);
    return {
        id,
        name: raw.Name || id,
        description: raw.Description || raw.Summary || '',
        source: 'modelscope',
        sourceUrl: repoUrl,
        downloadUrl: repoUrl,
        stars: raw.Stars,
        updatedAt: raw.UpdatedAt,
        category: Array.isArray(raw.Tags) ? raw.Tags[0] : undefined,
        extra: {
            author,
            downloads: raw.Downloads,
            coverUrl: raw.CoverUrl || raw.Icon,
            repoUrl,
            isSkill,
            base,
        },
    };
}

function mapServer(raw: RawMS): PlatformServerListItem {
    const id = extractId(raw);
    const author = typeof raw.Author === 'object' ? raw.Author?.Name || raw.Author?.Username : raw.Author;
    const repoUrl = `https://modelscope.cn/${id}`;
    return {
        id,
        name: raw.Name || id,
        displayName: raw.Name || id,
        description: raw.Description || raw.Summary || '',
        iconUrl: raw.CoverUrl || raw.Icon,
        categories: raw.Tags || [],
        stars: raw.Stars,
        sourceUrl: repoUrl,
        author: author as string | undefined,
        publisher: author as string | undefined,
        isHosted: false,
        isVerified: false,
        tags: raw.Tags || [],
        source: 'modelscope',
        extra: {downloads: raw.Downloads, license: raw.License, repoUrl},
    };
}

/** 核心搜索（skill 与 server 复用同一列表端点，服务端过滤缺失，靠客户端切片分页）。 */
async function msSearchImpl(params: PlatformSearchParams): Promise<PlatformSearchPage> {
    const {query, page, pageSize, baseUrl, category, sort} = params;
    const safePage = Math.max(1, page);
    const base = baseUrl || MS_BASE;
    const started = Date.now();

    const probe = await probeEndpoints(
        'modelscope',
        base,
        MS_SKILL_TPLS,
        query,
        safePage,
        pageSize,
        category || ''
    );

    setDiagnostics('modelscope', {
        platform: 'modelscope',
        baseUrl: base,
        query,
        page: safePage,
        authorized: false,
        attempts: probe.attempts,
        matchedUrl: probe.matchedUrl,
        totalDurationMs: Date.now() - started,
        hint: probe.matchedUrl
            ? undefined
            : buildHint('modelscope', 'ModelScope', probe.attempts, safePage),
    });

    if (!probe.matchedUrl) {
        return {
            items: [],
            pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
            unsupported: probe.attempts.length > 0 && probe.attempts.every(a => a.reason === 'non-json'),
        };
    }

    let items = probe.items.map(r => mapSkill(r as RawMS, base));

    // 客户端分类过滤（API 不支持服务端过滤）
    if (category && category !== 'all') {
        items = items.filter(
            i => (i.category && i.category === category) || (i.extra?.tags as string[] | undefined)?.includes(category)
        );
    }
    // 客户端排序（API 不支持服务端排序）
    if (sort && sort !== 'relevance') {
        if (sort === 'stars') {
            items.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        } else if (sort === 'updated') {
            items.sort((a, b) => {
                const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                return db - da;
            });
        }
    }

    const pageInfo = extractPageInfo(probe.json, safePage, pageSize, items.length);
    return {items, pageInfo, pagingMode: 'client', complete: false};
}

/** MCP server 搜索（独立端点，与 skill 列表不共用）。直接映射为 PlatformServerListItem 避免双重转换丢失字段。 */
async function msServerSearchImpl(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
    const {query, page, pageSize, baseUrl, category, sort} = params;
    const safePage = Math.max(1, page);
    const base = baseUrl || MS_BASE;
    const started = Date.now();

    const probe = await probeEndpoints(
        'modelscope',
        base,
        MS_SERVER_TPLS,
        query,
        safePage,
        pageSize,
        category || ''
    );

    setDiagnostics('modelscope', {
        platform: 'modelscope',
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
            : buildHint('modelscope', 'ModelScope', probe.attempts, safePage),
    });

    if (!probe.matchedUrl) {
        return {
            items: [],
            pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
        };
    }

    let items = probe.items.map(r => mapServer(r as RawMS));

    if (category && category !== 'all') {
        items = items.filter(
            i => (i.categories && i.categories.includes(category)) || (i.tags && i.tags.includes(category))
        );
    }
    if (sort && sort !== 'relevance') {
        if (sort === 'stars') {
            items.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        } else if (sort === 'updated') {
            items.sort((a, b) => {
                const da = a.extra?.updatedAt ? new Date(a.extra.updatedAt as string).getTime() : 0;
                const db = b.extra?.updatedAt ? new Date(b.extra.updatedAt as string).getTime() : 0;
                return db - da;
            });
        }
    }

    const pageInfo = extractPageInfo(probe.json, safePage, pageSize, items.length);
    return {items, pageInfo};
}

export const modelscopeAdapter: PlatformAdapter = {
    id: 'modelscope',
    name: 'ModelScope',

    async searchSkills(params: PlatformSearchParams): Promise<PlatformSearchPage> {
        return msSearchImpl(params);
    },

    async searchServers(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
        return msServerSearchImpl(params);
    },

    async fetchServerDetail(_params: PlatformSearchParams, serverId: string): Promise<PlatformServerDetail> {
        const id = serverId;
        const repoUrl = `https://modelscope.cn/${id}`;
        // 探针：README 是否存在
        const readmeProbe = await probeEndpoints(
            'modelscope',
            MS_BASE,
            [
                `https://modelscope.cn/api/v1/models/${id}/repo/files?Recursive=true&Revision=master`,
                `https://modelscope.cn/api/v1/datasets/${id}/repo/files?Recursive=true&Revision=master`,
            ],
            '',
            1,
            1,
            ''
        );
        if (readmeProbe.matchedUrl) {
        }
        return {
            id,
            name: id.split('/').pop() || id,
            displayName: id.split('/').pop() || id,
            description: '',
            sourceUrl: repoUrl,
            tags: [],
            source: 'modelscope',
            install: {command: 'npx', args: ['-y', '@modelscope/mcp-server', '--repo', id], env: {}},
            extra: {readmeProbe: readmeProbe.matchedUrl, repoUrl},
        };
    },

    getFacets() {
        return {
            categories: MS_CATEGORIES,
            sortOptions: MS_SORTS,
            supportsSubcategories: false,
        };
    },
};