/**
 * Library 页面 - Surge 风格
 * 管理已安装的 MCP Servers 和 Skills
 */

import {useEffect, useMemo, useState} from 'react';
import {useNavigate, useSearchParams} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import {
    type ClientInfo,
    type ClientType,
    getElectronAPI,
    type InstalledSkill,
    type McpServerConfig,
    type SkillClientType,
    useElectronAPI
} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {useStore} from '../store/useStore';
import Modal from '../components/Modal';
import ClientIcon from '../components/ClientIcon';
import AddServerModal from '../components/AddServerModal';
import {CreateSkillModal} from '../components/CreateSkillModal';
import {toast} from '../components/Toast';
import {type DataSource, fetchServerList, type ServerListItem} from '../api/registry';

interface InstalledServer {
    id: string;
    config: McpServerConfig;
    clients: ClientType[];
    isMcpDock: boolean;
    source: DataSource;
    // 编辑保存后转为「手动安装」：不再被当作商店来源，避免线上更新覆盖
    manual: boolean;
}

// 检查是否是 AI-Tools 安装的服务器
function isMcpDockInstalled(config: McpServerConfig, serverId: string, serverLists: Record<DataSource, ServerListItem[]>): {
    isMcpDock: boolean;
    source: DataSource
} {
    const args = config.args || [];
    const argsStr = args.join(' ');
    const command = config.command || '';

    const configAny = config as Record<string, unknown>;
    const isRemote = 'url' in configAny && typeof configAny.url === 'string';

    const isNpx = command.endsWith('npx') || command.includes('/npx');
    const isUvx = command.endsWith('uvx') || command.includes('/uvx');
    const isDocker = command === 'docker' || command.endsWith('/docker');

    if (argsStr.includes('@smithery/cli') || argsStr.includes('smithery-cli')) {
        return {isMcpDock: true, source: 'smithery'};
    }

    const officialList = serverLists.official || [];
    const smitheryList = serverLists.smithery || [];

    const isInOfficial = officialList.some(s => s.id === serverId);
    const isInSmithery = smitheryList.some(s => s.id === serverId);

    if (isInOfficial) {
        if (isRemote) return {isMcpDock: true, source: 'official'};
        if (isNpx && args.includes('-y')) return {isMcpDock: true, source: 'official'};
        if (isUvx) return {isMcpDock: true, source: 'official'};
        if (isDocker) return {isMcpDock: true, source: 'official'};
        return {isMcpDock: false, source: 'official'};
    }

    if (isInSmithery) {
        return {isMcpDock: false, source: 'smithery'};
    }

    return {isMcpDock: false, source: 'official'};
}

// 从仓库 URL 提取 GitHub 用户名
function extractGitHubUsername(repoUrl: string | null | undefined): string | null {
    if (!repoUrl) return null;
    const match = repoUrl.match(/github\.com\/([^\/]+)/);
    return match ? match[1] : null;
}

// 服务器图标组件
function ServerIcon({server, serverInfo}: { server: InstalledServer; serverInfo?: ServerListItem }) {
    const [imgError, setImgError] = useState(false);
    const [avatarError, setAvatarError] = useState(false);

    const displayName = serverInfo?.displayName || server.id.split('/').pop() || server.id;
    const initial = displayName.charAt(0).toUpperCase();

    // 获取 GitHub 用户名
    const repoUrl = (serverInfo as any)?.repository?.url;
    const githubUsername = extractGitHubUsername(repoUrl);

    const colors = [
        'bg-blue-500',
        'bg-purple-500',
        'bg-green-500',
        'bg-orange-500',
        'bg-pink-500',
        'bg-cyan-500',
    ];
    const colorIndex = displayName.charCodeAt(0) % colors.length;

    // 优先使用服务器图标
    if (serverInfo?.iconUrl && !imgError) {
        return (
            <img
                src={serverInfo.iconUrl}
                alt={displayName}
                className="w-9 h-9 rounded-lg object-cover"
                onError={() => setImgError(true)}
            />
        );
    }

    // 其次使用 GitHub 头像
    if (githubUsername && !avatarError) {
        return (
            <img
                src={`https://avatars.githubusercontent.com/${githubUsername}`}
                alt={displayName}
                className="w-9 h-9 rounded-lg object-cover"
                onError={() => setAvatarError(true)}
            />
        );
    }

    // 最后使用首字母图标
    return (
        <div
            className={`w-9 h-9 rounded-lg ${colors[colorIndex]} flex items-center justify-center text-white font-semibold text-sm`}>
            {initial}
        </div>
    );
}

// Skill 图标组件
function SkillIcon({skill}: { skill: InstalledSkill }) {
    const [avatarError, setAvatarError] = useState(false);

    // 从 source 中提取作者
    const author = skill.source?.id?.split('/')[0] || skill.name.charAt(0);
    const initial = skill.name.charAt(0).toUpperCase();

    const colors = [
        'bg-blue-500',
        'bg-purple-500',
        'bg-green-500',
        'bg-orange-500',
        'bg-pink-500',
        'bg-cyan-500',
    ];
    const colorIndex = skill.name.charCodeAt(0) % colors.length;

    // 使用作者 GitHub 头像
    if (author && !avatarError) {
        return (
            <img
                src={`https://avatars.githubusercontent.com/${author}`}
                alt={skill.name}
                className="w-9 h-9 rounded-lg object-cover"
                onError={() => setAvatarError(true)}
            />
        );
    }

    return (
        <div
            className={`w-9 h-9 rounded-lg ${colors[colorIndex]} flex items-center justify-center text-white font-semibold text-sm`}>
            {initial}
        </div>
    );
}

export default function Library() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const api = useElectronAPI();
    const isMac = useIsMac();
    const [searchParams, setSearchParams] = useSearchParams();

    // 当前激活的 Tab：优先从 URL 的 ?tab= 读取，使得从 Skill 详情返回时能停留在 Skills 标签页
    const [activeTab, setActiveTab] = useState<'mcp' | 'skills'>(
        searchParams.get('tab') === 'skills' ? 'skills' : 'mcp'
    );

    // 切换 Tab 时同步到 URL（replace 避免额外历史记录，保证返回时回到正确标签页）
    const changeTab = (tab: 'mcp' | 'skills') => {
        setActiveTab(tab);
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.set('tab', tab);
                return next;
            },
            {replace: true}
        );
    };


    const {setInstalledServerIds, removeInstalledServerId, serverLists, setServerList} = useStore();

    // 创建服务器信息映射
    const serverInfoMap = useMemo(() => {
        const map = new Map<string, ServerListItem>();
        Object.values(serverLists).forEach(list => {
            list.forEach(server => {
                map.set(server.id, server);
            });
        });
        return map;
    }, [serverLists]);

    const [servers, setServers] = useState<InstalledServer[]>([]);
    const [skills, setSkills] = useState<InstalledSkill[]>([]);
    const [skillClients, setSkillClients] = useState<Record<string, SkillClientType[]>>({});
    const [clients, setClients] = useState<ClientInfo[]>([]);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [editingServer, setEditingServer] = useState<InstalledServer | null>(null);
    const [editedConfig, setEditedConfig] = useState('');
    const [syncingServer, setSyncingServer] = useState<InstalledServer | null>(null);
    const [selectedSyncClients, setSelectedSyncClients] = useState<ClientType[]>([]);
    // MCP Server 多选 + 批量同步（多客户端复用）
    const [serverSelectMode, setServerSelectMode] = useState(false);
    const [selectedServers, setSelectedServers] = useState<string[]>([]);
    const [serverSyncOpen, setServerSyncOpen] = useState(false);
    const [serverSyncList, setServerSyncList] = useState<InstalledServer[]>([]);
    const [isSyncingServers, setIsSyncingServers] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const [isAddingServer, setIsAddingServer] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [refreshingSkill, setRefreshingSkill] = useState<string | null>(null);

    // 创建 / 编辑自定义 Skill
    const [showCreateSkill, setShowCreateSkill] = useState(false);
    const [editingSkill, setEditingSkill] = useState<{
        name: string;
        description: string;
        body: string;
        clients: SkillClientType[];
    } | null>(null);

    // Skills 客户端间同步（单条 + 批量）
    const [selectMode, setSelectMode] = useState(false);
    const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
    const [syncModalOpen, setSyncModalOpen] = useState(false);
    const [syncModalSkills, setSyncModalSkills] = useState<string[]>([]);
    const [isSyncing, setIsSyncing] = useState(false);

    // 卸载目标选择弹窗（支持指定客户端卸载 / 全客户端卸载）
    const [uninstallTarget, setUninstallTarget] = useState<{
        type: 'mcp' | 'skill';
        id: string;
        displayName: string;
        clients: string[];
    } | null>(null);
    const [selectedUninstallClients, setSelectedUninstallClients] = useState<string[]>([]);

    // 云同步：仅在设置里配置好 Git / SFTP 后，'cloud' 才会作为已安装客户端出现
    const [cloudBusy, setCloudBusy] = useState<'push' | 'pull' | null>(null);
    const cloudAvailable = clients.some(c => c.id === 'cloud' && c.installed);

    const openUninstall = (type: 'mcp' | 'skill', id: string, displayName: string, clients: string[]) => {
        setUninstallTarget({type, id, displayName, clients});
        setSelectedUninstallClients([...clients]); // 默认全选
    };

    const confirmUninstall = async () => {
        if (!uninstallTarget) return;
        const clients = selectedUninstallClients;
        try {
            if (uninstallTarget.type === 'mcp') {
                await handleRemoveServer(uninstallTarget.id, clients as ClientType[]);
            } else {
                await handleRemoveSkill(uninstallTarget.id, clients as SkillClientType[]);
            }
        } finally {
            setUninstallTarget(null);
        }
    };

    // 加载服务器列表
    useEffect(() => {
        const loadServerLists = async () => {
            if (serverLists.official.length === 0) {
                try {
                    const officialList = await fetchServerList('official');
                    setServerList('official', officialList);
                } catch (e) {
                    console.error('Failed to load official server list:', e);
                }
            }
            if (serverLists.smithery.length === 0) {
                try {
                    const smitheryList = await fetchServerList('smithery');
                    setServerList('smithery', smitheryList);
                } catch (e) {
                    console.error('Failed to load smithery server list:', e);
                }
            }
        };
        loadServerLists();
    }, [serverLists.official.length, serverLists.smithery.length, setServerList]);

    // 加载数据
    useEffect(() => {
        loadData();
    }, [api]);

    const loadData = async () => {
        try {
            const [clientList, {servers: serverMap}, {byClient: skillsByClient}, manualServers] = await Promise.all([
                api.clients.getAll(),
                api.config.getAllServers(),
                api.skills.getAllInstalled(),
                api.config.getManualServers(),
            ]);

            setClients(clientList);

            // 处理 MCP Servers
            const manualSet = new Set(manualServers);
            const serverList = Object.entries(serverMap).map(([id, {config, clients}]) => {
                const {isMcpDock, source} = isMcpDockInstalled(config, id, serverLists);
                return {id, config, clients, isMcpDock, source, manual: manualSet.has(id)};
            });
            setServers(serverList);
            setInstalledServerIds(Object.keys(serverMap));

            // 处理 Skills - 合并所有客户端的 Skills 并记录每个 Skill 安装在哪些客户端
            const allSkills: InstalledSkill[] = [];
            const skillNames = new Set<string>();
            const skillClientsMap: Record<string, SkillClientType[]> = {};

            for (const [clientId, skillList] of Object.entries(skillsByClient)) {
                for (const skill of skillList) {
                    if (!skillNames.has(skill.name)) {
                        skillNames.add(skill.name);
                        allSkills.push(skill);
                        skillClientsMap[skill.name] = [clientId as SkillClientType];
                    } else {
                        if (!skillClientsMap[skill.name].includes(clientId as SkillClientType)) {
                            skillClientsMap[skill.name].push(clientId as SkillClientType);
                        }
                    }
                }
            }
            setSkills(allSkills);
            setSkillClients(skillClientsMap);
        } catch (error) {
            console.error('Failed to load data:', error);
        } finally {
            setHasLoaded(true);
        }
    };

    // 编辑服务器
    const handleEdit = (server: InstalledServer) => {
        setEditingServer(server);
        setEditedConfig(JSON.stringify(server.config, null, 2));
    };

    // 保存编辑
    const handleSaveEdit = async () => {
        if (!editingServer) return;
        try {
            const newConfig = JSON.parse(editedConfig);
            // 简单判断：编辑前后配置无变化则不标记为「手动安装」，保留商店来源
            const configChanged =
                JSON.stringify(newConfig) !== JSON.stringify(editingServer.config);
            for (const client of editingServer.clients) {
                await api.config.updateServer(editingServer.id, newConfig, client);
            }
            // 仅当配置有修改时才标记为手动安装，避免线上更新覆盖本地调整
            if (configChanged) {
                await api.config.markServerManual(editingServer.id);
            }
            setEditingServer(null);
            loadData();
        } catch (error) {
            console.error('Failed to save config:', error);
            alert('Invalid JSON configuration');
        }
    };

    // 删除服务器
    const handleRemoveServer = async (serverId: string, clientsToRemove: ClientType[]) => {
        try {
            await api.config.uninstallServer(serverId, clientsToRemove);
            const server = servers.find(s => s.id === serverId);
            if (server) {
                const remainingClients = server.clients.filter(c => !clientsToRemove.includes(c));
                if (remainingClients.length === 0) {
                    removeInstalledServerId(serverId);
                }
            }
            loadData();
        } catch (error) {
            console.error('Failed to remove server:', error);
        }
    };

    // 删除 Skill（支持指定客户端卸载，缺省卸载全部已安装客户端）
    const handleRemoveSkill = async (skillName: string, skillClientList?: SkillClientType[]) => {
        const clients = skillClientList && skillClientList.length > 0 ? skillClientList : (skillClients[skillName] || []);
        if (clients.length === 0) return;
        try {
            await api.skills.uninstall(skillName, clients);
            loadData();
        } catch (error) {
            console.error('Failed to remove skill:', error);
        }
    };

    // 更新 Skill（带旋转动效）
    const handleUpdateSkill = async (skillName: string) => {
        setRefreshingSkill(skillName);
        const startTime = Date.now();

        try {
            const skillClientList = skillClients[skillName] || [];
            for (const client of skillClientList) {
                await api.skills.update(skillName, client);
            }

            // 确保动画至少持续2秒
            const elapsed = Date.now() - startTime;
            if (elapsed < 2000) {
                await new Promise(resolve => setTimeout(resolve, 2000 - elapsed));
            }

            loadData();
            toast.success(t('library.skillUpdated') || `Skill "${skillName}" updated`);
        } catch (error) {
            console.error('Failed to update skill:', error);
            toast.error(t('library.skillUpdateFailed') || 'Failed to update skill');
        } finally {
            setRefreshingSkill(null);
        }
    };

    // 更新所有 Skills（带旋转动效）
    const handleUpdateAllSkills = async () => {
        setIsRefreshing(true);
        const startTime = Date.now();

        try {
            // 云端暂存区不参与「更新全部」：云端内容由显式的上传 / 下载驱动
            const skillClientTypes = clients
                .filter(c => c.supportsSkills && c.installed && c.id !== 'cloud')
                .map(c => c.id as SkillClientType);
            for (const client of skillClientTypes) {
                await api.skills.updateAll(client);
            }

            // 确保动画至少持续2秒
            const elapsed = Date.now() - startTime;
            if (elapsed < 2000) {
                await new Promise(resolve => setTimeout(resolve, 2000 - elapsed));
            }

            loadData();
            toast.success(t('library.allSkillsUpdated') || 'All skills updated');
        } catch (error) {
            console.error('Failed to update all skills:', error);
            toast.error(t('library.allSkillsUpdateFailed') || 'Failed to update skills');
        } finally {
            setIsRefreshing(false);
        }
    };

    // 切换 Skills 批量选择模式
    const toggleSelectMode = () => {
        setSelectMode(prev => !prev);
        setSelectedSkills([]);
    };

    // 勾选/取消勾选单个 Skill
    const toggleSkillSelect = (skillName: string) => {
        setSelectedSkills(prev =>
            prev.includes(skillName)
                ? prev.filter(n => n !== skillName)
                : [...prev, skillName]
        );
    };

    // 打开单条 Skill 同步弹窗
    const handleOpenSkillSync = (skillName: string) => {
        setSyncModalSkills([skillName]);
        setSelectedSyncClients([]);
        setSyncModalOpen(true);
    };

    // 编辑自定义 Skill：从首个已安装客户端读回 SKILL.md 回填
    const handleEditSkill = async (skillName: string) => {
        const installed = skillClients[skillName] || [];
        const client = installed[0];
        let data = {name: skillName, description: '', body: '', clients: installed as SkillClientType[]};
        if (client) {
            try {
                const api = getElectronAPI();
                if (api) {
                    const parsed = await api.skills.readSkillMd(skillName, client);
                    if (parsed) {
                        data = {
                            name: parsed.name || skillName,
                            description: parsed.description,
                            body: parsed.body,
                            clients: installed as SkillClientType[]
                        };
                    }
                }
            } catch (e) {
                console.error('Failed to read skill for edit:', e);
            }
        }
        setEditingSkill(data);
    };

    // 创建 / 编辑自定义 Skill 提交
    const handleCreateSkillSubmit = async (
        originalName: string | undefined,
        input: { name: string; description: string; body: string },
        selected: SkillClientType[]
    ): Promise<{ success: boolean; error?: string }> => {
        const api = getElectronAPI();
        if (!api) {
            return {success: false, error: 'Electron API 不可用'};
        }
        const result = originalName
            ? await api.skills.updateCustom(originalName, input, selected)
            : await api.skills.createCustom(input, selected);
        if (result.success) {
            await loadData();
        }
        return result;
    };

    // 打开批量同步弹窗
    const handleOpenBatchSync = () => {
        if (selectedSkills.length === 0) return;
        setSyncModalSkills([...selectedSkills]);
        setSelectedSyncClients([]);
        setSyncModalOpen(true);
    };

    // 确认同步（单条与批量统一走 syncBatch）
    const handleConfirmSync = async () => {
        if (syncModalSkills.length === 0 || selectedSyncClients.length === 0) return;
        setIsSyncing(true);
        const startTime = Date.now();
        try {
            const items = syncModalSkills
                .map(name => ({
                    name,
                    sourceClient: (skillClients[name] || [])[0] as SkillClientType,
                }))
                .filter(i => i.sourceClient);
            const result = await api.skills.syncBatch(
                items,
                selectedSyncClients as SkillClientType[]
            );

            const elapsed = Date.now() - startTime;
            if (elapsed < 800) await new Promise(resolve => setTimeout(resolve, 800 - elapsed));

            setSyncModalOpen(false);
            setSelectMode(false);
            setSelectedSkills([]);
            await autoPushIfCloud(selectedSyncClients);
            loadData();

            if (result.synced > 0) {
                toast.success(
                    t('library.skillsSynced', {count: result.synced}) ||
                    `已同步 ${result.synced} 个 Skill 到 ${result.details[0]?.success.length ?? 0} 个客户端`
                );
            }
            if (result.failed > 0) {
                toast.error(
                    t('library.skillsSyncFailed', {count: result.failed}) ||
                    `${result.failed} 个 Skill 同步失败`
                );
            }
        } catch (error) {
            console.error('Failed to sync skills:', error);
            toast.error(t('library.syncError') || '同步失败');
        } finally {
            setIsSyncing(false);
        }
    };

    // 打开同步对话框
    const handleOpenSync = (server: InstalledServer) => {
        setSyncingServer(server);
        setSelectedSyncClients([]);
    };

    // 同步到其他客户端
    const handleSync = async () => {
        if (!syncingServer || selectedSyncClients.length === 0 || syncingServer.clients.length === 0) return;
        try {
            const sourceClient = syncingServer.clients[0];
            const result = await api.config.syncServer(syncingServer.id, sourceClient, selectedSyncClients);
            setSyncingServer(null);
            await autoPushIfCloud(selectedSyncClients);
            setSelectedSyncClients([]);
            loadData();
            if (result.success.length > 0) {
                toast.success(t('installed.serversSynced', {count: 1}) || `已同步到 ${result.success.length} 个客户端`);
            }
            if (result.failed.length > 0) {
                toast.error(t('installed.serversSyncFailed', {count: 1}) || `${result.failed.length} 个客户端同步失败`);
            }
        } catch (error) {
            console.error('Failed to sync server:', error);
            toast.error(t('installed.syncError') || '同步失败');
        }
    };

    // 切换服务器批量选择模式
    const toggleServerSelectMode = () => {
        setServerSelectMode(prev => !prev);
        setSelectedServers([]);
    };

    // 勾选/取消勾选单个服务器
    const toggleServerSelect = (serverId: string) => {
        setSelectedServers(prev =>
            prev.includes(serverId)
                ? prev.filter(n => n !== serverId)
                : [...prev, serverId]
        );
    };

    // 打开批量同步弹窗
    const handleOpenServerBatchSync = () => {
        if (selectedServers.length === 0) return;
        const list = servers.filter(s => selectedServers.includes(s.id));
        setServerSyncList(list);
        setSelectedSyncClients([]);
        setServerSyncOpen(true);
    };

    // 确认批量同步（多客户端复用）
    const handleConfirmServerSync = async () => {
        if (serverSyncList.length === 0 || selectedSyncClients.length === 0) return;
        setIsSyncingServers(true);
        const startTime = Date.now();
        try {
            const items = serverSyncList.map(s => ({serverId: s.id, config: s.config}));
            const result = await api.config.syncServersBatch(items, selectedSyncClients);

            const elapsed = Date.now() - startTime;
            if (elapsed < 800) await new Promise(resolve => setTimeout(resolve, 800 - elapsed));

            setServerSyncOpen(false);
            setServerSelectMode(false);
            setSelectedServers([]);
            setServerSyncList([]);
            await autoPushIfCloud(selectedSyncClients);
            loadData();

            if (result.synced > 0) {
                toast.success(t('installed.serversSynced', {count: result.synced}) || `已同步 ${result.synced} 个服务器到客户端`);
            }
            if (result.failed > 0) {
                toast.error(t('installed.serversSyncFailed', {count: result.failed}) || `${result.failed} 个服务器同步失败`);
            }
        } catch (error) {
            console.error('Failed to batch sync servers:', error);
            toast.error(t('installed.syncError') || '同步失败');
        } finally {
            setIsSyncingServers(false);
        }
    };

    /**
     * 同步目标包含云端时，把暂存区推到远端。
     * 「同步到云端客户端」只写了本地 ~/.ai-tool/cloud 暂存区，还需要一次传输才真正上云。
     */
    const autoPushIfCloud = async (targets: string[]) => {
        if (!targets.includes('cloud')) return;
        const res = await api.cloudSync.push();
        if (res.ok) toast.success(res.message || '已上传到云端');
        else toast.error(res.message || '上传云端失败');
    };

    // 云上传：把当前库里的 MCP + Skill 全量写入云端暂存区，再推送到远端
    const handleCloudUpload = async () => {
        setCloudBusy('push');
        try {
            if (servers.length > 0) {
                await api.config.syncServersBatch(
                    servers.map(s => ({serverId: s.id, config: s.config})),
                    ['cloud']
                );
            }
            const skillItems = skills
                .map(s => ({
                    name: s.name,
                    sourceClient: (skillClients[s.name] || []).find(c => c !== 'cloud') as SkillClientType
                }))
                .filter(i => i.sourceClient);
            if (skillItems.length > 0) {
                await api.skills.syncBatch(skillItems, ['cloud']);
            }

            const res = await api.cloudSync.push();
            if (res.ok) toast.success(res.message || '已上传到云端');
            else toast.error(res.message || '上传失败');
            await loadData();
        } catch (error: any) {
            console.error('Cloud upload failed:', error);
            toast.error(error?.message || '上传失败');
        } finally {
            setCloudBusy(null);
        }
    };

    // 云下载：把远端拉到暂存区，之后云端内容会作为「云端存储」客户端出现在列表里
    const handleCloudDownload = async () => {
        setCloudBusy('pull');
        try {
            const res = await api.cloudSync.pull();
            if (res.ok) toast.success(res.message || '已从云端下载');
            else toast.error(res.message || '下载失败');
            await loadData();
        } catch (error: any) {
            console.error('Cloud download failed:', error);
            toast.error(error?.message || '下载失败');
        } finally {
            setCloudBusy(null);
        }
    };

    // 切换同步客户端选择
    const toggleSyncClient = (clientId: ClientType) => {
        setSelectedSyncClients(prev =>
            prev.includes(clientId)
                ? prev.filter(c => c !== clientId)
                : [...prev, clientId]
        );
    };

    // 获取显示名称
    const getDisplayName = (id: string) => {
        const serverInfo = serverInfoMap.get(id);
        if (serverInfo?.displayName) return serverInfo.displayName;
        const parts = id.split('/');
        return parts[parts.length - 1];
    };

    // 添加自定义服务器
    const handleAddServer = async (serverId: string, config: McpServerConfig, targetClients: ClientType[]) => {
        setIsAddingServer(true);
        try {
            await api.config.installServer(serverId, config, targetClients);
            setShowAddModal(false);
            loadData();
        } catch (error) {
            console.error('Failed to add server:', error);
        } finally {
            setIsAddingServer(false);
        }
    };

    // 点击服务器
    const handleServerClick = (server: InstalledServer) => {
        if (server.isMcpDock) {
            navigate(`/detail/${server.source}/${encodeURIComponent(server.id)}`);
        }
    };

    // 点击 Skill
    const handleSkillClick = (skill: InstalledSkill) => {
        // 使用 source.id 作为导航 ID
        const skillId = skill.source?.id || skill.name;
        // 手动安装的 Skill（无 .source.json）在商店里并不存在，详情页面包屑也指向「我的库」，
        // 故带上 from=library 让侧边栏继续停留在我的库，不跳到商店。
        const from = skill.source ? '' : '?from=library';
        navigate(`/skill/${encodeURIComponent(skillId)}${from}`);
    };

    // 初始加载占位（避免「暂无安装」空状态在数据返回前闪现）
    const LoadingSkeleton = () => (
        <div className="p-4">
            <div className="card overflow-hidden divide-y divide-[#3a3a3c]">
                {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <div className="w-8 h-8 rounded bg-[#3a3a3c] animate-pulse"/>
                        <div className="flex-1 space-y-2">
                            <div className="h-3 w-32 bg-[#3a3a3c] rounded animate-pulse"/>
                            <div className="h-2.5 w-20 bg-[#3a3a3c] rounded animate-pulse"/>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    return (
        <div className="flex flex-col h-full bg-[#1c1c1e]">
            {/* 头部工具栏（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center justify-between px-4 h-12 drag-region border-b border-[#3a3a3c] bg-[#1c1c1e]/80 backdrop-blur-xl ${isMac ? 'pl-20' : ''}`}>
                <div className="flex items-center gap-4 no-drag">
                    <h1 className="text-[14px] font-semibold text-white tracking-tight">
                        {t('nav.library') || 'Library'}
                    </h1>

                    {/* Tab 切换 */}
                    <div className="flex items-center bg-[#3a3a3c] rounded-lg p-0.5">
                        <button
                            onClick={() => changeTab('mcp')}
                            className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                activeTab === 'mcp'
                                    ? 'bg-[#636366] text-white'
                                    : 'text-[#98989d] hover:text-white'
                            }`}
                        >
                            MCP Servers ({servers.length})
                        </button>
                        <button
                            onClick={() => changeTab('skills')}
                            className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                activeTab === 'skills'
                                    ? 'bg-[#636366] text-white'
                                    : 'text-[#98989d] hover:text-white'
                            }`}
                        >
                            Skills ({skills.length})
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-2 no-drag">
                    {/* 云端存储：在「设置 → 云同步」配置好后才出现 */}
                    {cloudAvailable && (
                        <>
                            <button
                                onClick={handleCloudDownload}
                                disabled={cloudBusy !== null}
                                title="从云端拉取 ai-tool 目录到本地暂存区"
                                className="flex items-center gap-1.5 px-3 py-1 bg-[#3a3a3c] text-white rounded-md text-[12px] font-medium hover:bg-[#4a4a4c] transition-colors disabled:opacity-50"
                            >
                                <svg className={`w-3.5 h-3.5 ${cloudBusy === 'pull' ? 'animate-pulse' : ''}`}
                                     fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"/>
                                </svg>
                                {cloudBusy === 'pull' ? '下载中…' : '云下载'}
                            </button>
                            <button
                                onClick={handleCloudUpload}
                                disabled={cloudBusy !== null}
                                title="把当前库的 MCP 与 Skill 上传到云端 ai-tool 目录"
                                className="flex items-center gap-1.5 px-3 py-1 bg-[#3a3a3c] text-white rounded-md text-[12px] font-medium hover:bg-[#4a4a4c] transition-colors disabled:opacity-50"
                            >
                                <svg className={`w-3.5 h-3.5 ${cloudBusy === 'push' ? 'animate-pulse' : ''}`}
                                     fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"/>
                                </svg>
                                {cloudBusy === 'push' ? '上传中…' : '云上传'}
                            </button>
                            <span className="w-px h-4 bg-[#3a3a3c]"/>
                        </>
                    )}
                    {activeTab === 'mcp' && (
                        <>
                            {servers.length > 0 && (
                                <button
                                    onClick={toggleServerSelectMode}
                                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                        serverSelectMode
                                            ? 'bg-[#0a84ff] text-white hover:bg-[#0a84ff]/80'
                                            : 'bg-[#3a3a3c] text-white hover:bg-[#4a4a4c]'
                                    }`}
                                >
                                    {serverSelectMode
                                        ? (t('installed.cancelSelect') || 'Cancel')
                                        : (t('installed.select') || 'Select')}
                                </button>
                            )}
                            {serverSelectMode && selectedServers.length > 0 && (
                                <button
                                    onClick={handleOpenServerBatchSync}
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[#0a84ff] text-white rounded-md text-[12px] font-medium hover:bg-[#0a84ff]/80 transition-colors"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                    </svg>
                                    {t('installed.batchSync', {count: selectedServers.length}) || `Sync (${selectedServers.length})`}
                                </button>
                            )}
                            <button
                                onClick={() => setShowAddModal(true)}
                                className="flex items-center gap-1.5 px-3 py-1 bg-[#0a84ff] text-white rounded-md text-[12px] font-medium hover:bg-[#0a84ff]/80 transition-colors"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                     strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
                                </svg>
                                {t('library.create') || '创建'}
                            </button>
                        </>
                    )}
                    {activeTab === 'skills' && (
                        <>
                            {skills.length > 0 && (
                                <button
                                    onClick={toggleSelectMode}
                                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                        selectMode
                                            ? 'bg-[#0a84ff] text-white hover:bg-[#0a84ff]/80'
                                            : 'bg-[#3a3a3c] text-white hover:bg-[#4a4a4c]'
                                    }`}
                                >
                                    {selectMode
                                        ? (t('library.cancelSelect') || 'Cancel')
                                        : (t('library.select') || 'Select')}
                                </button>
                            )}
                            {selectMode && selectedSkills.length > 0 && (
                                <button
                                    onClick={handleOpenBatchSync}
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[#0a84ff] text-white rounded-md text-[12px] font-medium hover:bg-[#0a84ff]/80 transition-colors"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                    </svg>
                                    {t('library.batchSync', {count: selectedSkills.length}) || `Sync (${selectedSkills.length})`}
                                </button>
                            )}
                            <button
                                onClick={() => setShowCreateSkill(true)}
                                className="flex items-center gap-1.5 px-3 py-1 bg-[#0a84ff] text-white rounded-md text-[12px] font-medium hover:bg-[#0a84ff]/80 transition-colors"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                     strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
                                </svg>
                                {t('library.create') || '创建'}
                            </button>
                            {skills.length > 0 && (
                                <button
                                    onClick={handleUpdateAllSkills}
                                    disabled={isRefreshing}
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[#3a3a3c] text-white rounded-md text-[12px] font-medium hover:bg-[#4a4a4c] transition-colors disabled:opacity-50"
                                >
                                    <svg
                                        className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                    </svg>
                                    {t('library.updateAll') || 'Update All'}
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto">
                {activeTab === 'mcp' ? (
                    // MCP Servers 列表
                    !hasLoaded ? (
                        <LoadingSkeleton/>
                    ) : servers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full">
                            <div className="w-12 h-12 rounded-full bg-[#3a3a3c] flex items-center justify-center mb-3">
                                <svg className="w-6 h-6 text-[#636366]" fill="none" viewBox="0 0 24 24"
                                     stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/>
                                </svg>
                            </div>
                            <p className="text-[13px] text-white mb-1">{t('installed.empty')}</p>
                            <p className="text-[12px] text-[#636366] mb-4">{t('installed.emptyHint')}</p>
                            <button onClick={() => navigate('/store')} className="btn btn-primary text-[13px]">
                                {t('installed.goToStore')}
                            </button>
                        </div>
                    ) : (
                        <div className="p-4">
                            <div className="card overflow-hidden">
                                {servers.map((server, index) => {
                                    const serverInfo = serverInfoMap.get(server.id);
                                    const isServerSelected = selectedServers.includes(server.id);
                                    return (
                                        <div
                                            key={server.id}
                                            className={`
                        flex items-center gap-3 px-4 py-3
                        ${serverSelectMode ? 'cursor-pointer' : server.isMcpDock ? 'cursor-pointer hover:bg-[#3a3a3c]/50' : ''}
                        transition-colors
                        ${index !== servers.length - 1 ? 'border-b border-[#3a3a3c]' : ''}
                        ${serverSelectMode && isServerSelected ? 'bg-[#0a84ff]/10' : ''}
                      `}
                                            onClick={() => serverSelectMode ? toggleServerSelect(server.id) : handleServerClick(server)}
                                        >
                                            {/* 选择模式：复选框 */}
                                            {serverSelectMode ? (
                                                <div className="flex-shrink-0">
                          <span
                              className={`w-4 h-4 rounded border flex items-center justify-center ${isServerSelected ? 'bg-[#0a84ff] border-[#0a84ff]' : 'border-[#636366]'}`}>
                            {isServerSelected && (
                                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd"
                                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                          clipRule="evenodd"/>
                                </svg>
                            )}
                          </span>
                                                </div>
                                            ) : (
                                                <div className="flex-shrink-0">
                                                    <ServerIcon server={server} serverInfo={serverInfo}/>
                                                </div>
                                            )}

                                            {/* 内容 */}
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-[13px] font-medium text-white truncate">
                                                    {getDisplayName(server.id)}
                                                </h3>
                                                {/* 已安装的客户端 */}
                                                <div className="flex items-center gap-2 mt-1">
                                                    {server.clients.map(clientId => (
                                                        <span key={clientId}
                                                              className="text-[11px] text-[#98989d] flex items-center gap-1">
                              <ClientIcon clientId={clientId} size={14}/>
                                                            {clients.find(c => c.id === clientId)?.name}
                            </span>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* 操作按钮区域 - AI-Tools 标志在最左边 */}
                                            {!serverSelectMode && (
                                                <div className="flex items-center gap-2 flex-shrink-0"
                                                     onClick={e => e.stopPropagation()}>
                                                    {/* 来源标记 - 最左边：手动安装 > AI-Tools（从商店安装统一显示） */}
                                                    {server.manual ? (
                                                        <span
                                                            className="tag tag-default">{t('library.manual') || 'Manual'}</span>
                                                    ) : (
                                                        <span className="tag tag-info">AI-Tools</span>
                                                    )}

                                                    {/* 操作按钮 */}
                                                    <button
                                                        onClick={() => {
                                                            const config = server.config;
                                                            const configStr = encodeURIComponent(JSON.stringify(config));
                                                            navigate(`/inspector?config=${configStr}`);
                                                        }}
                                                        className="p-1.5 rounded text-[#98989d] hover:text-[#0a84ff] hover:bg-[#0a84ff]/10 transition-colors"
                                                        title={t('installed.inspect') || 'Inspect'}
                                                    >
                                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                             stroke="currentColor" strokeWidth={1.5}>
                                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                                  d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"/>
                                                        </svg>
                                                    </button>

                                                    <button
                                                        onClick={() => handleEdit(server)}
                                                        className="p-1.5 rounded text-[#98989d] hover:text-white hover:bg-[#3a3a3c] transition-colors"
                                                        title={t('installed.edit')}
                                                    >
                                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                             stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                                        </svg>
                                                    </button>

                                                    {/* 同步到其他客户端（多客户端复用） */}
                                                    <button
                                                        onClick={() => handleOpenSync(server)}
                                                        className="p-1.5 rounded text-[#98989d] hover:text-[#0a84ff] hover:bg-[#0a84ff]/10 transition-colors"
                                                        title={t('installed.sync') || 'Sync'}
                                                    >
                                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                             stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                                  d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/>
                                                        </svg>
                                                    </button>

                                                    <button
                                                        onClick={() => openUninstall('mcp', server.id, getDisplayName(server.id), server.clients as string[])}
                                                        className="p-1.5 rounded text-[#ff3b30] hover:bg-[#ff3b30]/10 transition-colors"
                                                        title={t('installed.remove')}
                                                    >
                                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                             stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                                  d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                                                        </svg>
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )
                ) : (
                    // Skills 列表
                    !hasLoaded ? (
                        <LoadingSkeleton/>
                    ) : skills.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full">
                            <div className="w-12 h-12 rounded-full bg-[#3a3a3c] flex items-center justify-center mb-3">
                                <svg className="w-6 h-6 text-[#636366]" fill="none" viewBox="0 0 24 24"
                                     stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"/>
                                </svg>
                            </div>
                            <p className="text-[13px] text-white mb-1">{t('library.noSkills') || 'No skills installed'}</p>
                            <p className="text-[12px] text-[#636366] mb-4">{t('library.noSkillsHint') || 'Visit the store to discover and install skills'}</p>
                            <button onClick={() => navigate('/store')} className="btn btn-primary text-[13px]">
                                {t('installed.goToStore')}
                            </button>
                        </div>
                    ) : (
                        <div className="p-4">
                            <div className="card overflow-hidden">
                                {skills.map((skill, index) => {
                                    const isSelected = selectedSkills.includes(skill.name);
                                    const installedClients = skillClients[skill.name] || [];
                                    return (
                                        <div
                                            key={skill.name}
                                            className={`
                      flex items-center gap-3 px-4 py-3
                      ${selectMode ? 'cursor-pointer' : 'cursor-pointer hover:bg-[#3a3a3c]/50'}
                      transition-colors
                      ${index !== skills.length - 1 ? 'border-b border-[#3a3a3c]' : ''}
                      ${selectMode && isSelected ? 'bg-[#0a84ff]/10' : ''}
                    `}
                                            onClick={() => selectMode ? toggleSkillSelect(skill.name) : handleSkillClick(skill)}
                                        >
                                            {/* 选择模式：复选框 */}
                                            {selectMode ? (
                                                <div className="flex-shrink-0">
                        <span
                            className={`w-4 h-4 rounded border flex items-center justify-center ${isSelected ? 'bg-[#0a84ff] border-[#0a84ff]' : 'border-[#636366]'}`}>
                          {isSelected && (
                              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clipRule="evenodd"/>
                              </svg>
                          )}
                        </span>
                                                </div>
                                            ) : (
                                                <div className="flex-shrink-0">
                                                    <SkillIcon skill={skill}/>
                                                </div>
                                            )}

                                            {/* 内容 */}
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-[13px] font-medium text-white truncate">
                                                    {skill.name}
                                                </h3>
                                                {/* 已安装的客户端 */}
                                                <div className="flex items-center gap-2 mt-1">
                                                    {installedClients.map(clientId => (
                                                        <span key={clientId}
                                                              className="text-[11px] text-[#98989d] flex items-center gap-1">
                            <ClientIcon clientId={clientId} size={14}/>
                                                            {clients.find(c => c.id === clientId)?.name}
                          </span>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* 操作按钮区域（选择模式隐藏） */}
                                            {!selectMode && (
                                                <div className="flex items-center gap-2 flex-shrink-0"
                                                     onClick={e => e.stopPropagation()}>
                                                    {/* 来源标记 - 最左边 */}
                                                    {skill.source ? (
                                                        <span className="tag tag-info">AI-Tools</span>
                                                    ) : (
                                                        <span
                                                            className="tag tag-default">{t('library.manual') || 'Manual'}</span>
                                                    )}

                                                    {/* 更新按钮 */}
                                                    {skill.source && (
                                                        <button
                                                            onClick={() => handleUpdateSkill(skill.name)}
                                                            disabled={refreshingSkill === skill.name}
                                                            className="p-1.5 rounded text-[#98989d] hover:text-[#0a84ff] hover:bg-[#0a84ff]/10 transition-colors disabled:opacity-50"
                                                            title={t('library.update') || 'Update'}
                                                        >
                                                            <svg
                                                                className={`w-4 h-4 ${refreshingSkill === skill.name ? 'animate-spin' : ''}`}
                                                                fill="none"
                                                                viewBox="0 0 24 24"
                                                                stroke="currentColor"
                                                                strokeWidth={2}
                                                            >
                                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                                            </svg>
                                                        </button>
                                                    )}

                                                    {/* 编辑按钮（商店来源的 Skill 也可编辑；保存后转为手动安装） */}
                                                    <button
                                                        onClick={() => handleEditSkill(skill.name)}
                                                        className="p-1.5 rounded text-[#98989d] hover:text-white hover:bg-[#3a3a3c] transition-colors"
                                                        title={t('installed.edit')}
                                                    >
                                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                             stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                                        </svg>
                                                    </button>

                                                    {/* 同步到其他客户端 */}
                                                    {installedClients.length > 0 && (
                                                        <button
                                                            onClick={() => handleOpenSkillSync(skill.name)}
                                                            className="p-1.5 rounded text-[#98989d] hover:text-[#0a84ff] hover:bg-[#0a84ff]/10 transition-colors"
                                                            title={t('library.sync') || 'Sync to clients'}
                                                        >
                                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                                 stroke="currentColor" strokeWidth={2}>
                                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                                      d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/>
                                                            </svg>
                                                        </button>
                                                    )}

                                                    {/* 删除按钮 */}
                                                    <button
                                                        onClick={() => openUninstall('skill', skill.name, skill.name, installedClients as string[])}
                                                        className="p-1.5 rounded text-[#ff3b30] hover:bg-[#ff3b30]/10 transition-colors"
                                                        title={t('installed.remove')}
                                                    >
                                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                                                             stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                                  d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                                                        </svg>
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )
                )}
            </div>

            {/* 编辑模态框 */}
            <Modal
                isOpen={!!editingServer}
                onClose={() => setEditingServer(null)}
                title={`${t('installed.edit')}: ${editingServer ? getDisplayName(editingServer.id) : ''}`}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[#98989d]">
                        {t('installed.editHint')}
                    </p>
                    <textarea
                        value={editedConfig}
                        onChange={(e) => setEditedConfig(e.target.value)}
                        className="w-full h-48 px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white font-mono text-[12px] resize-none focus:border-[#0a84ff] transition-colors"
                        spellCheck={false}
                    />
                    <div className="flex justify-end gap-2">
                        <button onClick={() => setEditingServer(null)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button onClick={handleSaveEdit} className="btn btn-primary">
                            {t('common.save')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 同步模态框 */}
            <Modal
                isOpen={!!syncingServer}
                onClose={() => setSyncingServer(null)}
                title={t('installed.syncTitle') || 'Sync to Other Clients'}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[#98989d]">{t('installed.syncHint')}</p>

                    <div className="space-y-2">
                        {clients
                            .filter(c => c.installed && !syncingServer?.clients.includes(c.id))
                            .map(client => {
                                const isSelected = selectedSyncClients.includes(client.id);
                                return (
                                    <button
                                        key={client.id}
                                        onClick={() => toggleSyncClient(client.id)}
                                        className={`
                      w-full flex items-center gap-3 p-3 rounded-md border transition-all text-left
                      ${isSelected
                                            ? 'bg-[#0a84ff]/10 border-[#0a84ff]/30 text-[#0a84ff]'
                                            : 'bg-[#3a3a3c] border-[#3a3a3c] text-white hover:border-[#636366]'
                                        }
                    `}
                                    >
                                        <ClientIcon clientId={client.id} size={24}/>
                                        <span className="flex-1 text-[13px] font-medium">{client.name}</span>
                                        {isSelected && (
                                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd"
                                                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                      clipRule="evenodd"/>
                                            </svg>
                                        )}
                                    </button>
                                );
                            })}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setSyncingServer(null)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={handleSync}
                            disabled={selectedSyncClients.length === 0}
                            className="btn btn-primary disabled:opacity-50"
                        >
                            {t('installed.sync') || 'Sync'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 服务器批量同步模态框（多客户端复用） */}
            <Modal
                isOpen={serverSyncOpen}
                onClose={() => setServerSyncOpen(false)}
                title={t('installed.batchSyncTitle') || 'Sync Servers to Other Clients'}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[#98989d]">
                        {t('installed.batchSyncHint', {count: serverSyncList.length}) ||
                            `选择要将 ${serverSyncList.length} 个服务器同步到的客户端：`}
                    </p>

                    <div className="space-y-2">
                        {clients
                            .filter(c => {
                                if (!c.installed) return false;
                                // 已包含所有待同步服务器的客户端不再列出
                                const alreadyAll = serverSyncList.every(s => s.clients.includes(c.id));
                                return !alreadyAll;
                            })
                            .map(client => {
                                const isSelected = selectedSyncClients.includes(client.id);
                                return (
                                    <button
                                        key={client.id}
                                        onClick={() => toggleSyncClient(client.id)}
                                        className={`
                      w-full flex items-center gap-3 p-3 rounded-md border transition-all text-left
                      ${isSelected
                                            ? 'bg-[#0a84ff]/10 border-[#0a84ff]/30 text-[#0a84ff]'
                                            : 'bg-[#3a3a3c] border-[#3a3a3c] text-white hover:border-[#636366]'
                                        }
                    `}
                                    >
                                        <ClientIcon clientId={client.id} size={24}/>
                                        <span className="flex-1 text-[13px] font-medium">{client.name}</span>
                                        {isSelected && (
                                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd"
                                                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                      clipRule="evenodd"/>
                                            </svg>
                                        )}
                                    </button>
                                );
                            })}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setServerSyncOpen(false)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={handleConfirmServerSync}
                            disabled={selectedSyncClients.length === 0 || isSyncingServers}
                            className="btn btn-primary disabled:opacity-50"
                        >
                            {isSyncingServers
                                ? (t('installed.syncing') || 'Syncing...')
                                : (t('installed.sync') || 'Sync')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Skill 同步模态框（单条 + 批量共用） */}
            <Modal
                isOpen={syncModalOpen}
                onClose={() => setSyncModalOpen(false)}
                title={t('library.syncTitle') || 'Sync Skill to Other Clients'}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[#98989d]">
                        {t('library.syncHint', {count: syncModalSkills.length}) ||
                            `选择要将 ${syncModalSkills.length} 个 Skill 同步到的客户端：`}
                    </p>

                    <div className="space-y-2">
                        {clients
                            .filter(c => {
                                if (!c.installed || !c.supportsSkills) return false;
                                // 已包含所有待同步 Skill 的客户端不再列出
                                const alreadyAll = syncModalSkills.every(
                                    name => (skillClients[name] || []).includes(c.id as SkillClientType)
                                );
                                return !alreadyAll;
                            })
                            .map(client => {
                                const isSelected = selectedSyncClients.includes(client.id);
                                return (
                                    <button
                                        key={client.id}
                                        onClick={() => toggleSyncClient(client.id)}
                                        className={`
                      w-full flex items-center gap-3 p-3 rounded-md border transition-all text-left
                      ${isSelected
                                            ? 'bg-[#0a84ff]/10 border-[#0a84ff]/30 text-[#0a84ff]'
                                            : 'bg-[#3a3a3c] border-[#3a3a3c] text-white hover:border-[#636366]'
                                        }
                    `}
                                    >
                                        <ClientIcon clientId={client.id} size={24}/>
                                        <span className="flex-1 text-[13px] font-medium">{client.name}</span>
                                        {isSelected && (
                                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd"
                                                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                      clipRule="evenodd"/>
                                            </svg>
                                        )}
                                    </button>
                                );
                            })}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setSyncModalOpen(false)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={handleConfirmSync}
                            disabled={selectedSyncClients.length === 0 || isSyncing}
                            className="btn btn-primary disabled:opacity-50"
                        >
                            {isSyncing
                                ? (t('library.syncing') || 'Syncing...')
                                : (t('library.sync') || 'Sync')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 添加自定义服务器模态框 */}
            <AddServerModal
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
                onSubmit={handleAddServer}
                clients={clients}
                isLoading={isAddingServer}
            />

            {/* 创建 / 编辑自定义 Skill 模态框 */}
            {showCreateSkill && (
                <CreateSkillModal
                    onClose={() => setShowCreateSkill(false)}
                    clients={clients}
                    defaultClients={['cursor']}
                    onSubmit={handleCreateSkillSubmit}
                />
            )}
            {editingSkill && (
                <CreateSkillModal
                    onClose={() => setEditingSkill(null)}
                    clients={clients}
                    editData={editingSkill}
                    onSubmit={handleCreateSkillSubmit}
                />
            )}

            {/* 卸载客户端选择模态框（指定客户端卸载 / 全客户端卸载） */}
            <Modal
                isOpen={!!uninstallTarget}
                onClose={() => setUninstallTarget(null)}
                title={uninstallTarget?.type === 'skill' ? (t('library.uninstallTitle') || '卸载 Skill') : (t('installed.uninstallTitle') || '卸载服务器')}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[#98989d]">
                        {uninstallTarget?.type === 'skill'
                            ? (t('library.uninstallHint') || '选择要从哪些客户端卸载此 Skill：')
                            : (t('installed.uninstallHint') || '选择要从哪些客户端卸载此服务器：')}
                    </p>

                    <div className="flex items-center justify-between">
                        <span
                            className="text-[13px] text-white font-medium truncate">{uninstallTarget?.displayName}</span>
                        <button
                            onClick={() => uninstallTarget && setSelectedUninstallClients([...uninstallTarget.clients])}
                            className="text-[12px] text-[#0a84ff] hover:underline flex-shrink-0 ml-2"
                        >
                            {t('installed.selectAll') || '全选'}
                        </button>
                    </div>

                    <div className="space-y-2">
                        {(uninstallTarget?.clients || []).map(clientId => {
                            const client = clients.find(c => c.id === clientId);
                            const isSelected = selectedUninstallClients.includes(clientId);
                            return (
                                <button
                                    key={clientId}
                                    onClick={() => {
                                        setSelectedUninstallClients(prev =>
                                            isSelected ? prev.filter(c => c !== clientId) : [...prev, clientId]
                                        );
                                    }}
                                    className={`
                    w-full flex items-center gap-3 p-3 rounded-md border transition-all text-left
                    ${isSelected
                                        ? 'bg-[#ff3b30]/10 border-[#ff3b30]/30 text-[#ff3b30]'
                                        : 'bg-[#3a3a3c] border-[#3a3a3c] text-white hover:border-[#636366]'
                                    }
                  `}
                                >
                                    <ClientIcon clientId={clientId} size={24}/>
                                    <span className="flex-1 text-[13px] font-medium">{client?.name || clientId}</span>
                                    {isSelected && (
                                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd"
                                                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                  clipRule="evenodd"/>
                                        </svg>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setUninstallTarget(null)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={confirmUninstall}
                            disabled={selectedUninstallClients.length === 0}
                            className="btn btn-danger disabled:opacity-50"
                        >
                            {t('installed.confirmUninstall') || '确认卸载'}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
