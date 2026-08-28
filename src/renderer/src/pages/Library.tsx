/**
 * Library 页面 - Surge 风格
 * 管理已安装的 MCP Servers 和 Skills
 */

import {useEffect, useMemo, useState} from 'react';
import {useNavigate, useSearchParams} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import {
    type AnyClientId,
    type ClientInfo,
    getElectronAPI,
    type InstalledSkill,
    type McpServerConfig,
    type SkillClientType,
    useElectronAPI
} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {useStore} from '../store/useStore';
import Modal from '../components/Modal';
import AddServerModal from '../components/AddServerModal';
import {CreateSkillModal} from '../components/CreateSkillModal';
import {toast} from '../components/Toast';
import WindowControls from '../components/WindowControls';
import {type DataSource, fetchServerList, type ServerListItem} from '../api/registry';
import LibraryMcpList from '../components/LibraryMcpList';
import LibrarySkillList from '../components/LibrarySkillList';
import ClientPickerModal from '../components/ClientPickerModal';
import UninstallModal from '../components/UninstallModal';
import {useCloudUpload} from '../hooks/useCloudUpload';

export interface InstalledServer {
    id: string;
    config: McpServerConfig;
    clients: AnyClientId[];
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

// 服务器 / Skill 图标组件已抽到 components/ServerIcon.tsx 与 components/SkillIcon.tsx
// （P2-2），此处不再内联定义。

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
    const [editingServerId, setEditingServerId] = useState('');
    const [syncingServer, setSyncingServer] = useState<InstalledServer | null>(null);
    const [selectedSyncClients, setSelectedSyncClients] = useState<AnyClientId[]>([]);
    // MCP Server 多选 + 批量同步（多客户端复用）
    const [serverSelectMode, setServerSelectMode] = useState(false);
    const [selectedServers, setSelectedServers] = useState<string[]>([]);
    const [serverSyncOpen, setServerSyncOpen] = useState(false);
    const [serverSyncList, setServerSyncList] = useState<InstalledServer[]>([]);
    const [isSyncingServers, setIsSyncingServers] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const [isAddingServer, setIsAddingServer] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isUpdatingAll, setIsUpdatingAll] = useState(false);
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
    // cloudBusy / cloudUploadConfirmOpen / cloudConflictOpen / cloudConflicts /
    // conflictResolutions 等状态已收拢到 useCloudUpload hook（P2-2）。
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
                await handleRemoveServer(uninstallTarget.id, clients as AnyClientId[]);
            } else {
                await handleRemoveSkill(uninstallTarget.id, clients as SkillClientType[]);
            }
            // 卸载目标含云端存储：本地暂存区已删除，云端推送在后台异步进行，这里仅给出进行中反馈
            if (clients.includes('cloud')) {
                toast.success(t('library.cloudUninstallStarted') || '云端删除中…');
                pushCloudAsync(uninstallTarget.type === 'mcp' ? 'mcp' : 'skills');
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
    // 关键修复（P0-10）：serverLists 由另一个 effect 异步拉取，且首屏为空，
    // 必须把它纳入依赖——否则 loadData 闭包里 isMcpDockInstalled 永远拿到空列表，
    // 导致所有 server 的 isMcpDock 恒为 false、点击进不了详情页、徽章判错。
    useEffect(() => {
        loadData();
    }, [api, serverLists]);

    // 应用启动时主进程已在后台以云端为准拉取，拉取完成通知渲染层刷新本地暂存区展示
    useEffect(() => {
        const off = api.cloudSync.onPulled((result) => {
            if (result.ok) {
                console.log('[Library] cloud pulled on startup, refreshing');
                loadData();
            } else {
                console.warn('[Library] cloud pull on startup failed:', result.message);
            }
        });
        return off;
    }, [api]);

    const loadData = async () => {
        try {
            const [clientList, {servers: serverMap}, {byClient: skillsByClient}, manualServers] = await Promise.all([
                api.clients.getAll(true),
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
            toast.error('加载数据失败，请刷新重试');
        } finally {
            setHasLoaded(true);
        }
    };

    // 云上传 / 云同步逻辑（P2-2）：委托 useCloudUpload，返回所需状态与回调
    const cloud = useCloudUpload({activeTab, servers, skills, skillClients, loadData});
    const {
        cloudBusy,
        cloudUploadConfirmOpen,
        cloudConflictOpen,
        cloudConflicts,
        conflictResolutions,
        setCloudUploadConfirmOpen,
        setCloudConflictOpen,
        setConflictResolutions,
        handleCloudUpload,
        confirmCloudUpload,
        toggleConflictResolution,
        doCloudUploadResolved,
        pushCloudAsync,
        autoPushIfCloud,
    } = cloud;

    // 刷新数据（带动效）
    const handleRefresh = async () => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        const startTime = Date.now();
        try {
            await loadData();
        } catch (error) {
            console.error('Failed to refresh library:', error);
        } finally {
            const elapsed = Date.now() - startTime;
            if (elapsed < 600) {
                await new Promise(resolve => setTimeout(resolve, 600 - elapsed));
            }
            setIsRefreshing(false);
        }
    };

    // 编辑服务器
    const handleEdit = (server: InstalledServer) => {
        setEditingServer(server);
        setEditingServerId(server.id);
        setEditedConfig(JSON.stringify(server.config, null, 2));
    };

    // 保存编辑
    const handleSaveEdit = async () => {
        if (!editingServer) return;
        const newId = editingServerId.trim();
        if (!newId) {
            alert('Server name cannot be empty');
            return;
        }
        try {
            const newConfig = JSON.parse(editedConfig);
            const configChanged =
                JSON.stringify(newConfig) !== JSON.stringify(editingServer.config);
            const nameChanged = newId !== editingServer.id;

            if (nameChanged) {
                // 重命名：先安装新名称，再卸载旧名称
                for (const client of editingServer.clients) {
                    await api.config.installServer(newId, newConfig, [client]);
                }
                await api.config.uninstallServer(editingServer.id, editingServer.clients);
            } else {
                for (const client of editingServer.clients) {
                    await api.config.updateServer(editingServer.id, newConfig, client);
                }
            }
            // 仅当配置有修改时才标记为手动安装，避免线上更新覆盖本地调整
            if (configChanged || nameChanged) {
                await api.config.markServerManual(newId);
            }
            setEditingServer(null);
            loadData();
        } catch (error) {
            console.error('Failed to save config:', error);
            alert('Invalid JSON configuration');
        }
    };

    // 删除服务器
    const handleRemoveServer = async (serverId: string, clientsToRemove: AnyClientId[]) => {
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
            toast.error('移除服务器失败，请重试');
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
            toast.error('移除技能失败，请重试');
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

    // 更新所有 Skills（带旋转动效）——独立于刷新状态，避免与刷新按钮联动
    const handleUpdateAllSkills = async () => {
        setIsUpdatingAll(true);
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
            setIsUpdatingAll(false);
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
        const result = await api.skills.saveWithCloudSync(
            !!originalName,
            originalName,
            input,
            selected
        );
        if (result.success) {
            await loadData();
            // 云端同步提示（不影响本地保存成功）：
            // 现在保存后云端同步进入后台队列，状态在左侧「同步任务」面板跟踪。
            if (result.cloud) {
                if (result.cloud.enqueued) {
                    toast.info(t('library.cloudEnqueued') || '已加入后台同步队列，可在左侧「同步任务」查看');
                } else if (result.cloud.skipped) {
                    toast.info(result.cloud.message || (t('library.cloudSkipped') || '云端未配置，已跳过'));
                } else if (result.cloud.message) {
                    toast.warning(
                        `${t('library.cloudSyncFailed') || '云端同步失败'}：${result.cloud.message}`
                    );
                }
            }
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
            await autoPushIfCloud(selectedSyncClients, 'skills');
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
            await autoPushIfCloud(selectedSyncClients, 'mcp');
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

    // 导出 MCP 服务器
    const handleExportMcp = () => {
        const list = (serverSelectMode && selectedServers.length > 0)
            ? servers.filter(s => selectedServers.includes(s.id))
            : servers;
        if (list.length === 0) return;
        const exported: Record<string, McpServerConfig> = {};
        list.forEach(s => { exported[s.id] = s.config; });
        downloadJSON({ mcpServers: exported }, 'mcp-servers.json');
    };

    // 导出 Skills
    const handleExportSkills = () => {
        const list = (selectMode && selectedSkills.length > 0)
            ? skills.filter(s => selectedSkills.includes(s.name))
            : skills;
        if (list.length === 0) return;
        const exported = list.map(s => ({ name: s.name, path: s.path, source: s.source }));
        downloadJSON(exported, 'skills.json');
    };

    // 触发 JSON 文件下载
    const downloadJSON = (data: unknown, filename: string) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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
            await autoPushIfCloud(selectedSyncClients, 'mcp');
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
     * 云同步相关的 pushCloudAsync / autoPushIfCloud / doCloudUpload / doCloudUploadResolved /
     * toggleConflictResolution / handleCloudUpload / confirmCloudUpload 均已收拢到
     * useCloudUpload hook（P2-2），此处不再重复定义，统一通过上方解构的常量使用。
     */

    // 切换同步客户端选择
    const toggleSyncClient = (clientId: AnyClientId) => {
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
    const handleAddServer = async (serverId: string, config: McpServerConfig, targetClients: AnyClientId[]) => {
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

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部工具栏（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center justify-between gap-3 px-4 h-[38px] drag-region border-b border-[var(--color-border)] bg-[var(--color-bg)] sticky top-0 z-10 ${isMac ? 'pl-20' : 'pr-[140px]'}`}>
                <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden no-drag">
                    {/* Tab 切换 */}
                    <div className="flex items-center bg-[var(--color-surface-hover)] rounded-lg p-0.5 shrink-0">
                        <button
                            onClick={() => changeTab('mcp')}
                            className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                activeTab === 'mcp'
                                    ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]'
                                    : 'text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                            }`}
                        >
                            MCP Servers ({servers.length})
                        </button>
                        <button
                            onClick={() => changeTab('skills')}
                            className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                activeTab === 'skills'
                                    ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]'
                                    : 'text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                            }`}
                        >
                            Skills ({skills.length})
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 whitespace-nowrap no-drag">
                    {/* 刷新 */}
                    <button
                        onClick={handleRefresh}
                        disabled={isRefreshing}
                        title={t('library.refresh') || 'Refresh'}
                        className="p-1.5 rounded-md text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50"
                    >
                        <svg
                            className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round"
                                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                        </svg>
                    </button>
                    {/* 云端存储：在「设置 → 云同步」配置好后才出现 */}
                    {cloudAvailable && (
                        <>
                            <button
                                onClick={handleCloudUpload}
                                disabled={cloudBusy !== null}
                                title={activeTab === 'skills'
                                    ? '把当前库的 Skill 上传到云端 ai-tools 目录'
                                    : '把当前库的 MCP 上传到云端 ai-tools 目录'}
                                className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-surface-hover)] text-[var(--color-text)] rounded-md text-[12px] font-medium hover:bg-[var(--color-surface-active)] transition-colors disabled:opacity-50"
                            >
                                <svg className={`w-3.5 h-3.5 ${cloudBusy === 'push' ? 'animate-pulse' : ''}`}
                                     fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"/>
                                </svg>
                                {cloudBusy === 'push' ? '上传中…' : '云上传'}
                            </button>
                            <span className="w-px h-4 bg-[var(--color-surface-hover)]"/>
                        </>
                    )}
                    {activeTab === 'mcp' && (
                        <>
                            {servers.length > 0 && (
                                <button
                                    onClick={toggleServerSelectMode}
                                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                        serverSelectMode
                                            ? 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)]/80'
                                            : 'bg-[var(--color-surface-hover)] text-[var(--color-text)] hover:bg-[var(--color-surface-active)]'
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
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-accent)] text-white rounded-md text-[12px] font-medium hover:bg-[var(--color-accent)]/80 transition-colors"
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
                                className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-accent)] text-white rounded-md text-[12px] font-medium hover:bg-[var(--color-accent)]/80 transition-colors"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                     strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
                                </svg>
                                {t('library.create') || '创建'}
                            </button>
                            {servers.length > 0 && (
                                <button
                                    onClick={handleExportMcp}
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-surface-hover)] text-[var(--color-text)] rounded-md text-[12px] font-medium hover:bg-[var(--color-surface-active)] transition-colors"
                                    title={serverSelectMode && selectedServers.length > 0 ? '导出选中' : '导出全部'}
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/>
                                    </svg>
                                    {t('installed.export') || '导出'}
                                </button>
                            )}
                        </>
                    )}
                    {activeTab === 'skills' && (
                        <>
                            {skills.length > 0 && (
                                <button
                                    onClick={toggleSelectMode}
                                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                        selectMode
                                            ? 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)]/80'
                                            : 'bg-[var(--color-surface-hover)] text-[var(--color-text)] hover:bg-[var(--color-surface-active)]'
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
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-accent)] text-white rounded-md text-[12px] font-medium hover:bg-[var(--color-accent)]/80 transition-colors"
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
                                className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-accent)] text-white rounded-md text-[12px] font-medium hover:bg-[var(--color-accent)]/80 transition-colors"
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
                                    disabled={isUpdatingAll}
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-surface-hover)] text-[var(--color-text)] rounded-md text-[12px] font-medium hover:bg-[var(--color-surface-active)] transition-colors disabled:opacity-50"
                                >
                                    <svg
                                        className={`w-3.5 h-3.5 ${isUpdatingAll ? 'animate-spin' : ''}`}
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
                            {skills.length > 0 && (
                                <button
                                    onClick={handleExportSkills}
                                    className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-surface-hover)] text-[var(--color-text)] rounded-md text-[12px] font-medium hover:bg-[var(--color-surface-active)] transition-colors"
                                    title={selectMode && selectedSkills.length > 0 ? '导出选中' : '导出全部'}
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/>
                                    </svg>
                                    {t('installed.export') || '导出'}
                                </button>
                            )}
                        </>
                    )}
                </div>
                <WindowControls />
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto">
                {activeTab === 'mcp' ? (
                    <LibraryMcpList
                        servers={servers}
                        serverInfoMap={serverInfoMap}
                        hasLoaded={hasLoaded}
                        serverSelectMode={serverSelectMode}
                        selectedServers={selectedServers}
                        clients={clients}
                        onServerClick={handleServerClick}
                        onOpenSync={handleOpenSync}
                        onEdit={handleEdit}
                        onUninstall={openUninstall}
                        onToggleSelect={toggleServerSelect}
                        getDisplayName={getDisplayName}
                    />
                ) : (
                    <LibrarySkillList
                        skills={skills}
                        skillClients={skillClients}
                        hasLoaded={hasLoaded}
                        selectMode={selectMode}
                        selectedSkills={selectedSkills}
                        clients={clients}
                        refreshingSkill={refreshingSkill}
                        onSkillClick={handleSkillClick}
                        onEditSkill={handleEditSkill}
                        onUpdateSkill={handleUpdateSkill}
                        onOpenSkillSync={handleOpenSkillSync}
                        onUninstall={openUninstall}
                        onToggleSelect={toggleSkillSelect}
                    />
                )}
            </div>

            {/* 编辑模态框 */}
            <Modal
                isOpen={!!editingServer}
                onClose={() => setEditingServer(null)}
                title={`${t('installed.edit')}: ${editingServer ? getDisplayName(editingServer.id) : ''}`}
            >
                <div className="space-y-4">
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                            {t('installed.serverName') || 'Server Name'}
                        </label>
                        <input
                            type="text"
                            value={editingServerId}
                            onChange={(e) => setEditingServerId(e.target.value)}
                            className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[13px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                    </div>
                    <p className="text-[12px] text-[var(--color-muted2)]">
                        {t('installed.editHint')}
                    </p>
                    <textarea
                        value={editedConfig}
                        onChange={(e) => setEditedConfig(e.target.value)}
                        className="w-full h-48 px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] font-mono text-[12px] resize-none focus:border-[var(--color-accent)] transition-colors"
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

            {/* 同步模态框（单服务器同步到其他客户端） */}
            <ClientPickerModal
                open={!!syncingServer}
                title={t('installed.syncTitle') || 'Sync to Other Clients'}
                subtitle={t('installed.syncHint')}
                clients={clients.filter(c => c.installed && !syncingServer?.clients.includes(c.id))}
                selected={selectedSyncClients}
                onToggle={toggleSyncClient}
                onConfirm={handleSync}
                onClose={() => setSyncingServer(null)}
                confirmLabel={t('installed.sync') || 'Sync'}
                confirmDisabled={selectedSyncClients.length === 0}
            />

            {/* 服务器批量同步模态框（多客户端复用） */}
            <ClientPickerModal
                open={serverSyncOpen}
                title={t('installed.batchSyncTitle') || 'Sync Servers to Other Clients'}
                subtitle={t('installed.batchSyncHint', {count: serverSyncList.length}) ||
                    `选择要将 ${serverSyncList.length} 个服务器同步到的客户端：`}
                clients={clients.filter(c => {
                    if (!c.installed) return false;
                    const alreadyAll = serverSyncList.every(s => s.clients.includes(c.id));
                    return !alreadyAll;
                })}
                selected={selectedSyncClients}
                onToggle={toggleSyncClient}
                onConfirm={handleConfirmServerSync}
                onClose={() => setServerSyncOpen(false)}
                confirmLabel={isSyncingServers
                    ? (t('installed.syncing') || 'Syncing...')
                    : (t('installed.sync') || 'Sync')}
                confirmDisabled={selectedSyncClients.length === 0 || isSyncingServers}
            />

            {/* Skill 同步模态框（单条 + 批量共用） */}
            <ClientPickerModal
                open={syncModalOpen}
                title={t('library.syncTitle') || 'Sync Skill to Other Clients'}
                subtitle={t('library.syncHint', {count: syncModalSkills.length}) ||
                    `选择要将 ${syncModalSkills.length} 个 Skill 同步到的客户端：`}
                clients={clients.filter(c => {
                    if (!c.installed || !c.supportsSkills) return false;
                    const alreadyAll = syncModalSkills.every(
                        name => (skillClients[name] || []).includes(c.id as SkillClientType)
                    );
                    return !alreadyAll;
                })}
                selected={selectedSyncClients}
                onToggle={toggleSyncClient}
                onConfirm={handleConfirmSync}
                onClose={() => setSyncModalOpen(false)}
                confirmLabel={isSyncing
                    ? (t('library.syncing') || 'Syncing...')
                    : (t('library.sync') || 'Sync')}
                confirmDisabled={selectedSyncClients.length === 0 || isSyncing}
            />

            {/* 云上传确认：确认是否覆盖云端 */}
            <Modal
                isOpen={cloudUploadConfirmOpen}
                onClose={() => setCloudUploadConfirmOpen(false)}
                title={activeTab === 'skills'
                    ? (t('library.cloudUploadSkillConfirmTitle') || '确认是否覆盖云端 Skill')
                    : (t('library.cloudUploadMcpConfirmTitle') || '确认是否覆盖云端 MCP')}
            >
                <div className="space-y-4">
                    <p className="text-[13px] text-[var(--color-muted2)]">
                        {activeTab === 'skills'
                            ? (t('library.cloudUploadSkillConfirmMsg') ||
                                '此操作将把本地所有 Skill 上传到云端并覆盖现有内容，确认继续？')
                            : (t('library.cloudUploadMcpConfirmMsg') ||
                                '此操作将把本地所有 MCP 上传到云端并覆盖现有内容，确认继续？')}
                    </p>
                    <div className="flex justify-end gap-2 pt-2">
                        <button
                            onClick={() => setCloudUploadConfirmOpen(false)}
                            className="btn btn-secondary"
                            disabled={cloudBusy !== null}
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={confirmCloudUpload}
                            className="btn btn-primary disabled:opacity-50"
                            disabled={cloudBusy !== null}
                        >
                            {cloudBusy === 'push'
                                ? (t('library.cloudUploading') || '上传中…')
                                : (t('library.cloudUploadConfirmBtn') || '确认上传')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 云端冲突确认：同名 Skill 逐个选择覆盖/跳过 */}
            <Modal
                isOpen={cloudConflictOpen}
                onClose={() => setCloudConflictOpen(false)}
                title={t('library.cloudConflictTitle') || '云端 Skill 冲突确认'}
            >
                <div className="space-y-4">
                    <p className="text-[13px] text-[var(--color-muted2)]">
                        {t('library.cloudConflictHint') || '以下 Skill 在云端已存在同名版本，请逐个确认是否覆盖：'}
                    </p>
                    <div className="max-h-[300px] overflow-y-auto space-y-2">
                        {cloudConflicts.map(conflict => {
                            const isOverwrite = conflictResolutions[conflict.name] === 'overwrite';
                            const localTime = conflict.localUpdatedAt
                                ? new Date(conflict.localUpdatedAt).toLocaleString()
                                : '—';
                            const cloudTime = conflict.cloudUpdatedAt
                                ? new Date(conflict.cloudUpdatedAt).toLocaleString()
                                : '—';
                            const resolutionLabel = conflict.resolution === 'local_newer'
                                ? (t('library.cloudConflictLocalNewer') || '本地更新')
                                : conflict.resolution === 'cloud_newer'
                                    ? (t('library.cloudConflictCloudNewer') || '云端更新')
                                    : (t('library.cloudConflictSame') || '时间相同');
                            const resolutionColor = conflict.resolution === 'local_newer'
                                ? 'text-green-400'
                                : conflict.resolution === 'cloud_newer'
                                    ? 'text-orange-400'
                                    : 'text-[var(--color-muted2)]';

                            return (
                                <div
                                    key={conflict.name}
                                    className={`flex items-center gap-3 p-3 rounded-md border transition-all ${
                                        isOverwrite
                                            ? 'bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30'
                                            : 'bg-[var(--color-surface-hover)] border-[var(--color-border)] opacity-60'
                                    }`}
                                >
                                    <button
                                        onClick={() => toggleConflictResolution(conflict.name)}
                                        className="flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors"
                                        style={{
                                            borderColor: isOverwrite ? 'var(--color-accent)' : 'var(--color-muted)',
                                            backgroundColor: isOverwrite ? 'var(--color-accent)' : 'transparent',
                                        }}
                                    >
                                        {isOverwrite && (
                                            <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                                            </svg>
                                        )}
                                    </button>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[13px] font-medium text-[var(--color-text)] truncate">
                                            {conflict.name}
                                        </div>
                                        <div className="flex flex-col gap-0.5 mt-1">
                                            <span className="text-[11px] text-[var(--color-muted2)]">
                                                {t('library.cloudConflictLocalTime') || '本地时间'}: {localTime}
                                            </span>
                                            <span className="text-[11px] text-[var(--color-muted2)]">
                                                {t('library.cloudConflictCloudTime') || '云端时间'}: {cloudTime}
                                            </span>
                                            <span className={`text-[11px] font-medium ${resolutionColor}`}>
                                                {resolutionLabel}
                                            </span>
                                        </div>
                                    </div>
                                    <span className={`flex-shrink-0 text-[12px] font-medium px-2 py-0.5 rounded ${
                                        isOverwrite
                                            ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                                            : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)]'
                                    }`}>
                                        {isOverwrite
                                            ? (t('library.cloudConflictOverwrite') || '覆盖')
                                            : (t('library.cloudConflictSkip') || '跳过')}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    <div className="flex justify-between items-center pt-2">
                        <div className="flex gap-2">
                            <button
                                onClick={() => {
                                    const all: Record<string, 'overwrite' | 'skip'> = {};
                                    cloudConflicts.forEach(c => { all[c.name] = 'overwrite'; });
                                    setConflictResolutions(all);
                                }}
                                className="text-[12px] text-[var(--color-accent)] hover:underline"
                            >
                                {t('library.cloudConflictSelectAll') || '全选覆盖'}
                            </button>
                            <button
                                onClick={() => {
                                    const all: Record<string, 'overwrite' | 'skip'> = {};
                                    cloudConflicts.forEach(c => { all[c.name] = 'skip'; });
                                    setConflictResolutions(all);
                                }}
                                className="text-[12px] text-[var(--color-muted2)] hover:underline"
                            >
                                {t('library.cloudConflictSkipAll') || '全部跳过'}
                            </button>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setCloudConflictOpen(false)}
                                className="btn btn-secondary"
                                disabled={cloudBusy !== null}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={doCloudUploadResolved}
                                className="btn btn-primary disabled:opacity-50"
                                disabled={cloudBusy !== null}
                            >
                                {cloudBusy === 'push'
                                    ? (t('library.cloudUploading') || '上传中…')
                                    : (t('library.cloudUploadConfirmBtn') || '确认上传')}
                            </button>
                        </div>
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
            <UninstallModal
                open={!!uninstallTarget}
                title={uninstallTarget?.type === 'skill' ? (t('library.uninstallTitle') || '卸载 Skill') : (t('installed.uninstallTitle') || '卸载服务器')}
                subtitle={uninstallTarget?.type === 'skill'
                    ? (t('library.uninstallHint') || '选择要从哪些客户端卸载此 Skill：')
                    : (t('installed.uninstallHint') || '选择要从哪些客户端卸载此服务器：')}
                displayName={uninstallTarget?.displayName || ''}
                clients={(uninstallTarget?.clients || [])
                    .map(clientId => clients.find(c => c.id === clientId))
                    .filter((c): c is ClientInfo => !!c)}
                selected={selectedUninstallClients}
                onToggle={(id) => setSelectedUninstallClients(prev =>
                    prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
                )}
                onSelectAll={() => uninstallTarget && setSelectedUninstallClients([...uninstallTarget.clients])}
                onClose={() => setUninstallTarget(null)}
                onConfirm={confirmUninstall}
            />
        </div>
    );
}
