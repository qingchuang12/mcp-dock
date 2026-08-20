import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import type {ApiConnection, CategoryNode, PlatformFacets, SortOption} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
import type {StoreResourceType} from './storeTypes';
import {STORE_QUERY_STALE_MS} from './storeTypes';

/** 8 类统一分类 ID 列表（名称通过 i18n 翻译） */
const BUILTIN_CATEGORY_IDS = [
    'coding',
    'testing',
    'devops',
    'data-analytics',
    'security',
    'content-writing',
    'productivity',
    'design',
];

const BUILTIN_SORT_IDS = ['relevance', 'stars', 'updated'] as const;

/** 通过 i18n 翻译平台分类树（递归处理子节点） */
function translateCategoryTree(categories: CategoryNode[], t: (key: string) => string, i18n: {exists: (key: string) => boolean}): CategoryNode[] {
    return categories.map(c => ({
        ...c,
        name: i18n.exists(`platformCategory.${c.id}`)
            ? t(`platformCategory.${c.id}`)
            : (i18n.exists(`mcpCategory.${c.id}`) ? t(`mcpCategory.${c.id}`) : c.name),
        children: c.children ? translateCategoryTree(c.children, t, i18n) : undefined,
    }));
}

/** 通过 i18n 翻译平台排序选项 */
function translateSortOptions(sorts: SortOption[], t: (key: string) => string, i18n: {exists: (key: string) => boolean}): SortOption[] {
    return sorts.map(s => ({
        ...s,
        name: i18n.exists(`storeSort.${s.id}`) ? t(`storeSort.${s.id}`) : s.name,
    }));
}

export interface UseStoreFacetsParams {
    resourceType: StoreResourceType;
    mcpConnId: string | null;
    selectedConn: ApiConnection | null;
    isDirectSkillSource: boolean;
}

/**
 * 拉取当前数据源的分类/排序/来源面元数据。
 * - 平台直连源：调用 platforms.facets（adapter 提供真实分类树 + 排序 + 来源）
 * - 内置源（GitHub/official/smithery）：返回 9 类本地推断分类 + 通用排序
 *
 * 返回 null 表示当前数据源无分类（如未选择连接）。
 */
export function useStoreFacets(params: UseStoreFacetsParams): PlatformFacets | null {
    const {resourceType, mcpConnId, selectedConn, isDirectSkillSource} = params;
    const api = useElectronAPI();
    const {t, i18n} = useTranslation();

    // 平台直连源（MCP 或 Skills）
    const platformType = resourceType === 'mcp' ? selectedConn?.platformType : selectedConn?.platformType;
    const platformConnId = resourceType === 'mcp' ? mcpConnId : selectedConn?.id;
    const isPlatformSource = !!platformConnId && (resourceType === 'mcp' || isDirectSkillSource);

    return useQuery({
        queryKey: ['storeFacets', resourceType, platformConnId, i18n.language],
        queryFn: async (): Promise<PlatformFacets> => {
            if (isPlatformSource && platformType) {
                const facets = await api.platforms.facets(platformType);
                return {
                    ...facets,
                    categories: facets.categories ? translateCategoryTree(facets.categories, t, i18n) : [],
                    sortOptions: facets.sortOptions ? translateSortOptions(facets.sortOptions, t, i18n) : [],
                };
            }
            // 内置源：本地 9 类 + 通用排序（名称通过 i18n 翻译）
            return {
                categories: BUILTIN_CATEGORY_IDS.map(id => ({id, name: t(`mcpCategory.${id}`)})),
                sortOptions: BUILTIN_SORT_IDS.map(id => ({id, name: t(`storeSort.${id}`), field: id === 'updated' ? 'updatedAt' : id, order: 'desc' as const})),
                supportsSubcategories: false,
            };
        },
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: resourceType === 'mcp' ? true : true,
    }).data ?? null;
}