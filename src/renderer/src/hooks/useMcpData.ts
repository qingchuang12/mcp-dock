import {useQuery} from '@tanstack/react-query';
import {
    fetchServerList,
    fetchSmitheryServersPaged,
    type DataSource,
    type ServerListItem,
} from '../api/registry';
import {useElectronAPI} from '../lib/electron';
import type {PlatformServerListItem} from '../lib/electron';
import {paginateServers, searchServers} from '../lib/search';
import type {StoreData, StoreResourceType} from './storeTypes';
import {STORE_QUERY_STALE_MS} from './storeTypes';

/** 将平台 MCP server 列表项映射为统一的 ServerListItem，复用 ServerCard 渲染 */
function mapPlatformServer(item: PlatformServerListItem): ServerListItem {
    return {
        id: item.id,
        displayName: item.displayName,
        description: item.description,
        iconUrl: item.iconUrl ?? null,
        source: 'platform',
        author: item.source,
        stars: item.stars ?? 0,
        categories: item.categories,
        repository: item.sourceUrl ? {url: item.sourceUrl, branch: '', owner: '', repo: ''} : undefined,
    } as ServerListItem;
}

interface UseMcpDataParams {
    resourceType: StoreResourceType;
    /** 选中的 MCP 平台连接 ID；为 null 时走内置源（official/smithery） */
    mcpConnId: string | null;
    dataSource: DataSource;
    page: number;
    pageSize: number;
    debouncedSearch: string;
}

/**
 * MCP 数据查询（统一收口）：
 * - 内置源（official/smithery）：一次性全量拉取 + 前端搜索/切片。
 * - 平台源（ModelScope 等）：服务端分页，按页查询；total 取自 pageInfo.total。
 *
 * 商店数据缓存 10 分钟（STORE_QUERY_STALE_MS）：切换页面 / 标签页 / 分页时直接命中缓存、
 * 立即渲染，避免重复等待在线请求；超过 10 分钟才判定过期并重新拉取。手动「刷新」按钮
 * 仍会强制绕过缓存重新请求。
 */
export function useMcpData(params: UseMcpDataParams): StoreData<ServerListItem> {
    const {resourceType, mcpConnId, dataSource, page, pageSize, debouncedSearch} = params;
    const api = useElectronAPI();
    const enabled = resourceType === 'mcp';

    // 内置源 - official：一次性全量拉取 + 前端切片；命中 10 分钟缓存不再等待
    const builtin = useQuery({
        queryKey: ['mcpBuiltin', dataSource],
        queryFn: async () => {
            return fetchServerList(dataSource, undefined, true);
        },
        // 数据缓存 10 分钟：卸载后保留缓存，重新进入直接命中；过期才重新拉取
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        // 仅在数据过期（>10min）时重新拉取，未过期直接命中缓存即时渲染
        refetchOnMount: true,
        enabled: enabled && !mcpConnId && dataSource === 'official',
    });

    // 内置源 - smithery：服务端分页，按需按页拉取，进入不再全量加载
    const smitheryPaged = useQuery({
        queryKey: ['mcpSmithery', page, pageSize, debouncedSearch],
        queryFn: async () => {
            return fetchSmitheryServersPaged(page, pageSize, debouncedSearch);
        },
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: enabled && !mcpConnId && dataSource === 'smithery',
    });

    const platform = useQuery({
        queryKey: ['mcpPlatform', mcpConnId, debouncedSearch, page],
        queryFn: async () => {
            if (!mcpConnId) return null;
            const res = await api.apiConnections.searchPlatformServersPaged(
                mcpConnId, debouncedSearch, page, pageSize, ''
            );
            return res;
        },
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        // 仅在数据过期（>10min）时重新查询在线商店；未过期直接命中缓存即时渲染
        refetchOnMount: true,
        enabled: enabled && !!mcpConnId,
    });

    if (mcpConnId) {
        const res = platform.data ?? null;
        const items = (res?.items ?? []).map(mapPlatformServer);
        const total = res ? (res.pageInfo.total ?? res.items.length) : 0;
        const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 0;
        const startIndex = total > 0 ? (page - 1) * pageSize + 1 : 0;
        const endIndex = Math.min((page - 1) * pageSize + items.length, total);
        return {
            items,
            total,
            totalItems: total,
            totalPages,
            startIndex,
            endIndex,
            pagingMode: 'server',
            isUnsupported: false,
            isLoading: platform.isLoading,
            isFetching: platform.isFetching,
            error: platform.error as Error | null,
            message: res?.message,
            refetch: platform.refetch,
        };
    }

    // smithery：服务端分页，按页展示，total 取自上游真实总数
    if (dataSource === 'smithery') {
        const res = smitheryPaged.data;
        // 服务端若已按关键词过滤则此处为幂等；若上游不识别 q，则再做一次客户端兜底过滤
        const items = res ? searchServers(res.items, debouncedSearch) : [];
        const total = res?.total ?? 0;
        const totalPages = res?.totalPages ?? 0;
        const startIndex = total > 0 ? (page - 1) * pageSize + 1 : 0;
        const endIndex = Math.min((page - 1) * pageSize + items.length, total);
        return {
            items,
            total,
            totalItems: total,
            totalPages,
            startIndex,
            endIndex,
            pagingMode: 'server',
            isUnsupported: false,
            isLoading: smitheryPaged.isLoading,
            isFetching: smitheryPaged.isFetching,
            error: smitheryPaged.error as Error | null,
            refetch: smitheryPaged.refetch,
        };
    }

    const list = builtin.data ?? [];
    const filtered = searchServers(list, debouncedSearch);
    const paginated = paginateServers(filtered, page, pageSize);
    return {
        items: paginated.items,
        total: paginated.totalItems,
        totalItems: paginated.totalItems,
        totalPages: paginated.totalPages,
        startIndex: paginated.startIndex,
        endIndex: paginated.endIndex,
        pagingMode: 'client',
        isUnsupported: false,
        isLoading: builtin.isLoading,
        isFetching: builtin.isFetching,
        error: builtin.error as Error | null,
        refetch: builtin.refetch,
    };
}
