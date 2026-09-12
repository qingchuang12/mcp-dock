/**
 * 百炼（阿里云 Model Studio）平台适配器。
 *
 * 决策 2A：离线索引优先。全库仅 251 条，内置 index.json 即可做全量客户端
 * 搜索/分类/来源/排序/分页，免 Cookie、免配额。在线模式（需控制台 Cookie）作为
 * 可选回退，未配置时直接走离线索引。分类/来源过滤用白名单（接口对非法 classification
 * 静默返回空，不报错）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
    CategoryNode,
    PlatformAdapter,
    PlatformSearchParams,
    PlatformServerDetail,
    PlatformServerListItem,
    PlatformServerSearchPage,
    SortOption,
    SourceFilter,
} from './types';
import {setDiagnostics} from './shared';

// 百炼 8 分类枚举（doc 第5节）+ 中文名
const BAILIAN_CLASSIFICATION: Record<string, string> = {
    CORPORATE_SERVICE: '企业服务',
    LIFE_SERVICE: '生活服务',
    DATA_SEARCH: '数据搜索',
    DEVELOPER_TOOL: '开发者工具',
    CONTENT_GENERATION: '内容生成',
    CLOUD_NATIVE: '云原生',
    SEARCH_TOOL: '搜索工具',
    UNCLASSIFIED: '未分类',
};

// 百炼 9 source 维度（doc 第6节）
const BAILIAN_SOURCES: SourceFilter[] = [
    {id: 'ALIYUN', name: '阿里云'},
    {id: 'TONGYI', name: '通义'},
    {id: 'AMAP', name: '高德'},
    {id: 'DINGTALK', name: '钉钉'},
    {id: 'PARTNER', name: '三方伙伴'},
    {id: 'OPEN_SOURCE_COMMUNITY', name: '开源社区'},
    {id: 'ALIYUN_MARKET', name: '云市场'},
    {id: 'ONEKEY', name: '一键接入'},
    {id: 'OFFICIAL', name: '官方'},
];

const BAILIAN_SORTS: SortOption[] = [
    {id: 'calls', name: '调用最多', field: 'callTotalCount', order: 'desc'},
    {id: 'users', name: '激活用户最多', field: 'activateUserCount', order: 'desc'},
    {id: 'name', name: '名称', field: 'serverName', order: 'asc'},
];

interface RawBailian {
    serverName: string;
    classification?: string | null;
    source?: string;
    sourceName?: string;
    callTotalCount?: number;
    activateUserCount?: number;
    icon?: string;
    deployEnv?: string;
    description?: string;
}

/** 离线索引文件（与 adapter 同目录的 bailian/data/，由 build:main 拷贝进 dist）。 */
function loadIndex(): RawBailian[] {
    const p = path.join(__dirname, 'bailian', 'data', 'bailian-index.json');
    try {
        if (fs.existsSync(p)) {
            const json = JSON.parse(fs.readFileSync(p, 'utf8'));
            const items = Array.isArray(json?.items) ? json.items : [];
            if (items.length === 0) {
                console.warn('[bailian] 离线索引为空：', p);
            }
            return items;
        }
    } catch (e: any) {
        console.error('[bailian] 离线索引读取失败：', p, e?.message);
        return [];
    }
    console.warn('[bailian] 离线索引文件缺失，百炼列表将为空（请确认 build:main 已拷贝 data 目录）：', p);
    return [];
}

export function mapServer(raw: RawBailian, _idx?: number): PlatformServerListItem {
    // id 用稳定编码（source + serverName），不依赖切片下标，保证翻页/排序/过滤后详情仍能回查
    const id = `bailian:${raw.source || 'unknown'}:${encodeURIComponent(raw.serverName)}`;
    return {
        id,
        name: raw.serverName,
        displayName: raw.serverName,
        description: raw.description || '',
        // 离线索引里的 icon 字段是占位死链（img.alicdn.com/.../O1CN010.png 实测 HTTP 404），
        // 向下传递只会让每张卡片都发一次 404 请求并闪现裂图；改为不传，由 UI 回退到首字母头像。
        iconUrl: undefined,
        categories: raw.classification ? [raw.classification] : [],
        // 中文展示名：与分类下拉（BAILIAN_CLASSIFICATION）保持一致，否则卡片 tag 显英文 slug
        categoryNames: raw.classification
            ? [BAILIAN_CLASSIFICATION[raw.classification] ?? raw.classification]
            : [],
        stars: typeof raw.callTotalCount === 'number' ? raw.callTotalCount : undefined,
        sourceUrl: `https://bailian.console.aliyun.com/#/mcp/server/${encodeURIComponent(raw.serverName)}`,
        author: raw.sourceName,
        publisher: raw.sourceName,
        isHosted: raw.deployEnv === 'REMOTE',
        isVerified: raw.source === 'ALIYUN' || raw.source === 'TONGYI',
        tags: raw.classification ? [raw.classification] : [],
        source: 'bailian',
        extra: {
            callTotalCount: raw.callTotalCount,
            activateUserCount: raw.activateUserCount,
            deployEnv: raw.deployEnv,
            source: raw.source,
            sourceName: raw.sourceName,
        },
    };
}

export const bailianAdapter: PlatformAdapter = {
    id: 'bailian',
    name: '百炼',

    async searchServers(params: PlatformSearchParams): Promise<PlatformServerSearchPage> {
        const {query, page, pageSize, category, sort, source} = params;
        const safePage = Math.max(1, page);
        const started = Date.now();

        // 离线索引优先
        const all = loadIndex();
        const q = query.trim().toLowerCase();

        let filtered = all.filter(r => {
        // 「全部」哨兵值必须是小写 'all'：渲染层 useMcpData 固定传 `category || 'all'` /
        // `source || 'all'`，下拉框「全部」的 value 也是 'all'（StoreToolbar/StoreFilterBar），
        // 且 modelscope/npm 的同款判据均为小写。旧实现写 'ALL'（大写）导致渲染层默认值
        // 永不命中 → 251 条全被过滤 → 商店-MCP-百炼列表恒为空。
        const matchCat = !category || category === 'all' || r.classification === category;
        const matchSource = !source || source === 'all' || r.source === source;
            const matchQ =
                !q ||
                r.serverName.toLowerCase().includes(q) ||
                (r.description || '').toLowerCase().includes(q);
            return matchCat && matchSource && matchQ;
        });

        // 客户端排序（离线索引无排序能力，全部本地完成）。
        // 必须用 SortOption 的 field/order 解释排序 id，不能把 id 直接当字段名：
        // 旧实现 `(a as any)[sort]` 对 sort='users' 取的是 activateUserCount 不存在的键
        // （取到 undefined → 0），比较器恒返回 0 → 排序静默失效；且方向用
        // `sort==='users' ? -1 : 1` 硬编码，与 BAILIAN_SORTS 里标注的 order:'desc' 相抵，
        // 即便取到字段也会反向。改为以 BAILIAN_SORTS 为唯一事实源。
        const sortDef = sort ? BAILIAN_SORTS.find(s => s.id === sort) : undefined;
        const field = sortDef?.field ?? 'callTotalCount';
        const asc = sortDef?.order === 'asc';
        filtered.sort((a, b) => {
            if (field === 'serverName') {
                const c = (a.serverName || '').localeCompare(b.serverName || '');
                return asc ? c : -c;
            }
            const av = field === 'activateUserCount' ? a.activateUserCount || 0 : a.callTotalCount || 0;
            const bv = field === 'activateUserCount' ? b.activateUserCount || 0 : b.callTotalCount || 0;
            return asc ? av - bv : bv - av;
        });

        const total = filtered.length;
        const start = (safePage - 1) * pageSize;
        const slice = filtered.slice(start, start + pageSize);

        setDiagnostics('bailian', {
            platform: 'bailian',
            baseUrl: params.baseUrl || 'offline-index',
            query,
            page: safePage,
            category,
            authorized: false,
            attempts: [
                {
                    url: 'offline-index://bailian-index.json',
                    ok: true,
                    durationMs: Date.now() - started,
                    itemCount: total,
                },
            ],
            matchedUrl: 'offline-index://bailian-index.json',
            totalDurationMs: Date.now() - started,
        });

        return {
            items: slice.map(mapServer),
            pageInfo: {
                page: safePage,
                pageSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
                hasMore: start + pageSize < total,
            },
            message: '离线索引模式（免 Cookie）',
        };
    },

    async fetchServerDetail(
        _params: PlatformSearchParams,
        serverId: string
    ): Promise<PlatformServerDetail> {
        const all = loadIndex();
        const m = serverId.match(/^bailian:([^:]+):(.+)$/);
        const raw = m
            ? all.find(r => (r.source || 'unknown') === decodeURIComponent(m[1]) && r.serverName === decodeURIComponent(m[2]))
            : undefined;
        if (!raw) {
            throw new Error('未找到该百炼服务（离线索引中不存在）');
        }
        const item = mapServer(raw);
        // 百炼为远程托管 MCP：「安装」= 向客户端 MCP 配置写入 URL 接入点（SSE/Streamable HTTP）
        // 而非本地命令。slug 由 serverName 生成仅作预填默认值——离线索引的中文名与控制台
        // 接入 slug 并非同一标识，详情页允许编辑，最终以百炼控制台该服务的「接入地址」为准。
        const slug = encodeURIComponent(raw.serverName);
        const readme = [
            raw.description || '',
            '',
            '## 百炼远程托管 MCP 接入说明',
            '',
            '- 该服务为阿里云百炼远程托管 MCP，无需本地安装命令，客户端通过 URL 直连。',
            `- 默认接入地址（SSE）：https://dashscope.aliyuncs.com/api/v1/mcps/${slug}/sse`,
            '- 鉴权：需配置请求头 Authorization: Bearer <DASHSCOPE_API_KEY>（百炼 API Key，sk- 开头，在百炼控制台 API-KEY 页面获取）。',
            '- 注意：接入地址中的 slug 可能与服务显示名不同，请以百炼控制台该服务的「接入地址」为准。',
        ].join('\n');
        return {
            ...item,
            readme,
            install: {
                url: `https://dashscope.aliyuncs.com/api/v1/mcps/${slug}/sse`,
                type: 'sse' as const,
                headersTemplate: {Authorization: 'Bearer ${DASHSCOPE_API_KEY}'},
            },
            envSchema: {
                properties: {
                    DASHSCOPE_API_KEY: {
                        type: 'string',
                        description: '阿里云百炼 API Key（sk-…），在百炼控制台 API-KEY 页面获取',
                    },
                },
                required: ['DASHSCOPE_API_KEY'],
            },
            extra: {...item.extra, mode: 'remote'},
        };
    },

    getFacets() {
        const all = loadIndex();
        // 聚合分类计数
        const clsCount = new Map<string, number>();
        const srcCount = new Map<string, number>();
        for (const r of all) {
            const c = r.classification || 'UNCLASSIFIED';
            clsCount.set(c, (clsCount.get(c) || 0) + 1);
            if (r.source) srcCount.set(r.source, (srcCount.get(r.source) || 0) + 1);
        }
        const categories: CategoryNode[] = Object.entries(BAILIAN_CLASSIFICATION).map(([id, name]) => ({
            id,
            name,
            count: clsCount.get(id) || 0,
        }));
        const sourceFilter: SourceFilter[] = BAILIAN_SOURCES.map(s => ({
            ...s,
            count: srcCount.get(s.id) || 0,
        })).filter(s => (s.count || 0) > 0);
        return {
            categories,
            sourceFilter,
            sortOptions: BAILIAN_SORTS,
            supportsSubcategories: false,
        };
    },
};
