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
} from './types';
import {buildHint, extractPageInfo, fetchJson, locateArray, probeEndpoints, setDiagnostics,} from './shared';

const MS_BASE = 'https://modelscope.cn';

// Skill 搜索端点（实测：支持 search 搜索 + filter.category 分类过滤，一次到位）
const MS_SKILL_TPLS = [
    '/openapi/v1/skills?search={q}&page_number={page}&page_size={size}&filter.category={category}',
];

// MCP server 搜索端点（doc：PUT /openapi/v1/mcp/servers）
// ModelScope Skill 分类（来自对接文档第五节：对可访问前 2400 条统计得到的真实 18 类，
// id 为 API 返回的英文 slug，name 为对应的中文展示名。注意：这是 ModelScope 真实分类，
// 与 MCP 的 81 类（MS_SERVER_CATEGORIES）是完全两套体系，不要混用）。
const MS_CATEGORIES: CategoryNode[] = [
    {id: 'developer-tools', name: '开发工具'},
    {id: 'ai-media', name: 'AI 多媒体'},
    {id: 'marketing-seo', name: '营销与 SEO'},
    {id: 'other', name: '其他'},
    {id: 'skill-management', name: '技能管理'},
    {id: 'code-quality-testing', name: '代码质量与测试'},
    {id: 'frontend-development', name: '前端开发'},
    {id: 'cloud-devops', name: '云与 DevOps'},
    {id: 'mobile-development', name: '移动开发'},
    {id: 'ai-automation', name: 'AI 自动化'},
    {id: 'content-strategy', name: '内容策略'},
    {id: 'analytics', name: '数据分析'},
    {id: 'doc-processing', name: '文档处理'},
    {id: 'skill-creation', name: '技能创建'},
    {id: 'ui-ux-design', name: 'UI/UX 设计'},
    {id: 'general-tools', name: '通用工具'},
    {id: 'api-design', name: 'API 设计'},
];

// ModelScope MCP server 分类（来自文档「MCP 分类枚举」第五节，完整 81 类，含 count<10 与
// 大小写变体脏数据，按用户要求全部保留）。注意：MCP 端点只认英文 slug，
// 中文名仅用于展示；与 Skill 的 18 类中文分类（MS_CATEGORIES）是两套完全不同的体系。
const MS_SERVER_CATEGORIES: CategoryNode[] = [
    {id: 'developer-tools', name: '开发工具'},
    {id: 'search', name: '搜索'},
    {id: 'app-automation', name: '应用自动化'},
    {id: 'databases', name: '数据库'},
    {id: 'knowledge-and-memory', name: '知识与记忆'},
    {id: 'browser-automation', name: '浏览器自动化'},
    {id: 'cloud-platforms', name: '云平台'},
    {id: 'file-systems', name: '文件系统'},
    {id: 'communication', name: '通讯工具'},
    {id: 'research-and-data', name: '研究与数据'},
    {id: 'os-automation', name: '操作系统自动化'},
    {id: 'other', name: '其他'},
    {id: 'image-and-video-processing', name: '图像与视频处理'},
    {id: 'entertainment-and-media', name: '娱乐与媒体'},
    {id: 'finance', name: '金融'},
    {id: 'rag-systems', name: 'RAG 检索增强生成系统'},
    {id: 'autonomous-agents', name: '自主智能体'},
    {id: 'monitoring', name: '监控'},
    {id: 'version-control', name: '版本控制'},
    {id: 'note-taking', name: '笔记'},
    {id: 'security-and-iam', name: '安全与身份认证(IAM)'},
    {id: 'agent-orchestration', name: '智能体编排'},
    {id: 'location-services', name: '位置服务'},
    {id: 'web-scraping', name: '网页抓取'},
    {id: 'code-execution', name: '代码执行'},
    {id: 'calendar-management', name: '日历管理'},
    {id: 'content-management-systems', name: '内容管理系统'},
    {id: 'documentation-access', name: '文档访问'},
    {id: 'social-media', name: '社交媒体'},
    {id: 'art-and-culture', name: '艺术与文化'},
    {id: 'virtualization', name: '虚拟化'},
    {id: 'project-management', name: '项目管理'},
    {id: 'code-analysis', name: '代码分析'},
    {id: 'ecommerce-and-retail', name: '电商与零售'},
    {id: 'multimedia-processing', name: '多媒体处理'},
    {id: 'travel-and-transportation', name: '旅行与交通'},
    {id: 'customer-data-platforms', name: '客户数据平台(CDP)'},
    {id: 'marketing', name: '营销'},
    {id: 'cloud-storage', name: '云存储'},
    {id: 'education-and-learning-tools', name: '教育与学习工具'},
    {id: 'testing-and-qa-tools', name: '测试与质量保障(QA)'},
    {id: 'home-automation-and-iot', name: '家庭自动化与物联网(IoT)'},
    {id: 'shell-access', name: 'Shell 访问'},
    {id: 'command-line', name: '命令行'},
    {id: 'workplace-and-productivity', name: '办公与生产力'},
    {id: 'api-testing', name: 'API 测试'},
    {id: 'ci-cd', name: '持续集成与交付(CI/CD)'},
    {id: 'vector-databases', name: '向量数据库'},
    {id: 'games-and-gamification', name: '游戏与游戏化'},
    {id: 'speech-processing', name: '语音处理'},
    {id: 'health-and-wellness', name: '健康与养生'},
    {id: 'text-summarization', name: '文本摘要'},
    {id: 'weather-services', name: '天气服务'},
    {id: 'observability', name: '可观测性'},
    {id: 'data-platforms', name: '数据平台'},
    {id: 'customer-support', name: '客户支持'},
    {id: 'open-data', name: '开放数据'},
    {id: 'blockchain', name: '区块链'},
    {id: 'government-data', name: '政府数据'},
    {id: 'coding-agents', name: '编码智能体'},
    {id: 'audio-processing', name: '音频处理'},
    {id: 'penetration-testing', name: '渗透测试'},
    {id: 'language-translation', name: '语言翻译'},
    {id: 'cryptocurrency', name: '加密货币'},
    {id: 'web3', name: 'Web3'},
    {id: 'text-to-speech', name: '文本转语音(TTS)'},
    {id: 'erp-systems', name: 'ERP 系统'},
    {id: 'fitness-tracking', name: '健身追踪'},
    {id: 'legal-and-compliance', name: '法律与合规'},
    // 以下为文档「MCP 分类枚举」中 count<10 的分类，按用户要求保留完整 81 类（不再聚合到 other）。
    // 注：部分 slug 为大小写变体（Search/Finance/Knowledge&Memory/aigc/AIGC），属源数据脏数据，
    // 但为保持分类完整性一并保留；调用 filter.category 时服务端按精确大小写匹配。
    {id: 'biology-and-medicine', name: '生物与医学'},
    {id: 'software-architecture', name: '软件架构'},
    {id: 'AIGC', name: '生成式人工智能(AIGC)'},
    {id: 'bioinformatics', name: '生物信息学'},
    {id: 'transportation', name: '交通'},
    {id: 'sports', name: '体育'},
    {id: 'Search', name: '搜索'},
    {id: 'real-estate', name: '房地产'},
    {id: 'aigc', name: '生成式人工智能(AIGC)'},
    {id: 'Knowledge&Memory', name: '知识与记忆'},
    {id: 'Finance', name: '金融'},
    {id: 'aerospace-and-astrodynamics', name: '航空航天与天体动力学'},
];

// ModelScope 分类 slug → 中文名映射（Skill 用 MS_CATEGORIES，MCP 用 MS_SERVER_CATEGORIES）。
// 适配器在归一化列表项时把原始英文 slug 转成中文展示名，避免卡片直接显示 developer-tools 这类 slug。
const MS_SKILL_CAT_NAME = new Map(MS_CATEGORIES.map(c => [c.id, c.name]));
const MS_SERVER_CAT_NAME = new Map(MS_SERVER_CATEGORIES.map(c => [c.id, c.name]));

// Skill 详情端点（仓库 README 探测）

interface RawMS {
    _id?: string;
    id?: string;
    display_name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    custom_tag?: string[];
    developer?: string;
    owner?: string;
    license?: string;
    source_url?: string;
    view_count?: number;
    downloads?: number;
    logo_url?: string;
    private?: boolean;
    last_modified?: string;
    file_last_modified?: string;
    locales?: string[];
}
export function mapSkill(raw: RawMS): PlatformSkillListItem {
    const id = raw.id || raw._id || '';
    const repoUrl = raw.source_url || `${MS_BASE}/${id}`;
    return {
        id,
        name: raw.display_name || id,
        description: raw.description || '',
        source: 'modelscope',
        sourceUrl: repoUrl,
        downloadUrl: repoUrl,
        // 浏览量 / 下载量（商店卡片与详情展示用，不再误当成 stars）
        viewCount: raw.view_count,
        downloads: raw.downloads,
        updatedAt: raw.last_modified,
        // 原始 category 为英文 slug（如 cloud-devops）；空值（源数据未标注）归到 other
        category: raw.category?.trim() || 'other',
        // 附带中文展示名，卡片/详情优先展示它；未知 slug 回退原 slug
        categoryName: (() => {
            const cat = raw.category?.trim() || 'other';
            return MS_SKILL_CAT_NAME.get(cat) ?? cat;
        })(),
        extra: {
            author: raw.developer || raw.owner,
            downloads: raw.downloads,
            coverUrl: raw.logo_url,
            repoUrl,
            license: raw.license,
            customTags: raw.custom_tag,
        },
    };
}

interface RawMCP {
    id?: string;
    name?: string;
    chinese_name?: string;
    description?: string;
    categories?: string[];
    tags?: string[];
    publisher?: string;
    view_count?: number;
    logo_url?: string;
}

export function mapMCPServer(raw: RawMCP): PlatformServerListItem {
    const repoUrl = `https://modelscope.cn/${raw.id || ''}`;
    return {
        id: raw.id || '',
        name: raw.name || raw.id || '',
        displayName: raw.chinese_name || raw.name || raw.id || '',
        description: raw.description || '',
        iconUrl: raw.logo_url,
        categories: raw.categories || [],
        // 中文展示名（与 categories 一一对应）；categories 保留原始 slug 用于分类过滤匹配
        categoryNames: (raw.categories || []).map(c => MS_SERVER_CAT_NAME.get(c) ?? c),
        tags: raw.tags || [],
        publisher: raw.publisher,
        // 浏览量（ModelScope 列表字段 view_count）
        viewCount: raw.view_count,
        sourceUrl: repoUrl,
        source: 'modelscope',
        isHosted: false,
        isVerified: false,
        extra: {repoUrl},
    };
}

/** 核心搜索（skill 与 server 复用同一列表端点，服务端过滤缺失，靠客户端切片分页）。 */
async function msSearchImpl(params: PlatformSearchParams): Promise<PlatformSearchPage> {
    const {query, page, pageSize, baseUrl, category, sort} = params;
    const safePage = Math.max(1, page);
    const base = baseUrl || MS_BASE;
    const started = Date.now();

    // category 为 'all' 或空时不传 filter.category 参数，否则 ModelScope 会按字面量 "all" 过滤导致无结果
    const effectiveCategory = (category && category !== 'all') ? category : '';
    const tpls = effectiveCategory
        ? MS_SKILL_TPLS
        : ['/openapi/v1/skills?search={q}&page_number={page}&page_size={size}'];

    const probe = await probeEndpoints(
        'modelscope',
        base,
        tpls,
        query,
        safePage,
        pageSize,
        effectiveCategory
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
            : buildHint('modelscope', probe.attempts, safePage),
    });

    if (!probe.matchedUrl) {
        return {
            items: [],
            pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
            unsupported: probe.attempts.length > 0 && probe.attempts.every(a => a.reason === 'non-json'),
        };
    }

    let items = probe.items.map(r => mapSkill(r as RawMS));

    // 分类过滤已通过 MS_SKILL_TPLS 的 filter.category 直接走服务端（T0：去掉二次请求）
    // 客户端排序（API 不支持服务端排序）
    if (sort && sort !== 'relevance') {
        if (sort === 'downloads') {
            items.sort((a, b) => ((b.extra?.downloads as number) || 0) - ((a.extra?.downloads as number) || 0));
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

/** MCP server 搜索（PUT /openapi/v1/mcp/servers，JSON Body 传参）。 */
async function msServerSearchImpl(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
    const {query, page, pageSize, baseUrl, category} = params;
    const safePage = Math.max(1, page);
    const base = baseUrl || MS_BASE;
    const url = `${base}/openapi/v1/mcp/servers`;
    const started = Date.now();

    const body: Record<string, unknown> = {
        page_number: safePage,
        page_size: pageSize,
        search: query || '',
        filter: {},
    };
    if (category && category !== 'all') {
        (body.filter as Record<string, unknown>).category = category;
    }

    const result = await fetchJson(url, body);

    setDiagnostics('modelscope', {
        platform: 'modelscope',
        baseUrl: base,
        query,
        page: safePage,
        category,
        authorized: false,
        attempts: result ? [{url, ok: true, durationMs: Date.now() - started}] : [{url, ok: false, durationMs: Date.now() - started, reason: 'http'}],
        matchedUrl: result ? url : null,
        totalDurationMs: Date.now() - started,
        hint: result ? undefined : buildHint('modelscope', [], safePage),
    });

    if (!result || !result.json) {
        return {
            items: [],
            pageInfo: {page: safePage, pageSize, total: null, totalPages: null, hasMore: false},
        };
    }

    const list = locateArray(result.json);
    let items = (list as RawMCP[]).map(r => mapMCPServer(r));

    if (category && category !== 'all') {
        const cat = category;
        items = items.filter(i => (i.categories && i.categories.includes(cat)) || (i.tags && i.tags.includes(cat)));
    }

    const pageInfo = extractPageInfo(result.json, safePage, pageSize, items.length);
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
        return {
            id,
            name: id.split('/').pop() || id,
            displayName: id.split('/').pop() || id,
            description: '',
            sourceUrl: repoUrl,
            tags: [],
            source: 'modelscope',
            install: {command: 'npx', args: ['-y', '@modelscope/mcp-server', '--repo', id], env: {}},
            extra: {repoUrl},
        };
    },

    getFacets(resourceType?: 'mcp' | 'skills') {
        // MCP 与 Skill 在 ModelScope 是两套完全不同的分类体系：
        // - MCP 端点（PUT /openapi/v1/mcp/servers）使用英文 slug 分类（MS_SERVER_CATEGORIES）
        // - Skill 端点（/openapi/v1/skills）使用 18 类中文分类（MS_CATEGORIES）
        // 之前两者共用 MS_CATEGORIES，导致 MCP 浏览器选「技能管理」等 Skill 分类时过滤无结果。
        const categories = resourceType === 'mcp' ? MS_SERVER_CATEGORIES : MS_CATEGORIES;
        return {
            categories,
            // ModelScope 接口不支持排序（MCP 端点无 sort 参数；Skill 端点亦不支持），
            // 故不返回排序选项，前端第二栏据此隐藏排序控件。
            sortOptions: [],
            supportsSubcategories: false,
        };
    },
};

/**
 * Skill 详情：GET /api/v1/skills/<id>（注意非 /openapi/v1/，后者仅用于列表）。
 * 安装 SKILL.md 走 source_url → GitHub raw；source_url 为空时由调用方兜底。
 * 复用现有 skills:get-remote-detail（GitHub 解析）通道消费 sourceUrl。
 */
