import {useMemo, useRef} from 'react';
import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {fetchSkillsList, inferSkillCategoryId, type SkillListItem,} from '../api/registry';
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
    /** 当前选中的 Skill 源连接（含 github 内置）；为 null 时视为内置源 */
    selectedConn: ApiConnection | null;
    /** 是否为平台直连 Skill 源（非 GitHub Registry 内置） */
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
 * - 内置源（GitHub Registry）：一次性全量拉取 + 前端搜索/切片。
 * - 平台直连源（ModelScope / SkillHub / ClawHub 等）：服务端分页，按页查询；
 *   total 一律取自 pageInfo.total（各平台源均有真实总数），不存在"无总数的源"。
 *
 * 商店数据缓存 10 分钟（STORE_QUERY_STALE_MS）：切换页面 / 标签页 / 分页时直接命中缓存、
 * 立即渲染，避免重复等待在线请求；超过 10 分钟才判定过期并重新拉取。手动「刷新」按钮
 * 仍会强制绕过缓存重新请求。
 */
export function useSkillsData(params: UseSkillsDataParams): StoreData<SkillListItem> {
    const {resourceType, selectedConn, isDirectSkillSource, page, pageSize, debouncedSearch, category, sort, forceRefresh} = params;
    const api = useElectronAPI();
    const enabled = resourceType === 'skills';

    // S0-4: 强制刷新时绕过磁盘缓存拉取最新。ref 在每次渲染同步更新，保证 refetch 时 queryFn 读到最新开关
    const noCacheRef = useRef<boolean>(forceRefresh ?? false);
    noCacheRef.current = forceRefresh ?? false;

    const github = useQuery({
        queryKey: ['skillsGithub'],
        queryFn: async () => {
            // 复用磁盘缓存 SWR：首屏命中缓存秒开，仅缓存过期（>10min）或手动刷新（noCacheRef）才打 GitHub。
            // S0-4 修复：原先写死 noCache=false，导致「刷新」按钮只转圈不拉新数据。
            return fetchSkillsList(undefined, noCacheRef.current);
        },
        // 数据缓存 10 分钟：卸载后保留缓存，重新进入直接命中；过期才重新拉取
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: enabled && !isDirectSkillSource,
    });

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

    // S1-10: 内置源全量列表原先每次渲染同步重算过滤/排序/分页。包一层 useMemo 仅在数据或筛选条件变化时重算。
    // 必须放在所有条件分支之前，保证每次渲染调用相同数量的 hooks，否则 React 会抛出 "Should have a queue"。
    const builtinPaginated = useMemo(() => {
        const list = github.data ?? [];
        if (list.length === 0) return { items: [] as SkillListItem[], total: 0, totalPages: 0, startIndex: 0, endIndex: 0 };
        const filtered = list.filter(skill => {
            const matchQ = !debouncedSearch ||
                skill.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
                (skill.description || '').toLowerCase().includes(debouncedSearch.toLowerCase()) ||
                skill.author.toLowerCase().includes(debouncedSearch.toLowerCase());
            const matchCat = !category || category === 'all' || skill.categoryId === category;
            return matchQ && matchCat;
        });
        const sorted = [...filtered];
        if (sort && sort !== 'relevance') {
            if (sort === 'stars') {
                sorted.sort((a, b) => (b.stars || 0) - (a.stars || 0));
            } else if (sort === 'updated') {
                sorted.sort((a, b) => {
                    const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                    const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                    return db - da;
                });
            }
        }
        const totalItems = sorted.length;
        const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 0;
        const startIdx = (page - 1) * pageSize;
        const items = sorted.slice(startIdx, startIdx + pageSize);
        const startIndex = totalItems > 0 ? startIdx : 0;
        const endIndex = Math.min(startIdx + pageSize, totalItems);
        return { items, total: totalItems, totalPages, startIndex, endIndex };
    }, [github.data, debouncedSearch, category, sort, page, pageSize]);

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
        items: builtinPaginated.items,
        total: builtinPaginated.total,
        totalItems: builtinPaginated.total,
        totalPages: builtinPaginated.totalPages,
        startIndex: builtinPaginated.startIndex,
        endIndex: builtinPaginated.endIndex,
        pagingMode: 'client',
        hasMore: false,
        isUnsupported: false,
        isLoading: github.isLoading,
        isFetching: github.isFetching,
        error: github.error as Error | null,
        refetch: github.refetch,
    };
}
