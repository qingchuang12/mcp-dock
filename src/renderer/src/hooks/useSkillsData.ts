import {useQuery} from '@tanstack/react-query';
import {
    fetchSkillsList,
    inferSkillCategoryId,
    type SkillListItem,
} from '../api/registry';
import {useElectronAPI} from '../lib/electron';
import type {ApiConnection, PlatformSkillListItem} from '../lib/electron';
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
        author: item.source,
        authorUrl: item.sourceUrl,
        downloadUrl: item.downloadUrl,
        category: categoryId,
        categoryId,
        stars: item.stars ?? 0,
        forks: 0,
        updatedAt: item.updatedAt || new Date().toISOString(),
        repository: {url: item.downloadUrl || item.sourceUrl, branch: '', skillPath: ''},
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
    const {resourceType, selectedConn, isDirectSkillSource, selectedSkillSourceId, page, pageSize, debouncedSearch} = params;
    const api = useElectronAPI();
    const enabled = resourceType === 'skills';

    const github = useQuery({
        queryKey: ['skillsGithub', selectedSkillSourceId || 'github'],
        queryFn: async () => {
            return fetchSkillsList(undefined, true);
        },
        // 数据缓存 10 分钟：卸载后保留缓存，重新进入直接命中；过期才重新拉取
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        // 仅在数据过期（>10min）时重新拉取，未过期直接命中缓存即时渲染
        refetchOnMount: true,
        enabled: enabled && !isDirectSkillSource,
    });

    const platform = useQuery({
        queryKey: ['skillsPlatform', selectedConn?.id, debouncedSearch, page],
        queryFn: async () => {
            if (!selectedConn) return null;
            const res = await api.apiConnections.searchPlatformPaged(
                selectedConn.id, debouncedSearch, page, pageSize, ''
            );
            return res;
        },
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: enabled && isDirectSkillSource,
    });

    if (isDirectSkillSource && selectedConn) {
        const res = platform.data ?? null;
        const items = (res?.items ?? []).map(mapPlatformSkill);
        const total = res ? (res.pageInfo.total ?? res.serverTotal ?? items.length) : 0;
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
            isUnsupported: res?.unsupported ?? false,
            isLoading: platform.isLoading,
            isFetching: platform.isFetching,
            error: platform.error as Error | null,
            message: res?.message,
            refetch: platform.refetch,
        };
    }

    const list = github.data ?? [];
    const filtered = debouncedSearch
        ? list.filter(skill =>
            skill.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
            (skill.description || '').toLowerCase().includes(debouncedSearch.toLowerCase()) ||
            skill.author.toLowerCase().includes(debouncedSearch.toLowerCase()))
        : list;
    const total = filtered.length;
    const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 0;
    const startIdx = (page - 1) * pageSize;
    const items = filtered.slice(startIdx, startIdx + pageSize);
    const startIndex = total > 0 ? startIdx + 1 : 0;
    const endIndex = Math.min(startIdx + pageSize, total);
    return {
        items,
        total,
        totalItems: total,
        totalPages,
        startIndex,
        endIndex,
        pagingMode: 'client',
        isUnsupported: false,
        isLoading: github.isLoading,
        isFetching: github.isFetching,
        error: github.error as Error | null,
        refetch: github.refetch,
    };
}
