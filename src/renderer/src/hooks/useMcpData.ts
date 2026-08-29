import {useMemo} from 'react';
import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {type DataSource, fetchServerList, fetchSmitheryServersPaged, type ServerListItem,} from '../api/registry';
import type {PlatformServerListItem} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
import {filterServersByCategory, paginateServers, searchServers, sortServers} from '../lib/search';
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
        author: item.author || item.source,
        stars: item.stars ?? 0,
        categories: item.categories,
        categoryNames: item.categoryNames,
        viewCount: item.viewCount ?? null,
        tags: item.tags,
        isHosted: item.isHosted,
        verified: item.isVerified,
        repository: item.sourceUrl ? {url: item.sourceUrl} : undefined,
        extra: item.extra,
    };
}

interface UseMcpDataParams {
    resourceType: StoreResourceType;
    /** 选中的 MCP 平台连接 ID；为 null 时走内置源（official/smithery） */
    mcpConnId: string | null;
    /** 平台直连源类型（如 'modelscope'），用于统一适配器通道 */
    platformType?: string;
    dataSource: DataSource;
    page: number;
    pageSize: number;
    debouncedSearch: string;
    category?: string;
    sort?: string;
    source?: string;
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
    const {resourceType, mcpConnId, platformType, dataSource, page, pageSize, debouncedSearch, category, sort, source} = params;
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
        refetchOnMount: true,
        enabled: enabled && !mcpConnId && dataSource === 'official',
    });

    // 内置源 - smithery：服务端分页，按需按页拉取，进入不再全量加载
    const smitheryPaged = useQuery({
        queryKey: ['mcpSmithery', page, pageSize, debouncedSearch],
        queryFn: async () => {
            return fetchSmitheryServersPaged(page, pageSize, debouncedSearch);
        },
        // S1-11: 翻页时保留上一页数据作为占位，避免整页 Loading 跳动
        placeholderData: keepPreviousData,
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: enabled && !mcpConnId && dataSource === 'smithery',
    });

    const platform = useQuery({
        // S0-2: 补 pageSize —— 否则改每页条数只命中旧缓存、页码与数据不符
        queryKey: ['mcpPlatform', mcpConnId, debouncedSearch, page, pageSize, category, sort, source],
        queryFn: async () => {
            if (!mcpConnId) return null;
            // 平台源走统一适配器通道（支持分类/排序/来源筛选）
            const res = await api.platforms.searchServers(
                platformType || '', debouncedSearch, page, pageSize, category || 'all', sort || 'relevance', source || 'all',
                // S0-6: 透传连接 ID，主进程按 ID 精确取 token/baseUrl（多连接场景不再猜错）
                mcpConnId ?? undefined
            );
            return res;
        },
        // S1-11: 翻页时保留上一页数据作为占位，避免整页 Loading 跳动
        placeholderData: keepPreviousData,
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: enabled && !!mcpConnId,
    });

    // S1-10: 内置源全量列表原先每次渲染都同步重算。包一层 useMemo 仅在数据或筛选条件变化时重算。
    // 必须放在所有条件分支之前，保证每次渲染调用相同数量的 hooks，否则 React 会抛出 "Should have a queue"。
    const paginated = useMemo(() => {
        const list = builtin.data ?? [];
        if (list.length === 0) return { items: [] as ServerListItem[], totalItems: 0, totalPages: 0, startIndex: 0, endIndex: 0 };
        const filtered = searchServers(list, debouncedSearch);
        const categorized = filterServersByCategory(filtered, category || '');
        const sorted = sortServers(categorized, sort || '');
        return paginateServers(sorted, page, pageSize);
    }, [builtin.data, debouncedSearch, category, sort, page, pageSize]);

    if (mcpConnId) {
        const res = platform.data ?? null;
        const items = (res?.items ?? []).map(mapPlatformServer);
        const total = res ? (res.pageInfo.total ?? res.items.length) : 0;
        const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 0;
        // 页码越界时 (page-1)*pageSize 会超过 total，导致分页器显示「101-100」这类反向区间，
        // 故把起始下标收敛到 total 以内。
        const rawStart = (page - 1) * pageSize;
        const startIndex = total > 0 ? Math.min(rawStart, Math.max(0, total - 1)) : 0;
        const endIndex = Math.min(rawStart + items.length, total);
        return {
            items,
            total,
            totalItems: total,
            totalPages,
            startIndex,
            endIndex,
            pagingMode: 'server',
            hasMore: false,
            isUnsupported: false,
            isLoading: platform.isLoading,
            isFetching: platform.isFetching,
            error: platform.error as Error | null,
            message: res?.message,
            refetch: platform.refetch,
        };
    }

    if (dataSource === 'smithery') {
        const res = smitheryPaged.data;
        if (!res) {
            return { items: [], total: 0, totalItems: 0, totalPages: 0, startIndex: 0, endIndex: 0, pagingMode: 'server', hasMore: false, isUnsupported: false, isLoading: smitheryPaged.isLoading, isFetching: smitheryPaged.isFetching, error: smitheryPaged.error as Error | null, refetch: smitheryPaged.refetch };
        }
        const items = res.items;
        const total = res.total ?? 0;
        const totalPages = res.totalPages ?? 0;
        const startIndex = total > 0 ? (page - 1) * pageSize : 0;
        const endIndex = Math.min((page - 1) * pageSize + items.length, total);
        return {
            items,
            total,
            totalItems: total,
            totalPages,
            startIndex,
            endIndex,
            pagingMode: 'server',
            hasMore: false,
            isUnsupported: false,
            isLoading: smitheryPaged.isLoading,
            isFetching: smitheryPaged.isFetching,
            error: smitheryPaged.error as Error | null,
            refetch: smitheryPaged.refetch,
        };
    }

    return {
        items: paginated.items,
        total: paginated.totalItems,
        totalItems: paginated.totalItems,
        totalPages: paginated.totalPages,
        startIndex: paginated.startIndex,
        endIndex: paginated.endIndex,
        pagingMode: 'client',
        hasMore: false,
        isUnsupported: false,
        isLoading: builtin.isLoading,
        isFetching: builtin.isFetching,
        error: builtin.error as Error | null,
        refetch: builtin.refetch,
    };
}
