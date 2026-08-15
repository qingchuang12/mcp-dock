/**
 * Electron API 类型定义和访问
 */

import type {TokenMeta, TokenScope} from '../../../main/secret-store';
import type {ApiConnection} from '../../../main/connections-store';
import type {
    DirectSearchDiagnostics,
    PlatformSearchPage,
    PlatformServerDetail,
    PlatformServerSearchPage,
    PlatformSkillListItem,
} from '../../../main/platform-skill-resolver';
// 客户端类型统一从主进程 config-manager 引入，避免渲染端重复定义导致类型不兼容
import type {AnyClientId, ClientInfo, ClientType, CustomClientDef, SkillClientType} from '../../../main/config-manager';
import type {CloudSyncConfig, CloudSyncConfigInput, CloudSyncResult} from '../../../shared/cloud-sync-constants';
import {defaultCloudSyncConfig} from '../../../shared/cloud-sync-constants';

export {defaultCloudSyncConfig};

export type {
    CloudProvider,
    CloudSyncConfig,
    CloudSyncConfigInput,
    CloudSyncResult,
    GitCloudConfig,
    SftpCloudConfig,
} from '../../../shared/cloud-sync-constants';
export type {TokenMeta, TokenScope} from '../../../main/secret-store';
export type {ApiConnection, PlatformType} from '../../../main/connections-store';
export type {
    PlatformSkillListItem,
    DirectSearchDiagnostics,
    DirectSearchAttempt,
    PlatformServerListItem,
    PlatformServerSearchPage,
    PlatformServerDetail,
    PlatformSearchPage,
    PlatformPageInfo,
} from '../../../main/platform-skill-resolver';

export interface McpServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    type?: 'stdio' | 'http' | 'streamable-http' | 'sse';
    headers?: Record<string, string>;
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
    skillCount: number;
    clients: AnyClientId[];
}

export interface DiffResult {
    added: string[];
    removed: string[];
    modified: string[];
    current: any;
    backup: any;
    skillsAdded: string[];
    skillsRemoved: string[];
}

export type {ClientType, SkillClientType, ClientInfo, AnyClientId, CustomClientDef};

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

export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

export interface McpApi {
    connect: (sessionId: string, config: {
        command: string;
        args?: string[];
        env?: Record<string, string>
    }) => Promise<{ success: boolean; serverInfo?: { name?: string; version?: string }; error?: string }>;
    disconnect: (sessionId: string) => Promise<{ success: boolean }>;
    isConnected: (sessionId: string) => Promise<boolean>;
    listTools: (sessionId: string) => Promise<{ success: boolean; tools?: McpTool[]; error?: string }>;
    callTool: (sessionId: string, name: string, args: Record<string, unknown>) => Promise<{
        success: boolean;
        result?: unknown;
        error?: string
    }>;
    listResources: (sessionId: string) => Promise<{ success: boolean; resources?: unknown[]; error?: string }>;
    listPrompts: (sessionId: string) => Promise<{ success: boolean; prompts?: unknown[]; error?: string }>;
    onStderr: (callback: (data: { sessionId: string; message: string }) => void) => () => void;
    onDisconnected: (callback: (data: { sessionId: string; code: number }) => void) => () => void;
    onError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
}

interface ElectronAPI {
    clients: {
        getAll: (force?: boolean) => Promise<ClientInfo[]>;
        setCustomPath: (client: AnyClientId, customPath: string | null) => Promise<void>;
        setCustomSkillsPath: (client: SkillClientType, customPath: string | null) => Promise<void>;
        /** 添加用户手动客户端（并指定配置文件位置） */
        addCustom: (input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }) => Promise<CustomClientDef>;
        /** 删除用户手动客户端 */
        removeCustom: (id: string) => Promise<void>;
    };
    config: {
        read: (client?: AnyClientId) => Promise<any>;
        write: (config: any, client?: AnyClientId) => Promise<void>;
        getServers: (client?: AnyClientId) => Promise<Record<string, McpServerConfig>>;
        getAllServers: () => Promise<AllServersResult>;
        installServer: (serverId: string, serverConfig: McpServerConfig, clients: AnyClientId[]) => Promise<InstallResult>;
        uninstallServer: (serverId: string, clients: AnyClientId[]) => Promise<InstallResult>;
        updateServer: (serverId: string, serverConfig: McpServerConfig, client?: AnyClientId) => Promise<void>;
        /** 标记 MCP server 为「手动安装」（编辑保存后调用，避免线上商店更新覆盖本地调整） */
        markServerManual: (serverId: string) => Promise<void>;
        /** 获取所有被标记为「手动安装」的 MCP server id 列表 */
        getManualServers: () => Promise<string[]>;
        syncServer: (serverId: string, sourceClient: AnyClientId, targetClients: AnyClientId[]) => Promise<InstallResult>;
        syncServersBatch: (items: {
            serverId: string;
            config: McpServerConfig
        }[], targetClients: AnyClientId[]) => Promise<{
            synced: number;
            failed: number;
            details: { serverId: string; success: AnyClientId[]; failed: AnyClientId[] }[]
        }>;
    };
    env: {
        checkRuntime: (runtime: 'node' | 'python') => Promise<RuntimeInfo>;
        getAllRuntimes: () => Promise<AllRuntimes>;
        getNpxPath: () => Promise<string>;
        getUvxPath: () => Promise<string>;
    };
    history: {
        list: () => Promise<BackupInfo[]>;
        restore: (timestamp: string) => Promise<boolean>;
        getDiff: (timestamp: string) => Promise<DiffResult | null>;
        clearAll: () => Promise<boolean>;
    };
    system: {
        getPlatform: () => Promise<string>;
        getVersion: () => Promise<string>;
        openExternal: (url: string) => Promise<void>;
        getConfigPath: (client?: AnyClientId) => Promise<string>;
        openConfigDirectory: (client: AnyClientId) => Promise<string>;
        openSkillsDirectory: (client: SkillClientType) => Promise<string>;
    };
    skills: {
        getInstalled: (client: SkillClientType) => Promise<InstalledSkill[]>;
        getAllInstalled: () => Promise<AllSkillsResult>;
        install: (skillId: string, sourceInfo: SkillSourceMeta, clients: SkillClientType[]) => Promise<SkillInstallResult>;
        uninstall: (skillName: string, clients: SkillClientType[]) => Promise<void>;
        update: (skillName: string, client: SkillClientType) => Promise<{ updated: boolean; error?: string }>;
        updateAll: (client: SkillClientType) => Promise<{ updated: number; failed: number }>;
        isInstalled: (skillId: string) => Promise<boolean>;
        parseImportUrl: (url: string) => Promise<ImportParseResult>;
        resolvePlatformUrl: (url: string) => Promise<ImportParseResult>;
        installFromDiscovered: (skill: DiscoveredSkill, clients: SkillClientType[]) => Promise<SkillInstallResult>;
        getLocalDetail: (skillId: string) => Promise<LocalSkillDetail | null>;
        /** 创建本地自定义 Skill（无网络） */
        createCustom: (input: CustomSkillInput, clients: SkillClientType[]) => Promise<CreateCustomSkillResult>;
        /** 更新本地自定义 Skill（改写 SKILL.md，可重命名） */
        updateCustom: (originalName: string, input: CustomSkillInput, clients: SkillClientType[]) => Promise<CreateCustomSkillResult>;
        /** 读取本地 Skill 的 SKILL.md（解析 frontmatter 与正文，用于编辑回填） */
        readSkillMd: (skillName: string, client: SkillClientType) => Promise<{
            name: string;
            description: string;
            body: string
        } | null>;
        /** 从本地 .zip / .skill 文件或目录解析 Skill（用于「我的库」上传创建） */
        importFromFile: (filePath: string) => Promise<ImportSkillFileResult>;
        /** 打开系统对话框选择一个已解压的 skill 文件夹 */
        pickFolder: () => Promise<{ canceled: boolean; path?: string }>;
        /** 远程 GitHub Registry skill 详情：解析仓库并取回首个 Skill 的源 / SKILL.md（替代渲染端抛错的 fetchSkillDetail 桩） */
        getRemoteDetail: (githubPath: string) => Promise<{
            success: boolean;
            skill: DiscoveredSkill | null;
            error: string | null
        }>;
        sync: (skillName: string, sourceClient: SkillClientType, targetClients: SkillClientType[]) => Promise<SkillSyncResult>;
        syncBatch: (items: Array<{
            name: string;
            sourceClient: SkillClientType
        }>, targetClients: SkillClientType[]) => Promise<SkillBatchSyncResult>;
    };
    // API 令牌管理
    apiTokens: {
        list: () => Promise<TokenMeta[]>;
        create: (name: string, scopes: TokenScope[], expiresAt: number | null) => Promise<TokenMeta>;
        import: (rawKey: string, name: string, platform?: string, expiresAt?: number | null) => Promise<TokenMeta>;
        reveal: (id: string) => Promise<string | null>;
        revoke: (id: string) => Promise<TokenMeta | null>;
        restore: (id: string) => Promise<TokenMeta | null>;
        delete: (id: string) => Promise<void>;
    };
    // API 直连管理
    apiConnections: {
        /** 列出连接；传 kind 只返回该类型（'mcp' | 'skill'） */
        list: (kind?: 'mcp' | 'skill') => Promise<ApiConnection[]>;
        create: (conn: Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'>) => Promise<ApiConnection>;
        update: (conn: ApiConnection) => Promise<ApiConnection>;
        delete: (id: string) => Promise<void>;
        verify: (id: string) => Promise<ApiConnection>;
        export: (id?: string) => Promise<string>;
        searchPlatform: (connectionId: string, query: string, page: number, pageSize?: number) => Promise<PlatformSkillListItem[]>;
        /** 分页搜索：返回条目 + 平台分页元信息（total/totalPages/hasMore） */
        searchPlatformPaged: (connectionId: string, query: string, page: number, pageSize?: number, category?: string) => Promise<PlatformSearchPage>;
        /** 平台 MCP server 分页搜索（如 ModelScope MCP 广场），返回条目 + 分页元信息 */
        searchPlatformServersPaged: (connectionId: string, query: string, page: number, pageSize?: number, category?: string) => Promise<PlatformServerSearchPage>;
        /** 获取平台 MCP server 详情（含安装配置 / README），如 ModelScope */
        getServerDetail: (connectionId: string, serverId: string) => Promise<PlatformServerDetail>;
        /** 取回最近一次直连搜索的端点探测诊断（无结果时用于展示原因） */
        searchDiagnostics: (connectionId: string) => Promise<DirectSearchDiagnostics | null>;
        resolveSkill: (connectionId: string, sourceUrl: string) => Promise<any>;
        /** 将某连接设为默认来源 */
        setDefault: (id: string) => Promise<ApiConnection>;
        /** 启用 / 禁用某连接 */
        setEnabled: (id: string, enabled: boolean) => Promise<ApiConnection>;
        /** 恢复被删除的内置 MCP 源（official / smithery） */
        restoreBuiltinMcp: () => Promise<ApiConnection[]>;
        /** 恢复被删除的内置 Skill 源（GitHub Registry） */
        restoreBuiltinSkill: () => Promise<ApiConnection[]>;
    };
    // 云同步（Git / SFTP）：把云端存储当作一个客户端
    cloudSync: {
        getConfig: () => Promise<CloudSyncConfig>;
        setConfig: (patch: CloudSyncConfigInput) => Promise<CloudSyncConfig>;
        test: () => Promise<CloudSyncResult>;
        push: () => Promise<CloudSyncResult>;
        pull: () => Promise<CloudSyncResult>;
        onPulled: (callback: (result: CloudSyncResult) => void) => () => void;
    };
    // MCP Inspector
    mcp: McpApi;
    // 本地持久化缓存（落盘 ~/.ai-tools/cache/，用于 store 列表 SWR 秒开）
    cache: {
        get: <T>(key: string) => Promise<{
            data: T;
            cachedAt: number;
            expiresAt: number;
            version: string;
            etag?: string
        } | null>;
        set: <T>(key: string, data: T, etag?: string) => Promise<void>;
        getMeta: (key: string) => Promise<{ cachedAt: number; expiresAt: number; version: string; exists: boolean }>;
        isExpired: (key: string) => Promise<boolean>;
        has: (key: string) => Promise<boolean>;
        delete: (key: string) => Promise<void>;
        clear: () => Promise<void>;
        clearByPrefix: (prefix: 'official' | 'smithery' | 'skills') => Promise<void>;
        getStats: () => Promise<{
            totalFiles: number;
            totalSize: number;
            indexCaches: string[];
            detailCaches: number;
            encrypted: boolean
        }>;
        getDirectory: () => Promise<string>;
    };
    // 自定义标题栏：窗口控制（Windows / Linux 无边框窗口）
    window: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
    };
    // 系统主题跟随：主进程 nativeTheme 变化时回调（auto 模式用于实时刷新）
    theme: {
        onSystemThemeChange: (callback: (shouldUseDarkColors: boolean) => void) => () => void;
    };
}

// 获取 Electron API
export function getElectronAPI(): ElectronAPI | null {
    if (typeof window !== 'undefined' && 'electronAPI' in window) {
        return (window as any).electronAPI as ElectronAPI;
    }
    return null;
}

// 检查是否在 Electron 环境中
export function isElectron(): boolean {
    return getElectronAPI() !== null;
}

// Mock API for development in browser
const mockAPI: ElectronAPI = {
    clients: {
        getAll: async () => [
            {
                id: 'cursor',
                name: 'Cursor',
                installed: true,
                configPath: '~/.cursor/mcp.json',
                configExists: true,
                supportsSkills: true,
                skillsPath: '~/.cursor/skills'
            },
            {
                id: 'claude-code',
                name: 'Claude Code',
                installed: true,
                configPath: '~/.claude/mcp.json',
                configExists: true,
                supportsSkills: true,
                skillsPath: '~/.claude/skills'
            },
            {
                id: 'gemini-cli',
                name: 'Gemini CLI',
                installed: false,
                configPath: '~/.gemini/settings.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.gemini/skills'
            },
            {
                id: 'codex-cli',
                name: 'Codex CLI',
                installed: false,
                configPath: '~/.codex/config.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.codex/skills'
            },
            {
                id: 'windsurf',
                name: 'Windsurf',
                installed: false,
                configPath: '~/.windsurf/mcp.json',
                configExists: false,
                supportsSkills: false
            },
            {
                id: 'zed',
                name: 'Zed',
                installed: true,
                configPath: '~/.config/zed/settings.json',
                configExists: false,
                supportsSkills: false
            },
            {
                id: 'trae',
                name: 'TRAE',
                installed: false,
                configPath: '~/.trae/mcp.json',
                configExists: false,
                supportsSkills: false
            },
            {
                id: 'marscode',
                name: 'TRAE Plugin',
                installed: false,
                configPath: '~/.marscode/IDEA.mcp.config.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.marscode/skills'
            },
            {
                id: 'opencode',
                name: 'Opencode',
                installed: false,
                configPath: '~/.config/opencode/opencode.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.config/opencode/skills'
            },
            {
                id: 'codebuddy',
                name: 'CodeBuddy',
                installed: false,
                configPath: '~/.codebuddy/mcp.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.codebuddy/skills'
            },
            {
                id: 'workbuddy',
                name: 'WorkBuddy',
                installed: false,
                configPath: '~/.workbuddy/mcp.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.workbuddy/skills'
            },
            {
                id: 'qoder',
                name: 'Qoder',
                installed: false,
                configPath: '~/.qoder/mcp.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.qoder/skills'
            },
            {
                id: 'cloud',
                name: '云端存储',
                installed: false,
                configPath: '~/.ai-tools/cloud/ai-tools/mcp/mcp.json',
                configExists: false,
                supportsSkills: true,
                skillsPath: '~/.ai-tools/cloud/ai-tools/skills'
            },
        ],
        setCustomPath: async () => {
        },
        setCustomSkillsPath: async () => {
        },
        addCustom: async (input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }) => ({
            id: `custom:${(input.name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            name: input.name,
            configPath: input.configPath,
            supportsSkills: !!input.supportsSkills,
            skillsPath: input.supportsSkills ? input.skillsPath : undefined,
        }),
        removeCustom: async () => {
        },
    },
    config: {
        read: async () => ({mcpServers: {}}),
        write: async () => {
        },
        getServers: async () => ({}),
        getAllServers: async () => ({
            servers: {},
            byClient: {
                cursor: {},
                vscode: {},
                'claude-code': {},
                'gemini-cli': {},
                'codex-cli': {},
                windsurf: {},
                zed: {},
                trae: {},
                'trae-cn': {},
                marscode: {},
                kiro: {},
                opencode: {},
                jetbrains: {},
                antigravity: {},
                openclaw: {},
                codebuddy: {},
                workbuddy: {},
                qoder: {},
                cloud: {}

            }
        }),
        installServer: async (_, __, clients) => ({success: clients, failed: []}),
        uninstallServer: async (_, clients) => ({success: clients, failed: []}),
        updateServer: async () => {
        },
        markServerManual: async () => {
        },
        getManualServers: async () => [],
        syncServer: async (_, __, targets) => ({success: targets, failed: []}),
        syncServersBatch: async (items, targets) => ({
            synced: items.length,
            failed: 0,
            details: items.map(i => ({serverId: i.serverId, success: targets, failed: []}))
        }),
    },
    env: {
        checkRuntime: async () => ({available: true, version: '20.0.0', path: '/usr/local/bin/node'}),
        getAllRuntimes: async () => ({
            node: {available: true, version: '20.0.0', path: '/usr/local/bin/node'},
            python: {available: true, version: '3.11.0', path: '/usr/bin/python3'},
            npx: {available: true, version: '10.0.0', path: '/usr/local/bin/npx'},
            uvx: {available: false, version: null, path: null},
            git: {available: true, version: '2.43.0', path: '/usr/bin/git'},
        }),
        getNpxPath: async () => 'npx',
        getUvxPath: async () => 'uvx',
    },
    history: {
        list: async () => [],
        restore: async () => true,
        getDiff: async () => null,
        clearAll: async () => true,
    },
    system: {
        getPlatform: async () => 'darwin',
        getVersion: async () => '1.0.0-dev',
        openExternal: async (url) => {
            window.open(url, '_blank');
        },
        getConfigPath: async () => '~/Library/Application Support/Claude/claude_desktop_config.json',
        openConfigDirectory: async () => '',
        openSkillsDirectory: async () => '',
    },
    skills: {
        getInstalled: async () => [],
        getAllInstalled: async () => ({
            skills: {},
            byClient: {
                cursor: [],
                'claude-code': [],
                'gemini-cli': [],
                'codex-cli': [],
                opencode: [],
                'agent-skills': [],
                codebuddy: [],
                workbuddy: [],
                qoder: [],
                marscode: [],
                cloud: []
            }
        }),
        install: async () => ({success: true}),
        uninstall: async () => {
        },
        update: async () => ({updated: true}),
        updateAll: async () => ({updated: 0, failed: 0}),
        isInstalled: async () => false,
        parseImportUrl: async () => ({success: false, skills: [], error: 'Not available in browser'}),
        resolvePlatformUrl: async () => ({success: false, skills: [], error: 'Not available in browser'}),
        installFromDiscovered: async () => ({success: true}),
        createCustom: async (input) => ({success: true, skillName: input.name}),
        updateCustom: async (originalName) => ({success: true, skillName: originalName}),
        readSkillMd: async (skillName) => ({name: skillName, description: '', body: ''}),
        importFromFile: async () => ({success: false, error: 'Not available in browser'}),
        pickFolder: async () => ({canceled: true}),
        getLocalDetail: async () => null,
        getRemoteDetail: async () => ({success: false, skill: null, error: 'Not available in browser'}),
        sync: async () => ({success: [], failed: [], errors: {}}),
        syncBatch: async () => ({synced: 0, failed: 0, details: []}),
    },
    apiTokens: {
        list: async () => [],
        create: async (name) => ({
            id: 'tok_mock',
            name,
            scopes: [],
            expiresAt: null,
            createdAt: Date.now(),
            revoked: false,
            preview: 'mock'
        }),
        import: async (_, name, platform) => ({
            id: 'tok_mock',
            name,
            scopes: [],
            expiresAt: null,
            createdAt: Date.now(),
            revoked: false,
            preview: 'mock',
            platform,
            kind: 'imported'
        }),
        reveal: async () => null,
        revoke: async () => null,
        restore: async () => null,
        delete: async () => {
        },
    },
    apiConnections: {
        list: async () => [],
        create: async (conn) => ({
            ...conn,
            id: 'conn_mock',
            createdAt: Date.now(),
            status: 'unverified',
            lastCheckedAt: null
        }),
        update: async (conn) => conn,
        delete: async () => {
        },
        verify: async (conn: any) => ({...conn, status: 'unverified'} as ApiConnection),
        export: async () => '{}',
        searchPlatform: async () => [],
        searchPlatformPaged: async () => ({
            items: [],
            pageInfo: {page: 1, pageSize: 20, total: 0, totalPages: 0, hasMore: false},
        }),
        searchPlatformServersPaged: async () => ({
            items: [],
            pageInfo: {page: 1, pageSize: 20, total: 0, totalPages: 0, hasMore: false},
        }),
        getServerDetail: async () => {
            throw new Error('Not available in browser');
        },
        searchDiagnostics: async () => null,
        resolveSkill: async () => ({success: false, skills: [], error: 'Not available in browser'}),
        setDefault: async (id: string) => ({id, isDefault: true} as ApiConnection),
        setEnabled: async (id: string, enabled: boolean) => ({id, enabled} as ApiConnection),
        restoreBuiltinMcp: async () => [],
        restoreBuiltinSkill: async () => [],
    },
    cloudSync: {
        getConfig: async () => defaultCloudSyncConfig(),
        setConfig: async () => defaultCloudSyncConfig(),
        test: async () => ({ok: false, message: 'Not available in browser'}),
        push: async () => ({ok: false, message: 'Not available in browser'}),
        pull: async () => ({ok: false, message: 'Not available in browser'}),
        onPulled: () => () => {},
    },
    mcp: {
        connect: async () => ({success: false, error: 'Not available in browser'}),
        disconnect: async () => ({success: false}),
        isConnected: async () => false,
        listTools: async () => ({success: false, tools: [], error: 'Not available in browser'}),
        callTool: async () => ({success: false, error: 'Not available in browser'}),
        listResources: async () => ({success: false, resources: [], error: 'Not available in browser'}),
        listPrompts: async () => ({success: false, prompts: [], error: 'Not available in browser'}),
        onStderr: () => () => {
        },
        onDisconnected: () => () => {
        },
        onError: () => () => {
        },
    },
    cache: {
        get: async () => null,
        set: async () => {
        },
        getMeta: async () => ({cachedAt: 0, expiresAt: 0, version: '', exists: false}),
        isExpired: async () => true,
        has: async () => false,
        delete: async () => {
        },
        clear: async () => {
        },
        clearByPrefix: async () => {
        },
        getStats: async () => ({totalFiles: 0, totalSize: 0, indexCaches: [], detailCaches: 0, encrypted: false}),
        getDirectory: async () => '',
    },
    window: {
        minimize: () => {
        },
        toggleMaximize: () => {
        },
        close: () => {
        },
        isMaximized: async () => false,
        onMaximizeChange: () => () => {
        },
    },
    theme: {
        onSystemThemeChange: () => () => {
        },
    },
};

// 获取 API (自动回退到 Mock)
export function useElectronAPI(): ElectronAPI {
    return getElectronAPI() || mockAPI;
}
