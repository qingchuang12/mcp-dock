import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import type {ApiConnection, CategoryNode, PlatformFacets, SortOption} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
import type {DataSource} from '../api/registry';
import {SMITHERY_CATEGORY_IDS} from '../api/registry';
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

/** smithery 官方分类中文名（All 由前端默认空 category 表示，故不在列；名称固定、不依赖 i18n） */
const SMITHERY_CATEGORY_LABELS: Record<string, string> = {
    'web-search': '网络搜索',
    'browser-automation': '浏览器自动化',
    'academic-research': '学术研究',
    finance: '金融',
    reasoning: '推理',
    'dev-tools': '开发工具',
};

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
    /** 当前选中的 MCP 连接的 platformType（S0-1：必须用 MCP 连接而非 Skill 源连接） */
    mcpPlatformType?: string | null;
    selectedConn: ApiConnection | null;
    isDirectSkillSource: boolean;
    /** 当前内置数据源（smithery）；smithery 不支持前端分类/排序，抑制 facets 以免误导 */
    dataSource?: DataSource;
}

/**
 * 拉取当前数据源的分类/排序/来源面元数据。
 * - 平台直连源：调用 platforms.facets（adapter 提供真实分类树 + 排序 + 来源）
 * - 内置源（smithery 等）：返回 9 类本地推断分类 + 通用排序
 *
 * 返回 null 表示当前数据源无分类（如未选择连接）。
 */
export function useStoreFacets(params: UseStoreFacetsParams): PlatformFacets | null {
    const {resourceType, mcpConnId, mcpPlatformType, selectedConn, isDirectSkillSource, dataSource} = params;
    const api = useElectronAPI();
    const {t, i18n} = useTranslation();

    // 平台直连源（MCP 或 Skills）
    // S0-1: MCP 分支必须用「MCP 连接」的 platformType，原先误用了 Skill 源连接，导致拿到空分类。
    const platformType = resourceType === 'mcp' ? (mcpPlatformType ?? null) : selectedConn?.platformType;
    const platformConnId = resourceType === 'mcp' ? mcpConnId : selectedConn?.id;
    const isPlatformSource = !!platformConnId && (resourceType === 'mcp' || isDirectSkillSource);

    return useQuery({
        // S2-9: platformType 现已成为独立输入，必须纳入 queryKey 才能正确缓存/失效
        queryKey: ['storeFacets', resourceType, platformType, platformConnId, i18n.language],
        queryFn: async (): Promise<PlatformFacets> => {
            if (isPlatformSource && platformType) {
                const facets = await api.platforms.facets(platformType, resourceType);
                return {
                    ...facets,
                    categories: facets.categories ? translateCategoryTree(facets.categories, t, i18n) : [],
                    sortOptions: facets.sortOptions ? translateSortOptions(facets.sortOptions, t, i18n) : [],
                };
            }
            // 内置源：smithery 用官方 7 分类（All 由默认空 category 表示全量）；内置源用本地 9 类 + 通用排序
            // S0-3: smithery 服务端不支持排序参数，排序仍抑制（避免无效排序控件），分类走语义搜索词（见 SMITHERY_CATEGORY_QUERIES）
            if (dataSource === 'smithery') {
                return {
                    categories: SMITHERY_CATEGORY_IDS.map(id => ({id, name: SMITHERY_CATEGORY_LABELS[id] ?? id})),
                    sortOptions: [],
                    supportsSubcategories: false,
                };
            }
            return {
                categories: BUILTIN_CATEGORY_IDS.map(id => ({id, name: t(`mcpCategory.${id}`)})),
                sortOptions: BUILTIN_SORT_IDS.map(id => ({id, name: t(`storeSort.${id}`), field: id === 'updated' ? 'updatedAt' : id, order: 'desc' as const})),
                supportsSubcategories: false,
            };
        },
        staleTime: STORE_QUERY_STALE_MS,
        gcTime: STORE_QUERY_STALE_MS,
        refetchOnMount: true,
        enabled: true,
    }).data ?? null;
}