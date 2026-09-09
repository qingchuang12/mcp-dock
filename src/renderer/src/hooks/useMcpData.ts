import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {fetchSmitheryServersPaged, type ServerListItem,} from '../api/registry';
import type {PlatformServerListItem} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
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
    /** 选中的 MCP 平台连接 ID；为 null 时走内置源（smithery） */
    mcpConnId: string | null;
    /** 平台直连源类型（如 'modelscope'），用于统一适配器通道 */
    platformType?: string;
    page: number;
    pageSize: number;
    debouncedSearch: string;
    category?: string;
    sort?: string;
    source?: string;
}

/**
 * MCP 数据查询（统一收口）：
 * - 内置源（smithery）：服务端分页，按需按页拉取，进入不再全量加载。
 * - 平台源（ModelScope 等）：服务端分页，按页查询；total 取自 pageInfo.total。
 *
 * 商店数据缓存 10 分钟（STORE_QUERY_STALE_MS）：切换页面 / 标签页 / 分页时直接命中缓存、
 * 立即渲染，避免重复等待在线请求；超过 10 分钟才判定过期并重新拉取。手动「刷新」按钮
 * 仍会强制绕过缓存重新请求。
 */
export function useMcpData(params: UseMcpDataParams): StoreData<ServerListItem> {
    const {resourceType, mcpConnId, platformType, page, pageSize, debouncedSearch, category, sort, source} = params;
    const api = useElectronAPI();
    const enabled = resourceType === 'mcp';

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
        enabled: enabled && !mcpConnId,
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

    // 内置源（smithery）：服务端分页
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
