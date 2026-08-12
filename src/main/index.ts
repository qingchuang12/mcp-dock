/**
 * AI-Tools - Electron 主进程入口
 */

import {app, BrowserWindow, ipcMain, nativeTheme, session, shell} from 'electron';
import path from 'path';
import {ClientType, ConfigManager, SkillClientType} from './config-manager';
import {EnvManager} from './env-manager';
import {HistoryManager} from './history-manager';
import {DiscoveredSkill, SkillsManager, SkillSourceMeta} from './skills-manager';
import type {
    PlatformSearchPage,
    PlatformServerDetail,
    PlatformServerSearchPage,
    PlatformSkillListItem
} from './platform-skill-resolver';
import {
    fetchPlatformServerDetail,
    getLastDirectSearchDiagnostics,
    resolveDirectSkill,
    resolvePlatformSkillUrl,
    searchPlatformDirect,
    searchPlatformDirectPaged,
    searchPlatformServersPaged
} from './platform-skill-resolver';
import {getCacheManager} from './cache-manager';
import {getSecretStore, TokenMeta, TokenScope} from './secret-store';
import {ApiConnection, getConnectionsStore} from './connections-store';
import {createMcpClient, disconnectAllClients, getMcpClient, removeMcpClient} from './mcp-client';
import {getCloudSyncStore} from './cloud-sync-store';
import {getCloudSyncService} from './cloud-sync-service';
import type {CloudSyncConfig, CloudSyncConfigInput, CloudSyncResult} from '../shared/cloud-sync-constants';

// 管理器实例
const configManager = new ConfigManager();
const envManager = new EnvManager();
const historyManager = new HistoryManager();
const skillsManager = new SkillsManager();
const cacheManager = getCacheManager();
const secretStore = getSecretStore();
const connectionsStore = getConnectionsStore();
const cloudSyncStore = getCloudSyncStore();
const cloudSyncService = getCloudSyncService();

let mainWindow: BrowserWindow | null = null;

// 进程级兜底：避免未捕获的 Promise 拒绝 / 异常导致静默崩溃
process.on('unhandledRejection', (reason: unknown) => {
    console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err: Error) => {
    console.error('[uncaughtException]', err);
});

// 开发模式：明确设置了 NODE_ENV=development 或 VITE_DEV_SERVER_URL
const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;

function createWindow() {
    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';

    // 图标路径：根据平台和模式选择正确的图标文件
    // 开发模式: __dirname = mcp-dock-core/dist/main, build 在 ../../build
    // 生产模式: __dirname = app.asar/dist/main, build 在 app.asar/build (即 ../../build)
    const getIconPath = () => {
        const basePath = path.join(__dirname, '../../build');
        if (isMac) {
            return path.join(basePath, 'icon.icns');
        } else if (isWin) {
            return path.join(basePath, 'icon.ico');
        } else {
            return path.join(basePath, 'icon.png');
        }
    };

    mainWindow = new BrowserWindow({
        width: 1024,
        height: 700,
        minWidth: 900,
        minHeight: 600,
        icon: getIconPath(),
        // macOS 特有的标题栏样式
        ...(isMac ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: {x: 16, y: 18},
        } : {}),
        // Windows / Linux 使用无边框窗口 + 自定义标题栏，避免原生标题栏与深色界面割裂
        ...(isWin ? {
            frame: false,
            autoHideMenuBar: true,
        } : {}),
        backgroundColor: '#1c1c1e',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload', 'index.js'),
        },
    });

    // 开发模式加载 Vite 开发服务器
    if (isDev) {
        const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
        // 开发模式下移除 HTML 中的 CSP 限制，避免拦截 Vite 的 localhost/ws 模块与 HMR 连接导致黑屏
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [],
                },
            });
        });
        mainWindow.loadURL(devServerUrl);
        mainWindow.webContents.openDevTools();
    } else {
        // 生产模式加载打包后的文件
        mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 首屏加载完成后，向渲染进程推送一次当前系统主题（auto 模式下作为权威初始值，
    // 纠正 matchMedia 在部分平台初始读取不准确的情形）
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow?.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
    });

    // 自定义标题栏：广播窗口最大化状态变化（双击标题栏/拖拽到顶部/系统快照等触发）
    mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximize-changed', true));
    mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximize-changed', false));
    mainWindow.on('restore', () => mainWindow?.webContents.send('window:maximize-changed', false));

    // 外部链接在默认浏览器中打开
    mainWindow.webContents.setWindowOpenHandler(({url}) => {
        shell.openExternal(url);
        return {action: 'deny'};
    });
}

// 单一实例锁：避免重复启动产生多个窗口
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// 应用准备就绪
app.whenReady().then(() => {
    // ============================================================================
    // DNS 配置：使用安全的 DNS 服务器避免 DNS 污染
    // ============================================================================
    app.configureHostResolver({
        enableBuiltInResolver: true,
        secureDnsMode: 'secure',
        secureDnsServers: [
            'https://1.1.1.1/dns-query',      // Cloudflare DoH
            'https://8.8.8.8/dns-query',      // Google DoH
            'https://dns.alidns.com/dns-query' // 阿里 DoH（国内备用）
        ],
    });
    // macOS: 设置 Dock 图标（使用 PNG 格式，因为 dock.setIcon 不支持 icns）
    if (process.platform === 'darwin') {
        const dockIconPath = path.join(__dirname, '../../build/icon.png');
        try {
            if (app.dock) {
                app.dock.setIcon(dockIconPath);
            }
        } catch (e) {
            console.warn('Failed to set dock icon:', e);
        }
    }

    createWindow();

    // 启动后后台异步以云端为准拉取一次（覆盖本地暂存区），不阻塞启动。
    // 拉取完成（无论成败）通知渲染层刷新；仅在已配置云同步时执行。
    void (async () => {
        try {
            if (!getCloudSyncStore().isActive()) return;
            const res = await cloudSyncService.pull();
            mainWindow?.webContents.send('cloud-sync:pulled', res);
        } catch (e: any) {
            console.error('[CloudSync] startup pull error:', e?.message || e);
        }
    })();

    // 系统主题跟随：操作系统明暗切换时，经 nativeTheme 桥接通知渲染进程重新计算主题。
    // 渲染进程内 matchMedia 的 change 在 Electron 某些版本下不可靠（窗口失焦/未重绘时不触发），
    // 主进程 nativeTheme.on('updated') 是更权威、更及时的来源。
    nativeTheme.on('updated', () => {
        mainWindow?.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// 所有窗口关闭时退出应用 (macOS 除外)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        disconnectAllClients();
        app.quit();
    }
});

// 退出前兜底清理：MCP Inspector 的 spawn 子进程（shell:true 派生）若不杀干净，
// stdio 管道句柄会保持事件循环存活，导致主进程退出后仍残留。
app.on('before-quit', () => {
    disconnectAllClients();
    // 兜底：若仍有句柄阻止正常退出，1.5s 后强制退出
    const forceQuitTimer = setTimeout(() => app.exit(0), 1500);
    forceQuitTimer.unref?.();
});

// ============ IPC 处理器 ============

// 客户端管理
ipcMain.handle('clients:get-all', async (_, force?: boolean) => {
    return configManager.getAllClients(force);
});

// 配置管理
ipcMain.handle('config:read', async (_, client?: ClientType) => {
    return configManager.readConfig(client);
});

ipcMain.handle('config:write', async (_, config: any, client?: ClientType) => {
    await historyManager.backup();
    return configManager.writeConfig(config, client);
});

ipcMain.handle('config:get-servers', async (_, client?: ClientType) => {
    return configManager.getInstalledServers(client);
});

ipcMain.handle('config:get-all-servers', async () => {
    return configManager.getAllInstalledServers();
});

ipcMain.handle('config:install-server', async (_, serverId: string, serverConfig: any, clients: ClientType[]) => {
    await historyManager.backup();
    return configManager.installServer(serverId, serverConfig, clients);
});

ipcMain.handle('config:uninstall-server', async (_, serverId: string, clients: ClientType[]) => {
    await historyManager.backup();
    return configManager.uninstallServer(serverId, clients);
});

ipcMain.handle('config:update-server', async (_, serverId: string, serverConfig: any, client?: ClientType) => {
    await historyManager.backup();
    return configManager.updateServer(serverId, serverConfig, client);
});

// 标记 MCP server 为「手动安装」（编辑保存后调用，避免线上商店更新覆盖本地调整）
ipcMain.handle('config:mark-server-manual', async (_, serverId: string) => {
    return configManager.markMcpServerManual(serverId);
});

// 获取所有被标记为「手动安装」的 MCP server id 列表
ipcMain.handle('config:get-manual-servers', async (): Promise<string[]> => {
    return configManager.getManualMcpServers();
});

ipcMain.handle('config:sync-server', async (_, serverId: string, sourceClient: ClientType, targetClients: ClientType[]) => {
    await historyManager.backup();
    return configManager.syncServerToClients(serverId, sourceClient, targetClients);
});

ipcMain.handle('config:sync-servers-batch', async (_, items: {
    serverId: string;
    config: any
}[], targetClients: ClientType[]) => {
    await historyManager.backup();
    return configManager.syncServersToClients(items, targetClients);
});

// 环境检测
ipcMain.handle('env:check-runtime', async (_, runtime: 'node' | 'python') => {
    return envManager.checkRuntime(runtime);
});

ipcMain.handle('env:get-all-runtimes', async () => {
    return envManager.getAllRuntimes();
});

ipcMain.handle('env:get-npx-path', async () => {
    return envManager.getNpxPath();
});

ipcMain.handle('env:get-uvx-path', async () => {
    return envManager.getUvxPath();
});

// 历史记录
ipcMain.handle('history:list', async () => {
    return historyManager.listBackups();
});

ipcMain.handle('history:restore', async (_, timestamp: string) => {
    return historyManager.restore(timestamp);
});

ipcMain.handle('history:get-diff', async (_, timestamp: string) => {
    return historyManager.getDiff(timestamp);
});

ipcMain.handle('history:clear-all', async () => {
    return historyManager.clearAll();
});

// 系统信息
ipcMain.handle('system:get-platform', () => {
    return process.platform;
});

ipcMain.handle('system:get-version', () => {
    return app.getVersion();
});

ipcMain.handle('system:open-external', async (_, url: string) => {
    return shell.openExternal(url);
});

// 自定义标题栏：窗口控制（Windows / Linux 无边框窗口）
ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
});

ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('window:close', () => {
    mainWindow?.close();
});

ipcMain.handle('window:is-maximized', () => {
    return mainWindow?.isMaximized() ?? false;
});

ipcMain.handle('system:get-config-path', (_, client?: ClientType) => {
    return configManager.getConfigPath(client);
});

ipcMain.handle('clients:set-custom-path', async (_, client: ClientType, customPath: string | null) => {
    return configManager.setCustomConfigPath(client, customPath);
});

// 添加用户手动客户端（并指定配置文件位置）
ipcMain.handle('clients:add-custom', async (_, input: { name: string; configPath: string; supportsSkills?: boolean; skillsPath?: string }) => {
    return configManager.addCustomClient(input);
});

// 删除用户手动客户端
ipcMain.handle('clients:remove-custom', async (_, id: string) => {
    return configManager.removeCustomClient(id);
});

// 打开配置文件所在目录
ipcMain.handle('system:open-config-directory', async (_, client: ClientType) => {
    const configPath = configManager.getConfigPath(client);
    const dir = require('path').dirname(configPath);
    return shell.openPath(dir);
});

// ============ MCP Inspector IPC 处理器 ============

// 连接到 MCP Server
ipcMain.handle('mcp:connect', async (_, sessionId: string, config: {
    command: string;
    args?: string[];
    env?: Record<string, string>
}) => {
    try {
        const client = createMcpClient(sessionId);

        // 设置事件监听
        client.on('stderr', (message: string) => {
            mainWindow?.webContents.send('mcp:stderr', {sessionId, message});
        });

        client.on('disconnected', (code: number) => {
            mainWindow?.webContents.send('mcp:disconnected', {sessionId, code});
        });

        client.on('error', (error: Error) => {
            mainWindow?.webContents.send('mcp:error', {sessionId, error: error.message});
        });

        const serverInfo = await client.connect(config);
        return {success: true, serverInfo};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 断开连接
ipcMain.handle('mcp:disconnect', async (_, sessionId: string) => {
    removeMcpClient(sessionId);
    return {success: true};
});

// 获取连接状态
ipcMain.handle('mcp:is-connected', async (_, sessionId: string) => {
    const client = getMcpClient(sessionId);
    return client?.isConnected() || false;
});

// 获取工具列表
ipcMain.handle('mcp:list-tools', async (_, sessionId: string) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const tools = await client.listTools();
        return {success: true, tools};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 调用工具
ipcMain.handle('mcp:call-tool', async (_, sessionId: string, name: string, args: Record<string, unknown>) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const result = await client.callTool(name, args);
        return {success: true, result};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 获取资源列表
ipcMain.handle('mcp:list-resources', async (_, sessionId: string) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const resources = await client.listResources();
        return {success: true, resources};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// 获取 Prompt 列表
ipcMain.handle('mcp:list-prompts', async (_, sessionId: string) => {
    try {
        const client = getMcpClient(sessionId);
        if (!client) {
            return {success: false, error: 'Not connected'};
        }
        const prompts = await client.listPrompts();
        return {success: true, prompts};
    } catch (error) {
        return {success: false, error: (error as Error).message};
    }
});

// ============ Skills IPC 处理器 ============

// 获取指定客户端的已安装 Skills
ipcMain.handle('skills:get-installed', async (_, client: SkillClientType) => {
    return skillsManager.getInstalledSkills(client);
});

// 获取所有客户端的已安装 Skills
ipcMain.handle('skills:get-all-installed', async () => {
    return skillsManager.getAllInstalledSkills();
});

// 安装 Skill
ipcMain.handle('skills:install', async (_, skillId: string, sourceInfo: SkillSourceMeta, clients: SkillClientType[]) => {
    await historyManager.backup();
    return skillsManager.installSkill(skillId, sourceInfo, clients);
});

// 卸载 Skill
ipcMain.handle('skills:uninstall', async (_, skillName: string, clients: SkillClientType[]) => {
    await historyManager.backup();
    return skillsManager.uninstallSkill(skillName, clients);
});

// 更新单个 Skill
ipcMain.handle('skills:update', async (_, skillName: string, client: SkillClientType) => {
    return skillsManager.updateSkill(skillName, client);
});

// 批量更新所有 Skills
ipcMain.handle('skills:update-all', async (_, client: SkillClientType) => {
    return skillsManager.updateAllSkills(client);
});

// 检查 Skill 是否已安装
ipcMain.handle('skills:is-installed', async (_, skillId: string) => {
    return skillsManager.isSkillInstalled(skillId);
});

// 解析导入 URL，发现 Skills
ipcMain.handle('skills:parse-import-url', async (_, url: string) => {
    return skillsManager.parseImportUrl(url);
});

// 解析平台（ModelScope / SafeSkill / SkillHub）skill 详情页 URL，自动提取可下载源
ipcMain.handle('skills:resolve-platform-url', async (_, url: string) => {
    return resolvePlatformSkillUrl(skillsManager, url);
});

// 从发现的 Skill 安装
ipcMain.handle('skills:install-from-discovered', async (_, skill: DiscoveredSkill, clients: SkillClientType[]) => {
    await historyManager.backup();
    return skillsManager.installFromDiscovered(skill, clients);
});

// 创建自定义 Skill（本地，无网络）
ipcMain.handle('skills:create-custom', async (_, input: {
    name: string;
    description: string;
    body: string
}, clients: SkillClientType[]) => {
    await historyManager.backup();
    return skillsManager.createCustomSkill(input, clients);
});

// 更新自定义 Skill（改写 SKILL.md，可重命名）
ipcMain.handle('skills:update-custom', async (_, originalName: string, input: {
    name: string;
    description: string;
    body: string
}, clients: SkillClientType[]) => {
    await historyManager.backup();
    return skillsManager.updateCustomSkill(originalName, input, clients);
});

// 读取本地 Skill 的 SKILL.md（解析 frontmatter 与正文，用于编辑回填）
ipcMain.handle('skills:read-skill-md', async (_, skillName: string, client: SkillClientType) => {
    return skillsManager.readSkillMd(skillName, client);
});

// 从本地 .zip / .skill 文件解析 Skill（解包后读取 SKILL.md），用于「我的库」上传创建
ipcMain.handle('skills:import-file', async (_, filePath: string) => {
    return skillsManager.importFromFile(filePath);
});

// 获取本地 Skill 详情
ipcMain.handle('skills:get-local-detail', async (_, skillId: string) => {
    return skillsManager.getLocalSkillDetail(skillId);
});

// 远程 GitHub Registry skill 详情：复用 parseImportUrl 解析仓库并取回首个 Skill 的源 / SKILL.md
// （替代渲染端 fetchSkillDetail 桩——该桩对所有内置 skill 一律抛错，导致详情页“加载失败”）
ipcMain.handle('skills:get-remote-detail', async (_, githubPath: string) => {
    try {
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(githubPath) ? githubPath : `https://github.com/${githubPath}`;
        const result = await skillsManager.parseImportUrl(url);
        if (!result.success || result.skills.length === 0) {
            return {success: false, skill: null, error: result.error || 'No SKILL.md found in this repository'};
        }
        return {success: true, skill: result.skills[0], error: null};
    } catch (e) {
        return {success: false, skill: null, error: (e as Error).message || 'Failed to load skill detail'};
    }
});

// 同步单个 Skill 到目标客户端
ipcMain.handle('skills:sync', async (_, skillName: string, sourceClient: SkillClientType, targetClients: SkillClientType[]) => {
    return skillsManager.syncSkillToClients(skillName, sourceClient, targetClients);
});

// 批量同步多个 Skill 到目标客户端
ipcMain.handle('skills:sync-batch', async (_, items: Array<{
    name: string;
    sourceClient: SkillClientType
}>, targetClients: SkillClientType[]) => {
    return skillsManager.syncSkillsToClients(items, targetClients);
});

// 设置自定义 Skills 路径
ipcMain.handle('clients:set-custom-skills-path', async (_, client: SkillClientType, customPath: string | null) => {
    return configManager.setCustomSkillsPath(client, customPath);
});

// 打开 Skills 目录
ipcMain.handle('system:open-skills-directory', async (_, client: SkillClientType) => {
    const skillsPath = configManager.getSkillsPath(client);
    return shell.openPath(skillsPath);
});

// ============ API 令牌 IPC 处理器 ============
ipcMain.handle('api-tokens:list', async (): Promise<TokenMeta[]> => {
    return secretStore.listTokens();
});

ipcMain.handle('api-tokens:create', async (_, name: string, scopes: TokenScope[], expiresAt: number | null): Promise<TokenMeta> => {
    if (!name || !name.trim()) throw new Error('令牌名称不能为空');
    return secretStore.createToken(name, scopes, expiresAt);
});

ipcMain.handle('api-tokens:import', async (_, rawKey: string, name: string, platform?: string, expiresAt?: number | null): Promise<TokenMeta> => {
    if (!name || !name.trim()) throw new Error('令牌名称不能为空');
    return secretStore.importToken(rawKey, name, platform, expiresAt ?? null);
});

ipcMain.handle('api-tokens:reveal', async (_, id: string): Promise<string | null> => {
    return secretStore.revealToken(id);
});

ipcMain.handle('api-tokens:revoke', async (_, id: string): Promise<TokenMeta | null> => {
    return secretStore.revokeToken(id);
});

ipcMain.handle('api-tokens:restore', async (_, id: string): Promise<TokenMeta | null> => {
    return secretStore.restoreToken(id);
});

ipcMain.handle('api-tokens:delete', async (_, id: string): Promise<void> => {
    secretStore.deleteToken(id);
});

// ============ API 直连 IPC 处理器 ============
ipcMain.handle('api-connections:list', async (_, kind?: 'mcp' | 'skill'): Promise<ApiConnection[]> => {
    return connectionsStore.list(kind);
});

ipcMain.handle('api-connections:create', async (_, conn: Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'>): Promise<ApiConnection> => {
    if (!conn.name || !conn.name.trim()) throw new Error('连接名称不能为空');
    if (!conn.baseUrl || !/^https?:\/\//i.test(conn.baseUrl)) throw new Error('Base URL 格式无效');
    return connectionsStore.upsert(conn);
});

ipcMain.handle('api-connections:update', async (_, conn: ApiConnection): Promise<ApiConnection> => {
    if (!conn.id) throw new Error('缺少连接 ID');
    return connectionsStore.upsert(conn);
});

ipcMain.handle('api-connections:delete', async (_, id: string): Promise<void> => {
    connectionsStore.delete(id);
});

ipcMain.handle('api-connections:verify', async (_, id: string): Promise<ApiConnection> => {
    return connectionsStore.verify(id);
});

ipcMain.handle('api-connections:export', async (_, id?: string): Promise<string> => {
    return connectionsStore.exportConfig(id);
});

// ============ API 直连驱动的平台搜索 / 解析 ============
ipcMain.handle('api-connections:search-platform', async (_, connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformSkillListItem[]> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    return searchPlatformDirect(conn.platformType, conn.baseUrl, secret, query, page, pageSize, category);
});

/**
 * 分页搜索：返回条目 + 平台分页元信息（total / totalPages / hasMore）。
 * 渲染层据此渲染翻页控件。
 */
ipcMain.handle('api-connections:search-platform-paged', async (_, connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformSearchPage> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    return searchPlatformDirectPaged(conn.platformType, conn.baseUrl, secret, query, page, pageSize, category);
});

/**
 * 获取最近一次直连搜索的诊断信息（端点探测链路、状态码、耗时、失败原因）。
 * 渲染层在"无结果"时调用，向用户展示具体原因而非空白列表。
 */
ipcMain.handle('api-connections:search-diagnostics', async (_, connectionId: string) => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    return getLastDirectSearchDiagnostics(conn.platformType);
});

ipcMain.handle('api-connections:resolve-skill', async (_, connectionId: string, sourceUrl: string): Promise<ReturnType<typeof resolveDirectSkill>> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    return resolveDirectSkill(skillsManager, conn.platformType, sourceUrl);
});

/**
 * 分页搜索 MCP server（平台直连，如 ModelScope MCP 广场）。
 * 复用连接绑定的令牌，服务端分页；渲染层据此渲染翻页控件。
 */
ipcMain.handle('api-connections:search-servers-paged', async (_, connectionId: string, query: string, page: number, pageSize?: number, category?: string): Promise<PlatformServerSearchPage> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    return searchPlatformServersPaged(conn.platformType, conn.baseUrl, secret, query, page, pageSize, category);
});

/**
 * 获取单个平台 MCP server 的详情（含安装配置 / README）。
 * 复用连接绑定的令牌，平台直连（如 ModelScope）。
 */
ipcMain.handle('api-connections:get-server-detail', async (_, connectionId: string, serverId: string): Promise<PlatformServerDetail> => {
    const conn = connectionsStore.get(connectionId);
    if (!conn) throw new Error('连接不存在');
    const secret = conn.tokenId ? secretStore.getSecretToken(conn.tokenId) : null;
    return fetchPlatformServerDetail(conn.platformType, conn.baseUrl, secret, serverId);
});

// ============ API 直连默认来源 ============
ipcMain.handle('api-connections:set-default', async (_, id: string): Promise<ApiConnection> => {
    connectionsStore.setDefault(id);
    return connectionsStore.get(id)!;
});

ipcMain.handle('api-connections:set-enabled', async (_, id: string, enabled: boolean): Promise<ApiConnection> => {
    return connectionsStore.setEnabled(id, enabled);
});

ipcMain.handle('api-connections:restore-builtin-mcp', async (): Promise<ApiConnection[]> => {
    return connectionsStore.restoreBuiltinMcpSources();
});

ipcMain.handle('api-connections:restore-builtin-skill', async (): Promise<ApiConnection[]> => {
    return connectionsStore.restoreBuiltinSkillSources();
});

// ============ 云同步 IPC 处理器 ============

ipcMain.handle('cloud-sync:get-config', async (): Promise<CloudSyncConfig> => {
    return cloudSyncStore.getConfig();
});

ipcMain.handle('cloud-sync:set-config', async (_, patch: CloudSyncConfigInput): Promise<CloudSyncConfig> => {
    const cfg = cloudSyncStore.setConfig(patch);
    // 云端存储是否作为「客户端」出现，取决于此配置；必须让客户端列表缓存失效，
    // 否则本会话内仍返回旧的 installed 状态，要重启才生效。
    configManager.invalidateClientsCache();
    return cfg;
});

ipcMain.handle('cloud-sync:test', async (): Promise<CloudSyncResult> => {
    return cloudSyncService.testConnection();
});

ipcMain.handle('cloud-sync:push', async (): Promise<CloudSyncResult> => {
    return cloudSyncService.push();
});

ipcMain.handle('cloud-sync:pull', async (): Promise<CloudSyncResult> => {
    return cloudSyncService.pull();
});

// ============ 缓存 IPC 处理器 ============

// 缓存键类型
type CacheKey =
    | 'official-index'
    | 'smithery-index'
    | 'skills-index'
    | `official-detail-${string}`
    | `smithery-detail-${string}`
    | `skills-detail-${string}`;

// 获取缓存
ipcMain.handle('cache:get', async (_event, key: CacheKey) => {
    return cacheManager.get(key);
});

// 设置缓存
ipcMain.handle('cache:set', async (_event, key: CacheKey, data: unknown, etag?: string) => {
    return cacheManager.set(key, data, etag);
});

// 获取缓存元数据
ipcMain.handle('cache:get-meta', async (_, key: CacheKey) => {
    return cacheManager.getMeta(key);
});

// 检查缓存是否过期
ipcMain.handle('cache:is-expired', async (_, key: CacheKey) => {
    return cacheManager.isExpired(key);
});

// 检查缓存是否存在
ipcMain.handle('cache:has', async (_, key: CacheKey) => {
    return cacheManager.has(key);
});

// 删除指定缓存
ipcMain.handle('cache:delete', async (_, key: CacheKey) => {
    return cacheManager.delete(key);
});

// 清除所有缓存
ipcMain.handle('cache:clear', async () => {
    return cacheManager.clear();
});

// 按前缀清除缓存
ipcMain.handle('cache:clear-by-prefix', async (_, prefix: 'official' | 'smithery' | 'skills') => {
    return cacheManager.clearByPrefix(prefix);
});

// 获取缓存统计信息
ipcMain.handle('cache:get-stats', async () => {
    return cacheManager.getStats();
});

// 获取缓存目录路径
ipcMain.handle('cache:get-directory', async () => {
    return cacheManager.getCacheDirectory();
});
