import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {inferSkillCategoryId, type SkillListItem,} from '../api/registry';
import type {ApiConnection, PlatformSkillListItem} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
import type {StoreData, StoreResourceType} from './storeTypes';
import {STORE_QUERY_STALE_MS} from './storeTypes';

/** 将 Skill 源管理返回的 PlatformSkillListItem 映射为统一的 SkillListItem */
function mapPlatformSkill(item: PlatformSkillListItem): SkillListItem {
    const categoryId = item.category || inferSkillCategoryId(item.name);
    return {
        id: item.id,
        name: item.name,
        description: item.description || '',
        descriptions: item.descriptions,
        author: (item.extra?.author as string) || item.source,
        authorUrl: (item.extra?.authorUrl as string) || item.sourceUrl,
        downloadUrl: item.downloadUrl,
        category: item.categoryName ?? categoryId,
        categoryId,
        stars: item.stars ?? 0,
        forks: 0,
        viewCount: item.viewCount ?? null,
        downloads: item.downloads ?? null,
        updatedAt: item.updatedAt || new Date().toISOString(),
        repository: {url: item.downloadUrl || item.sourceUrl, branch: '', skillPath: ''},
        extra: item.extra,
    };
}

interface UseSkillsDataParams {
    resourceType: StoreResourceType;
    /** 当前选中的 Skill 源连接；为 null 时视为未选择来源 */
    selectedConn: ApiConnection | null;
    /** 是否为平台直连 Skill 源（非内置） */
    isDirectSkillSource: boolean;
    selectedSkillSourceId: string | null;
    page: number;
    pageSize: number;
    debouncedSearch: string;
    category?: string;
    sort?: string;
    /** S0-4: 强制刷新时绕过磁盘缓存拉取最新（默认 false 命中缓存秒开） */
    forceRefresh?: boolean;
}

/**
 * Skills 数据查询（统一收口）：
 * - 平台直连源（ModelScope / SkillHub / ClawHub 等）：服务端分页，按页查询；
 *   total 一律取自 pageInfo.total（各平台源均有真实总数），不存在"无总数的源"。
 *
 * 商店数据缓存 10 分钟（STORE_QUERY_STALE_MS）：切换页面 / 标签页 / 分页时直接命中缓存、
 * 立即渲染，避免重复等待在线请求；超过 10 分钟才判定过期并重新拉取。手动「刷新」按钮
 * 仍会强制绕过缓存重新请求。
 */
export function useSkillsData(params: UseSkillsDataParams): StoreData<SkillListItem> {
    const {resourceType, selectedConn, isDirectSkillSource, page, pageSize, debouncedSearch, category, sort} = params;
    const api = useElectronAPI();
    const enabled = resourceType === 'skills';

    const platform = useQuery({
        // S0-2: 补 pageSize —— 否则改每页条数只命中旧缓存、页码与数据不符
        queryKey: ['skillsPlatform', selectedConn?.id, debouncedSearch, page, pageSize, category, sort],
        queryFn: async () => {
            if (!selectedConn) return null;
            // 平台直连源走统一适配器通道（支持分类/排序）；回退旧通道保持兼容
            // S0-6: 透传连接 ID，主进程按 ID 精确取 token/baseUrl（多连接场景不再猜错）
            const res = await api.platforms.searchSkills(
                selectedConn.platformType, debouncedSearch, page, pageSize, category || 'all', sort || 'relevance',
                selectedConn?.id ?? undefined
            );
            return res;
        },
        // S1-11: 翻页时保留上一页数据作为占位，避免整页 Loading 跳动
        placeholderData: keepPreviousData,
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: enabled && isDirectSkillSource,
    });

    if (isDirectSkillSource && selectedConn) {
        const res = platform.data ?? null;
        const items = (res?.items ?? []).map(mapPlatformSkill);
        const total: number | null = res
            ? (res.pageInfo.total !== null && res.pageInfo.total !== undefined
                ? res.pageInfo.total
                : (res.serverTotal ?? null))
            : 0;
        const hasMore = res?.pageInfo?.hasMore ?? false;
        const totalPages = total !== null && total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : (hasMore ? page + 1 : 1);
        // 同 useMcpData：越界页把起始下标收敛到 total 以内，避免分页器显示反向区间
        const rawStart = (page - 1) * pageSize;
        const startIndex = total !== null && total > 0 ? Math.min(rawStart, Math.max(0, total - 1)) : 0;
        const endIndex = Math.min(rawStart + items.length, total ?? items.length);
        return {
            items,
            total,
            totalItems: total ?? items.length,
            totalPages,
            startIndex,
            endIndex,
            pagingMode: res?.pagingMode ?? 'server',
            hasMore,
            isUnsupported: res?.unsupported ?? false,
            isLoading: platform.isLoading,
            isFetching: platform.isFetching,
            error: platform.error as Error | null,
            message: res?.message,
            refetch: platform.refetch,
        };
    }

    return {
        items: [],
        total: 0,
        totalItems: 0,
        totalPages: 1,
        startIndex: 0,
        endIndex: 0,
        pagingMode: 'server',
        hasMore: false,
        isUnsupported: false,
        isLoading: platform.isLoading,
        isFetching: platform.isFetching,
        error: platform.error as Error | null,
        refetch: platform.refetch,
    };
}
