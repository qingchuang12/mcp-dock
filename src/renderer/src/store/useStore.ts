/**
 * Zustand Store
 * 全局状态管理
 */

import {create} from 'zustand';
import {persist} from 'zustand/middleware';
import type {DataSource, ResourceType, ServerListItem} from '../api/registry';
import type {TokenMeta} from '../lib/electron';

// Inspector 配置状态
interface InspectorState {
    command: string;
    args: string;
    envVars: { key: string; value: string }[];
}

interface StoreState {
    // 资源类型 (MCP Servers / Skills)
    resourceType: ResourceType;
    setResourceType: (type: ResourceType) => void;

    // 数据源
    dataSource: DataSource;
    setDataSource: (source: DataSource) => void;

    // 搜索
    searchQuery: string;
    setSearchQuery: (query: string) => void;

    // 分页
    currentPage: number;
    pageSize: number;
    setCurrentPage: (page: number) => void;
    setPageSize: (size: number) => void;

    // 服务器列表缓存 (按数据源分开)
    serverLists: Record<DataSource, ServerListItem[]>;
    setServerList: (source: DataSource, list: ServerListItem[]) => void;

    // 已安装服务器 ID 列表 (用于快速查询)
    installedServerIds: Set<string>;
    setInstalledServerIds: (ids: string[]) => void;
    addInstalledServerId: (id: string) => void;
    removeInstalledServerId: (id: string) => void;

    // 已安装 Skills ID 列表
    installedSkillIds: Set<string>;
    setInstalledSkillIds: (ids: string[]) => void;
    addInstalledSkillId: (id: string) => void;
    removeInstalledSkillId: (id: string) => void;

    // MCP 平台源直连连接 ID（从详情返回时需保留）
    mcpConnId: string | null;
    setMcpConnId: (id: string | null) => void;

    // API 令牌共享列表（设置页三个卡片共用，避免新增令牌后源管理下拉不同步）
    tokens: TokenMeta[];
    setTokens: (tokens: TokenMeta[]) => void;

    // Skills 源选择（从详情返回时需保留）
    selectedSkillSourceId: string | null;
    setSelectedSkillSourceId: (id: string | null) => void;

    // Inspector 状态
    inspectorState: InspectorState;
    setInspectorState: (state: Partial<InspectorState>) => void;

    // 主题（浅色 / 暗色 / 跟随系统）
    theme: ThemeMode;
    setTheme: (theme: ThemeMode) => void;

    // 重置分页
    resetPagination: () => void;
}

// 主题模式
export type ThemeMode = 'light' | 'dark' | 'auto';

// 有效的数据源值
const VALID_DATA_SOURCES = ['official', 'smithery'] as const;
const VALID_RESOURCE_TYPES = ['mcp', 'skills'] as const;
const VALID_THEMES = ['light', 'dark', 'auto'] as const;

export const useStore = create<StoreState>()(
    persist(
        (set) => ({
            // 资源类型 - 默认 MCP
            resourceType: 'mcp',
            setResourceType: (type) => set({
                resourceType: type,
                currentPage: 1,
                searchQuery: ''
            }),

            // 数据源 - 默认使用 Official
            dataSource: 'official',
            setDataSource: (source) => set({
                dataSource: source,
                currentPage: 1,
                searchQuery: ''
            }),

            // 搜索
            searchQuery: '',
            setSearchQuery: (query) => set({searchQuery: query, currentPage: 1}),

            // 分页
            currentPage: 1,
            pageSize: 20,
            setCurrentPage: (page) => set({currentPage: page}),
            setPageSize: (size) => set({pageSize: size, currentPage: 1}),

            // 服务器列表 (按数据源分开)
            serverLists: {
                official: [],
                smithery: [],
            },
            setServerList: (source, list) => set((state) => ({
                serverLists: {
                    ...state.serverLists,
                    [source]: list,
                },
            })),

            // 已安装服务器
            installedServerIds: new Set(),
            setInstalledServerIds: (ids) => set({installedServerIds: new Set(ids)}),
            addInstalledServerId: (id) => set((state) => {
                const newSet = new Set(state.installedServerIds);
                newSet.add(id);
                return {installedServerIds: newSet};
            }),
            removeInstalledServerId: (id) => set((state) => {
                const newSet = new Set(state.installedServerIds);
                newSet.delete(id);
                return {installedServerIds: newSet};
            }),

            // 已安装 Skills
            installedSkillIds: new Set(),
            setInstalledSkillIds: (ids) => set({installedSkillIds: new Set(ids)}),
            addInstalledSkillId: (id) => set((state) => {
                const newSet = new Set(state.installedSkillIds);
                newSet.add(id);
                return {installedSkillIds: newSet};
            }),
            removeInstalledSkillId: (id) => set((state) => {
                const newSet = new Set(state.installedSkillIds);
                newSet.delete(id);
                return {installedSkillIds: newSet};
            }),

            // MCP 平台源直连连接 ID
            mcpConnId: null,
            setMcpConnId: (id) => set({mcpConnId: id}),

            // API 令牌共享列表
            tokens: [],
            setTokens: (tokens) => set({tokens}),

            // Skills 源选择
            selectedSkillSourceId: null,
            setSelectedSkillSourceId: (id) => set({selectedSkillSourceId: id}),

            // Inspector 状态
            inspectorState: {
                command: 'npx',
                args: '',
                envVars: [],
            },
            setInspectorState: (newState) => set((state) => ({
                inspectorState: {
                    ...state.inspectorState,
                    ...newState,
                },
            })),

            // 主题 - 默认跟随系统（auto）
            theme: 'auto',
            setTheme: (theme) => set({theme}),

            // 重置分页
            resetPagination: () => set({currentPage: 1, searchQuery: ''}),
        }),
        {
            name: 'mcp-dock-store',
            partialize: (state) => ({
                // 持久化数据源选择、资源类型、页面大小和主题
                dataSource: state.dataSource,
                resourceType: state.resourceType,
                pageSize: state.pageSize,
                mcpConnId: state.mcpConnId,
                selectedSkillSourceId: state.selectedSkillSourceId,
                theme: state.theme,
            }),
            // 合并恢复的状态时验证值的有效性
            merge: (persistedState, currentState) => {
                const persisted = persistedState as Partial<StoreState> | undefined;
                return {
                    ...currentState,
                    // 验证 dataSource，无效则使用默认值
                    dataSource: persisted?.dataSource && VALID_DATA_SOURCES.includes(persisted.dataSource as any)
                        ? persisted.dataSource
                        : 'official',
                    // 验证 resourceType，无效则使用默认值
                    resourceType: persisted?.resourceType && VALID_RESOURCE_TYPES.includes(persisted.resourceType as any)
                        ? persisted.resourceType
                        : 'mcp',
                    // 验证 pageSize
                    pageSize: persisted?.pageSize && typeof persisted.pageSize === 'number' && persisted.pageSize > 0
                        ? persisted.pageSize
                        : 20,
                    // 验证 theme
                    theme: persisted?.theme && VALID_THEMES.includes(persisted.theme as any)
                        ? persisted.theme
                        : 'auto',
                };
            },
        }
    )
);