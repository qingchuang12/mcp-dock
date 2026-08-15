/**
 * Electron Preload 脚本
 * 安全地暴露主进程 API 给渲染进程
 */

import {contextBridge, ipcRenderer} from 'electron';
import type {TokenMeta, TokenScope} from '../main/secret-store';
import type {ApiConnection} from '../main/connections-store';
import type {
    PlatformSearchPage,
    PlatformServerDetail,
    PlatformServerSearchPage,
    PlatformSkillListItem
} from '../main/platform-skill-resolver';
// 客户端类型统一从主进程 config-manager 引入，避免多端重复定义导致类型不兼容
import type {AnyClientId, ClientInfo, ClientType, CustomClientDef, SkillClientType} from '../main/config-manager';
import type {CloudSyncConfig, CloudSyncConfigInput, CloudSyncResult} from '../shared/cloud-sync-constants';

// 类型定义
export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface RuntimeInfo {
    available: boolean;
    version: string | null;
    path: string | null;
}

export interface AllRuntimes {
    node: RuntimeInfo;
    python: RuntimeInfo;
    npx: RuntimeInfo;
    uvx: RuntimeInfo;
    /** git：云同步的 Git 通道依赖系统 git CLI */
    git: RuntimeInfo;
}

export interface BackupInfo {
    timestamp: string;
    filename: string;
    size: number;
    serverCount: number;
}

export interface DiffResult {
    added: string[];
    removed: string[];
    modified: string[];
    current: any;
    backup: any;
}

export type {ClientType, SkillClientType, ClientInfo};

// Skills 相关类型
export interface SkillSourceMeta {
    id: string;
    installedAt: string;
    updatedAt: string;
    source: {
        repositoryUrl: string;
        branch: string;
        skillPath: string;
        rawBaseUrl: string;
    };
    files: string[];
}

export interface InstalledSkill {
    name: string;
    path: string;
    source: SkillSourceMeta | null;
    hasUpdate?: boolean;
}

export interface SkillInstallResult {
    success: boolean;
    error?: string;
}

export interface CustomSkillInput {
    name: string;
    description: string;
    body: string;
}

export interface CreateCustomSkillResult {
    success: boolean;
    error?: string;
    skillName?: string;
}

export interface SkillSyncResult {
    success: SkillClientType[];
    failed: SkillClientType[];
    errors: Record<string, string>;
}

export interface SkillBatchSyncResult {
    synced: number;
    failed: number;
    details: Array<{
        name: string;
        success: SkillClientType[];
        failed: SkillClientType[];
    }>;
}

export interface DiscoveredSkill {
    name: string;
    path: string;
    skillMdUrl: string;
    skillMdContent: string;
    files: Array<{ name: string; path: string; rawUrl: string }>;
    repository: {
        url: string;
        branch: string;
        owner: string;
        repo: string;
    };
    downloadUrl?: string;
}

export interface LocalSkillDetail {
    found: boolean;
    name: string;
    skillMdContent: string;
    source: SkillSourceMeta | null;
    files: string[];
    clients: SkillClientType[];
}

export interface ImportParseResult {
    success: boolean;
    skills: DiscoveredSkill[];
    error?: string;
}

export interface ImportSkillFileResult {
    success: boolean;
    name?: string;
    description?: string;
    body?: string;
    error?: string;
}

export interface AllSkillsResult {
    skills: Record<string, { name: string; clients: SkillClientType[] }>;
    byClient: Record<SkillClientType, InstalledSkill[]>;
}

export interface InstallResult {
    success: AnyClientId[];
    failed: AnyClientId[];
}

export interface AllServersResult {
    servers: Record<string, { config: McpServerConfig; clients: AnyClientId[] }>;
    byClient: Record<string, Record<string, McpServerConfig>>;
}

// 缓存相关类型
export type CacheKey =
    | 'official-index'
    | 'smithery-index'
    | 'skills-index'
    | `official-detail-${string}`
    | `smithery-detail-${string}`
    | `skills-detail-${string}`;

export interface CacheEntry<T = unknown> {
    data: T;
    cachedAt: number;
    expiresAt: number;
    version: string;
    etag?: string;
}

export interface CacheMeta {
    cachedAt: number;
    expiresAt: number;
    version: string;
    exists: boolean;
}

export interface CacheStats {
    totalFiles: number;
    totalSize: number;
    indexCaches: string[];
    detailCaches: number;
    encrypted: boolean;  // 是否加密存储
}

export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

// API 定义
const api = {
    // 客户端管理
    clients: {
        getAll: (force?: boolean): Promise<ClientInfo[]> => ipcRenderer.invoke('clients:get-all', force),
        setCustomPath: (client: AnyClientId, customPath: string | null): Promise<void> =>
            ipcRenderer.invoke('clients:set-custom-path', client, customPath),
        setCustomSkillsPath: (client: SkillClientType, customPath: string | null): Promise<void> =>
            ipcRenderer.invoke('clients:set-custom-skills-path', client, customPath),
        addCustom: (input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }): Promise<CustomClientDef> =>
            ipcRenderer.invoke('clients:add-custom', input),
        removeCustom: (id: string): Promise<void> =>
            ipcRenderer.invoke('clients:remove-custom', id),
    },

    // 配置管理
    config: {
        read: (client?: AnyClientId): Promise<any> => ipcRenderer.invoke('config:read', client),
        write: (config: any, client?: AnyClientId): Promise<void> =>
            ipcRenderer.invoke('config:write', config, client),
        getServers: (client?: AnyClientId): Promise<Record<string, McpServerConfig>> =>
            ipcRenderer.invoke('config:get-servers', client),
        getAllServers: (): Promise<AllServersResult> =>
            ipcRenderer.invoke('config:get-all-servers'),
        installServer: (serverId: string, serverConfig: McpServerConfig, clients: AnyClientId[]): Promise<InstallResult> =>
            ipcRenderer.invoke('config:install-server', serverId, serverConfig, clients),
        uninstallServer: (serverId: string, clients: AnyClientId[]): Promise<InstallResult> =>
            ipcRenderer.invoke('config:uninstall-server', serverId, clients),
        updateServer: (serverId: string, serverConfig: McpServerConfig, client?: AnyClientId): Promise<void> =>
            ipcRenderer.invoke('config:update-server', serverId, serverConfig, client),
        markServerManual: (serverId: string): Promise<void> =>
            ipcRenderer.invoke('config:mark-server-manual', serverId),
        getManualServers: (): Promise<string[]> =>
            ipcRenderer.invoke('config:get-manual-servers'),
        syncServer: (serverId: string, sourceClient: AnyClientId, targetClients: AnyClientId[]): Promise<InstallResult> =>
            ipcRenderer.invoke('config:sync-server', serverId, sourceClient, targetClients),
        syncServersBatch: (items: {
            serverId: string;
            config: McpServerConfig
        }[], targetClients: AnyClientId[]): Promise<{
            synced: number;
            failed: number;
            details: { serverId: string; success: AnyClientId[]; failed: AnyClientId[] }[]
        }> =>
            ipcRenderer.invoke('config:sync-servers-batch', items, targetClients),
    },

    // 环境检测
    env: {
        checkRuntime: (runtime: 'node' | 'python'): Promise<RuntimeInfo> =>
            ipcRenderer.invoke('env:check-runtime', runtime),
        getAllRuntimes: (): Promise<AllRuntimes> =>
            ipcRenderer.invoke('env:get-all-runtimes'),
        getNpxPath: (): Promise<string> =>
            ipcRenderer.invoke('env:get-npx-path'),
        getUvxPath: (): Promise<string> =>
            ipcRenderer.invoke('env:get-uvx-path'),
    },

    // 历史记录
    history: {
        list: (): Promise<BackupInfo[]> =>
            ipcRenderer.invoke('history:list'),
        restore: (timestamp: string): Promise<boolean> =>
            ipcRenderer.invoke('history:restore', timestamp),
        getDiff: (timestamp: string): Promise<DiffResult | null> =>
            ipcRenderer.invoke('history:get-diff', timestamp),
        clearAll: (): Promise<boolean> =>
            ipcRenderer.invoke('history:clear-all'),
    },

    // 系统
    system: {
        getPlatform: (): Promise<string> =>
            ipcRenderer.invoke('system:get-platform'),
        getVersion: (): Promise<string> =>
            ipcRenderer.invoke('system:get-version'),
        openExternal: (url: string): Promise<void> =>
            ipcRenderer.invoke('system:open-external', url),
        getConfigPath: (client?: AnyClientId): Promise<string> =>
            ipcRenderer.invoke('system:get-config-path', client),
        openConfigDirectory: (client: AnyClientId): Promise<string> =>
            ipcRenderer.invoke('system:open-config-directory', client),
        openSkillsDirectory: (client: SkillClientType): Promise<string> =>
            ipcRenderer.invoke('system:open-skills-directory', client),
    },

    // Skills 管理
    skills: {
        getInstalled: (client: SkillClientType): Promise<InstalledSkill[]> =>
            ipcRenderer.invoke('skills:get-installed', client),
        getAllInstalled: (): Promise<AllSkillsResult> =>
            ipcRenderer.invoke('skills:get-all-installed'),
        install: (skillId: string, sourceInfo: SkillSourceMeta, clients: SkillClientType[]): Promise<SkillInstallResult> =>
            ipcRenderer.invoke('skills:install', skillId, sourceInfo, clients),
        uninstall: (skillName: string, clients: SkillClientType[]): Promise<void> =>
            ipcRenderer.invoke('skills:uninstall', skillName, clients),
        update: (skillName: string, client: SkillClientType): Promise<{ updated: boolean; error?: string }> =>
            ipcRenderer.invoke('skills:update', skillName, client),
        updateAll: (client: SkillClientType): Promise<{ updated: number; failed: number }> =>
            ipcRenderer.invoke('skills:update-all', client),
        isInstalled: (skillId: string): Promise<boolean> =>
            ipcRenderer.invoke('skills:is-installed', skillId),
        parseImportUrl: (url: string): Promise<ImportParseResult> =>
            ipcRenderer.invoke('skills:parse-import-url', url),
        resolvePlatformUrl: (url: string): Promise<ImportParseResult> =>
            ipcRenderer.invoke('skills:resolve-platform-url', url),
        installFromDiscovered: (skill: DiscoveredSkill, clients: SkillClientType[]): Promise<SkillInstallResult> =>
            ipcRenderer.invoke('skills:install-from-discovered', skill, clients),
        createCustom: (input: CustomSkillInput, clients: SkillClientType[]): Promise<CreateCustomSkillResult> =>
            ipcRenderer.invoke('skills:create-custom', input, clients),
        updateCustom: (originalName: string, input: CustomSkillInput, clients: SkillClientType[]): Promise<CreateCustomSkillResult> =>
            ipcRenderer.invoke('skills:update-custom', originalName, input, clients),
        readSkillMd: (skillName: string, client: SkillClientType): Promise<{
            name: string;
            description: string;
            body: string
        } | null> =>
            ipcRenderer.invoke('skills:read-skill-md', skillName, client),
        importFromFile: (filePath: string): Promise<ImportSkillFileResult> =>
            ipcRenderer.invoke('skills:import-file', filePath),
        /** 打开系统对话框选择一个已解压的 skill 文件夹 */
        pickFolder: (): Promise<{ canceled: boolean; path?: string }> =>
            ipcRenderer.invoke('skills:pick-folder'),
        getLocalDetail: (skillId: string): Promise<LocalSkillDetail | null> =>
            ipcRenderer.invoke('skills:get-local-detail', skillId),
        getRemoteDetail: (githubPath: string): Promise<{
            success: boolean;
            skill: DiscoveredSkill | null;
            error: string | null
        }> =>
            ipcRenderer.invoke('skills:get-remote-detail', githubPath),
        sync: (skillName: string, sourceClient: SkillClientType, targetClients: SkillClientType[]): Promise<SkillSyncResult> =>
            ipcRenderer.invoke('skills:sync', skillName, sourceClient, targetClients),
        syncBatch: (items: Array<{
            name: string;
            sourceClient: SkillClientType
        }>, targetClients: SkillClientType[]): Promise<SkillBatchSyncResult> =>
            ipcRenderer.invoke('skills:sync-batch', items, targetClients),
    },

    // API 令牌管理
    apiTokens: {
        list: (): Promise<TokenMeta[]> =>
            ipcRenderer.invoke('api-tokens:list'),
        create: (name: string, scopes: TokenScope[], expiresAt: number | null): Promise<TokenMeta> =>
            ipcRenderer.invoke('api-tokens:create', name, scopes, expiresAt),
        import: (rawKey: string, name: string, platform?: string, expiresAt?: number | null): Promise<TokenMeta> =>
            ipcRenderer.invoke('api-tokens:import', rawKey, name, platform, expiresAt),
        reveal: (id: string): Promise<string | null> =>
            ipcRenderer.invoke('api-tokens:reveal', id),
        revoke: (id: string): Promise<TokenMeta | null> =>
            ipcRenderer.invoke('api-tokens:revoke', id),
        restore: (id: string): Promise<TokenMeta | null> =>
            ipcRenderer.invoke('api-tokens:restore', id),
        delete: (id: string): Promise<void> =>
            ipcRenderer.invoke('api-tokens:delete', id),
    },

    // API 直连管理
    apiConnections: {
        list: (kind?: 'mcp' | 'skill'): Promise<ApiConnection[]> =>
            ipcRenderer.invoke('api-connections:list', kind),
        create: (conn: Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'>): Promise<ApiConnection> =>
            ipcRenderer.invoke('api-connections:create', conn),
        update: (conn: ApiConnection): Promise<ApiConnection> =>
            ipcRenderer.invoke('api-connections:update', conn),
        delete: (id: string): Promise<void> =>
            ipcRenderer.invoke('api-connections:delete', id),
        verify: (id: string): Promise<ApiConnection> =>
            ipcRenderer.invoke('api-connections:verify', id),
        export: (id?: string): Promise<string> =>
            ipcRenderer.invoke('api-connections:export', id),
        searchPlatform: (connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformSkillListItem[]> =>
            ipcRenderer.invoke('api-connections:search-platform', connectionId, query, page, pageSize, category),
        searchPlatformPaged: (connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformSearchPage> =>
            ipcRenderer.invoke('api-connections:search-platform-paged', connectionId, query, page, pageSize, category),
        searchPlatformServersPaged: (connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformServerSearchPage> =>
            ipcRenderer.invoke('api-connections:search-servers-paged', connectionId, query, page, pageSize, category),
        getServerDetail: (connectionId: string, serverId: string): Promise<PlatformServerDetail> =>
            ipcRenderer.invoke('api-connections:get-server-detail', connectionId, serverId),
        searchDiagnostics: (connectionId: string): Promise<any> =>
            ipcRenderer.invoke('api-connections:search-diagnostics', connectionId),
        resolveSkill: (connectionId: string, sourceUrl: string): Promise<any> =>
            ipcRenderer.invoke('api-connections:resolve-skill', connectionId, sourceUrl),
        setDefault: (id: string): Promise<ApiConnection> =>
            ipcRenderer.invoke('api-connections:set-default', id),
        setEnabled: (id: string, enabled: boolean): Promise<ApiConnection> =>
            ipcRenderer.invoke('api-connections:set-enabled', id, enabled),
        restoreBuiltinMcp: (): Promise<ApiConnection[]> =>
            ipcRenderer.invoke('api-connections:restore-builtin-mcp'),
        restoreBuiltinSkill: (): Promise<ApiConnection[]> =>
            ipcRenderer.invoke('api-connections:restore-builtin-skill'),
    },

    // 云同步（Git / SFTP）
    cloudSync: {
        getConfig: (): Promise<CloudSyncConfig> =>
            ipcRenderer.invoke('cloud-sync:get-config'),
        setConfig: (patch: CloudSyncConfigInput): Promise<CloudSyncConfig> =>
            ipcRenderer.invoke('cloud-sync:set-config', patch),
        test: (): Promise<CloudSyncResult> =>
            ipcRenderer.invoke('cloud-sync:test'),
        push: (): Promise<CloudSyncResult> =>
            ipcRenderer.invoke('cloud-sync:push'),
        pull: (): Promise<CloudSyncResult> =>
            ipcRenderer.invoke('cloud-sync:pull'),
        // 主进程启动后异步拉取云端完成时通知渲染层刷新（以云端为准覆盖本地暂存区）
        onPulled: (callback: (result: CloudSyncResult) => void): (() => void) => {
            const listener = (_e: unknown, result: CloudSyncResult) => callback(result);
            ipcRenderer.on('cloud-sync:pulled', listener);
            return () => ipcRenderer.removeListener('cloud-sync:pulled', listener);
        },
    },

    // MCP Inspector
    mcp: {
        connect: (sessionId: string, config: {
            command: string;
            args?: string[];
            env?: Record<string, string>
        }): Promise<{ success: boolean; serverInfo?: { name?: string; version?: string }; error?: string }> =>
            ipcRenderer.invoke('mcp:connect', sessionId, config),
        disconnect: (sessionId: string): Promise<{ success: boolean }> =>
            ipcRenderer.invoke('mcp:disconnect', sessionId),
        isConnected: (sessionId: string): Promise<boolean> =>
            ipcRenderer.invoke('mcp:is-connected', sessionId),
        listTools: (sessionId: string): Promise<{ success: boolean; tools?: McpTool[]; error?: string }> =>
            ipcRenderer.invoke('mcp:list-tools', sessionId),
        callTool: (sessionId: string, name: string, args: Record<string, unknown>): Promise<{
            success: boolean;
            result?: unknown;
            error?: string
        }> =>
            ipcRenderer.invoke('mcp:call-tool', sessionId, name, args),
        listResources: (sessionId: string): Promise<{ success: boolean; resources?: unknown[]; error?: string }> =>
            ipcRenderer.invoke('mcp:list-resources', sessionId),
        listPrompts: (sessionId: string): Promise<{ success: boolean; prompts?: unknown[]; error?: string }> =>
            ipcRenderer.invoke('mcp:list-prompts', sessionId),
        // 事件监听
        onStderr: (callback: (data: { sessionId: string; message: string }) => void) => {
            ipcRenderer.on('mcp:stderr', (_, data) => callback(data));
            return () => ipcRenderer.removeAllListeners('mcp:stderr');
        },
        onDisconnected: (callback: (data: { sessionId: string; code: number }) => void) => {
            ipcRenderer.on('mcp:disconnected', (_, data) => callback(data));
            return () => ipcRenderer.removeAllListeners('mcp:disconnected');
        },
        onError: (callback: (data: { sessionId: string; error: string }) => void) => {
            ipcRenderer.on('mcp:error', (_, data) => callback(data));
            return () => ipcRenderer.removeAllListeners('mcp:error');
        },
    },

    // 缓存管理 (SWR 本地持久化缓存)
    cache: {
        get: <T>(key: CacheKey): Promise<CacheEntry<T> | null> =>
            ipcRenderer.invoke('cache:get', key),
        set: <T>(key: CacheKey, data: T, etag?: string): Promise<void> =>
            ipcRenderer.invoke('cache:set', key, data, etag),
        getMeta: (key: CacheKey): Promise<CacheMeta> =>
            ipcRenderer.invoke('cache:get-meta', key),
        isExpired: (key: CacheKey): Promise<boolean> =>
            ipcRenderer.invoke('cache:is-expired', key),
        has: (key: CacheKey): Promise<boolean> =>
            ipcRenderer.invoke('cache:has', key),
        delete: (key: CacheKey): Promise<void> =>
            ipcRenderer.invoke('cache:delete', key),
        clear: (): Promise<void> =>
            ipcRenderer.invoke('cache:clear'),
        clearByPrefix: (prefix: 'official' | 'smithery' | 'skills'): Promise<void> =>
            ipcRenderer.invoke('cache:clear-by-prefix', prefix),
        getStats: (): Promise<CacheStats> =>
            ipcRenderer.invoke('cache:get-stats'),
        getDirectory: (): Promise<string> =>
            ipcRenderer.invoke('cache:get-directory'),
    },

    // 自定义标题栏：窗口控制（Windows / Linux 无边框窗口）
    window: {
        minimize: (): void =>
            ipcRenderer.send('window:minimize'),
        toggleMaximize: (): void =>
            ipcRenderer.send('window:toggle-maximize'),
        close: (): void =>
            ipcRenderer.send('window:close'),
        isMaximized: (): Promise<boolean> =>
            ipcRenderer.invoke('window:is-maximized'),
        onMaximizeChange: (callback: (maximized: boolean) => void): (() => void) => {
            const listener = (_e: unknown, maximized: boolean) => callback(maximized);
            ipcRenderer.on('window:maximize-changed', listener);
            return () => ipcRenderer.removeListener('window:maximize-changed', listener);
        },
    },

    // 系统主题跟随：主进程 nativeTheme 变化后推送，渲染进程据此重新计算 auto 主题
    theme: {
        onSystemThemeChange: (callback: (shouldUseDarkColors: boolean) => void): (() => void) => {
            const listener = (_e: unknown, shouldUseDarkColors: boolean) => callback(shouldUseDarkColors);
            ipcRenderer.on('theme:system-changed', listener);
            return () => ipcRenderer.removeListener('theme:system-changed', listener);
        },
    },
};

// 暴露 API 到渲染进程
contextBridge.exposeInMainWorld('electronAPI', api);

// 类型声明
export type ElectronAPI = typeof api;
