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
    {id: 'ONEKEY', name: '云市场'},
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

export function mapServer(raw: RawBailian, idx: number): PlatformServerListItem {
    const id = `${raw.source || 'bailian'}-${raw.serverName}-${idx}`;
    return {
        id,
        name: raw.serverName,
        displayName: raw.serverName,
        description: raw.description || '',
        iconUrl: raw.icon,
        categories: raw.classification ? [raw.classification] : [],
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
            const matchCat = !category || category === 'ALL' || r.classification === category;
            const matchSource = !source || source === 'ALL' || r.source === source;
            const matchQ =
                !q ||
                r.serverName.toLowerCase().includes(q) ||
                (r.description || '').toLowerCase().includes(q);
            return matchCat && matchSource && matchQ;
        });

        // 客户端排序（服务端不支持）
        if (sort && sort !== 'calls') {
            const dir = sort === 'users' ? -1 : 1;
            filtered.sort((a, b) => {
                if (sort === 'name') return (a.serverName || '').localeCompare(b.serverName || '') * dir;
                const av = (a as any)[sort] || 0;
                const bv = (b as any)[sort] || 0;
                return (bv - av) * dir;
            });
        } else {
            filtered.sort((a, b) => (b.callTotalCount || 0) - (a.callTotalCount || 0));
        }

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
        const idx = Number(serverId.split('-').pop()) || 0;
        const raw = all[idx] || all.find((_, i) => mapServer(_, i).id === serverId);
        if (!raw) {
            throw new Error('未找到该百炼服务（离线索引中不存在）');
        }
        const item = mapServer(raw, idx);
        return {
            ...item,
            readme: raw.description,
            install: null, // 百炼为远程托管服务，客户端无需本地安装命令
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
