import type {ApiConnection} from '../lib/electron';
import type {DataSource, ServerListItem, SkillListItem} from '../api/registry';
import {useMcpData} from './useMcpData';
import {useSkillsData} from './useSkillsData';
import type {StoreData, StoreResourceType} from './storeTypes';

interface UseStoreDataParams {
    resourceType: StoreResourceType;
    /** 选中的 MCP 平台连接 ID；为 null 时走内置源 */
    mcpConnId: string | null;
    /** 内置 MCP 源类型（official/smithery） */
    dataSource: DataSource;
    /** 当前选中的 Skill 源连接（含 github 内置） */
    selectedConn: ApiConnection | null;
    /** 是否为平台直连 Skill 源 */
    isDirectSkillSource: boolean;
    selectedSkillSourceId: string | null;
    page: number;
    pageSize: number;
    debouncedSearch: string;
    /** 分类筛选（平台源透传；内置源前端切片） */
    category?: string;
    /** 排序选项 id */
    sort?: string;
    /** 来源过滤（如百炼 source slug） */
    source?: string;
    /** S0-4: 强制刷新时绕过磁盘缓存拉取最新（透传给 Skills 内置源） */
    forceRefresh?: boolean;
}

/**
 * 商店数据查询对外唯一入口：按 resourceType 分派到 MCP / Skills 各自的 hook。
 * 两个 hook 都无条件调用（遵守 React hooks 规则），由 resourceType 决定返回哪一个。
 */
export function useStoreData(params: UseStoreDataParams): StoreData<ServerListItem | SkillListItem> {
    const mcp = useMcpData({
        resourceType: params.resourceType,
        mcpConnId: params.mcpConnId,
        platformType: params.selectedConn?.platformType,
        dataSource: params.dataSource,
        page: params.page,
        pageSize: params.pageSize,
        debouncedSearch: params.debouncedSearch,
        category: params.category,
        sort: params.sort,
        source: params.source,
    });
    const skills = useSkillsData({
        resourceType: params.resourceType,
        selectedConn: params.selectedConn,
        isDirectSkillSource: params.isDirectSkillSource,
        selectedSkillSourceId: params.selectedSkillSourceId,
        page: params.page,
        pageSize: params.pageSize,
        debouncedSearch: params.debouncedSearch,
        category: params.category,
        sort: params.sort,
        forceRefresh: params.forceRefresh,
    });
    return params.resourceType === 'mcp' ? mcp : skills;
}
