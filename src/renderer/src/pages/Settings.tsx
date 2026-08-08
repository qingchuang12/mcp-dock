/**
 * 设置页面 - Surge 风格
 */

import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {type AllRuntimes, type ClientInfo, type SkillClientType, useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {clearCache} from '../api/registry';
import ClientIcon from '../components/ClientIcon';
import RuntimeIcon from '../components/RuntimeIcon';
import Modal from '../components/Modal';
import {toast} from '../components/Toast';
import mcpDockIcon from '../../assets/icons/mcp-dock.svg';
import TokenManager from '../components/TokenManager';
import ConnectionManager from '../components/ConnectionManager';
import McpSourceManager from '../components/McpSourceManager';
import CloudSyncManager from '../components/CloudSyncManager';
import WindowControls from '../components/WindowControls';
import {useStore, type ThemeMode} from '../store/useStore';

export default function Settings() {
    const {t, i18n} = useTranslation();
    const api = useElectronAPI();
    const isMac = useIsMac();


    const [runtimes, setRuntimes] = useState<AllRuntimes | null>(null);
    const [clients, setClients] = useState<ClientInfo[]>([]);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const [version, setVersion] = useState('');

    // 配置弹窗状态
    const [editingClient, setEditingClient] = useState<ClientInfo | null>(null);
    const [editMcpPath, setEditMcpPath] = useState('');
    const [editSkillsPath, setEditSkillsPath] = useState('');

    // 未安装客户端折叠状态
    const [showUninstalled, setShowUninstalled] = useState(false);

    // 关于弹窗
    const [showAbout, setShowAbout] = useState(false);

    useEffect(() => {
        loadData(true);
    }, [api]);

    const loadData = async (isInitial = false) => {
        try {
            const [runtimeInfo, clientList, appVersion] = await Promise.all([
                api.env.getAllRuntimes(),
                api.clients.getAll(),
                api.system.getVersion(),
            ]);
            setRuntimes(runtimeInfo);
            // 云端存储在下方「云同步」卡片单独配置，不混入客户端列表
            setClients(clientList.filter(c => c.id !== 'cloud'));
            setVersion(appVersion);
        } catch (error) {
            console.error('Failed to load settings data:', error);
        } finally {
            if (isInitial) {
                setIsInitialLoading(false);
            }
        }
    };

    // 刷新数据（带动效）
    const handleRefresh = async () => {
        setIsRefreshing(true);
        const startTime = Date.now();

        try {
            const [runtimeInfo, clientList, appVersion] = await Promise.all([
                api.env.getAllRuntimes(),
                api.clients.getAll(),
                api.system.getVersion(),
            ]);

            // 确保动画至少持续2秒
            const elapsed = Date.now() - startTime;
            if (elapsed < 2000) {
                await new Promise(resolve => setTimeout(resolve, 2000 - elapsed));
            }

            setRuntimes(runtimeInfo);
            // 云端存储在下方「云同步」卡片单独配置，不混入客户端列表
            setClients(clientList.filter(c => c.id !== 'cloud'));
            setVersion(appVersion);
            toast.success(t('settings.refreshed') || 'Settings refreshed');
        } catch (error) {
            console.error('Failed to refresh settings data:', error);
            toast.error(t('settings.refreshFailed') || 'Failed to refresh');
        } finally {
            setIsRefreshing(false);
        }
    };

    /** MCP / Skill 源增删改后清缓存，让 Store 页重新拉取列表 */
    const handleSourcesChanged = () => {
        clearCache();
    };

    const handleLanguageChange = (lang: string) => {
        i18n.changeLanguage(lang);
        localStorage.setItem('language', lang);
    };

    // 打开配置弹窗
    const openEditModal = (client: ClientInfo) => {
        setEditingClient(client);
        setEditMcpPath(client.configPath || '');
        setEditSkillsPath(client.skillsPath || '');
    };

    // 保存配置
    const saveClientConfig = async () => {
        if (!editingClient) return;

        try {
            // 保存 MCP Config 路径
            if (editMcpPath !== editingClient.configPath) {
                await api.clients.setCustomPath(editingClient.id, editMcpPath || null);
            }

            // 保存 Skills 目录（如果支持）
            if (editingClient.supportsSkills && editSkillsPath !== editingClient.skillsPath) {
                await api.clients.setCustomSkillsPath(editingClient.id as SkillClientType, editSkillsPath || null);
            }

            await loadData();
            setEditingClient(null);
        } catch (error) {
            console.error('Failed to save client config:', error);
        }
    };

    const currentLang = i18n.language;

    // 主题（浅色 / 暗色 / 自动随系统）
    const theme = useStore((s) => s.theme);
    const setTheme = useStore((s) => s.setTheme);
    const handleThemeChange = (mode: ThemeMode) => setTheme(mode);

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center px-4 h-[38px] drag-region relative border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-xl ${isMac ? 'pl-20' : 'pr-[140px]'}`}>
                <h1 className="text-[14px] font-semibold text-[var(--color-text)] tracking-tight no-drag">
                    {t('settings.title')}
                </h1>
                <WindowControls />
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto">
                <div className="p-4 space-y-4">
                    {/* 语言设置 */}
                    <div className="card p-4">
                        <h2 className="text-[13px] font-semibold text-[var(--color-text)] mb-1">
                            {t('settings.language')}
                        </h2>
                        <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                            {t('settings.languageDesc')}
                        </p>

                        <div className="flex gap-2">
                            <button
                                onClick={() => handleLanguageChange('en')}
                                className={`
                  flex-1 px-3 py-2 rounded-md text-[13px] font-medium transition-colors
                  ${currentLang === 'en'
                                    ? 'bg-[var(--color-accent)] text-white'
                                    : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                                }
                `}
                            >
                                {t('settings.english')}
                            </button>
                            <button
                                onClick={() => handleLanguageChange('zh')}
                                className={`
                  flex-1 px-3 py-2 rounded-md text-[13px] font-medium transition-colors
                  ${currentLang === 'zh'
                                    ? 'bg-[var(--color-accent)] text-white'
                                    : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                                }
                `}
                            >
                                {t('settings.chinese')}
                            </button>
                        </div>
                    </div>

                    {/* 主题设置 */}
                    <div className="card p-4">
                        <h2 className="text-[13px] font-semibold text-[var(--color-text)] mb-1">
                            {t('settings.theme')}
                        </h2>
                        <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                            {t('settings.themeDesc')}
                        </p>

                        <div className="flex gap-2">
                            {(['light', 'dark', 'auto'] as ThemeMode[]).map((mode) => (
                                <button
                                    key={mode}
                                    onClick={() => handleThemeChange(mode)}
                                    className={`
                  flex-1 px-3 py-2 rounded-md text-[13px] font-medium transition-colors
                  ${theme === mode
                                        ? 'bg-[var(--color-accent)] text-white'
                                        : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                                    }
                `}
                                >
                                    {t(`settings.theme_${mode}`)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 客户端配置 */}
                    <div className="card overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
                            <div>
                                <h2 className="text-[13px] font-semibold text-[var(--color-text)]">
                                    {t('settings.clients') || 'Supported Clients'}
                                </h2>
                                <p className="text-[12px] text-[var(--color-muted)] mt-0.5">
                                    {t('settings.clientsDesc')}
                                </p>
                            </div>
                            <button
                                onClick={handleRefresh}
                                disabled={isRefreshing}
                                className="p-1.5 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50"
                            >
                                <svg
                                    className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                </svg>
                            </button>
                        </div>

                        {isInitialLoading && clients.length === 0 ? (
                            <div className="p-4">
                                <div className="grid grid-cols-2 gap-2">
                                    {Array.from({length: 4}).map((_, index) => (
                                        <div key={index}
                                             className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[var(--color-surface-hover)]/30 animate-pulse">
                                            <div className="w-7 h-7 rounded-md bg-[var(--color-surface-hover)] flex-shrink-0"/>
                                            <div className="flex-1 space-y-1.5">
                                                <div className="h-3.5 w-16 bg-[var(--color-surface-hover)] rounded"/>
                                                <div className="h-2.5 w-24 bg-[var(--color-surface-hover)] rounded"/>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <>
                                {/* 已安装客户端 - 网格布局 */}
                                {clients.filter(c => c.installed).length > 0 && (
                                    <div className="p-3">
                                        <div className="grid grid-cols-2 gap-2">
                                            {clients.filter(c => c.installed).map(client => (
                                                <div
                                                    key={client.id}
                                                    className="group flex items-center gap-2.5 p-2.5 rounded-lg bg-[var(--color-surface-hover)]/40 hover:bg-[var(--color-surface-hover)]/60 transition-colors"
                                                >
                                                    <div className="relative flex-shrink-0">
                                                        <ClientIcon clientId={client.id} size={28}/>
                                                        {client.configExists && (
                                                            <span
                                                                className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#34c759] border-2 border-[var(--color-surface)]"/>
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-1.5">
                                                            <span
                                                                className="text-[12px] font-medium text-[var(--color-text)] truncate">{client.name}</span>
                                                        </div>
                                                        <code
                                                            className="text-[9px] text-[var(--color-muted)] font-mono truncate block">
                                                            {client.configPath?.replace(/^.*[/\\]/, '') || ''}
                                                        </code>
                                                    </div>
                                                    <button
                                                        onClick={() => openEditModal(client)}
                                                        className="p-1 rounded text-[var(--color-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-all"
                                                        title={t('settings.editPath') || 'Edit config path'}
                                                    >
                                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24"
                                                             stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round"
                                                                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                                        </svg>
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* 未安装客户端 - 可折叠区域 */}
                                {clients.filter(c => !c.installed).length > 0 && (
                                    <>
                                        <button
                                            onClick={() => setShowUninstalled(!showUninstalled)}
                                            className="w-full flex items-center justify-between px-4 py-2.5 border-t border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]/30 transition-colors"
                                        >
                      <span className="text-[12px] text-[var(--color-muted)]">
                        {t('settings.uninstalledClients') || `${clients.filter(c => !c.installed).length} more clients not installed`}
                      </span>
                                            <svg
                                                className={`w-3.5 h-3.5 text-[var(--color-muted)] transition-transform ${showUninstalled ? 'rotate-180' : ''}`}
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                            >
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M19.5 8.25l-7.5 7.5-7.5-7.5"/>
                                            </svg>
                                        </button>

                                        {showUninstalled && (
                                            <div className="px-3 pb-3">
                                                <div className="grid grid-cols-3 gap-1.5">
                                                    {clients.filter(c => !c.installed).map(client => (
                                                        <div
                                                            key={client.id}
                                                            className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-[var(--color-surface-hover)]/20"
                                                        >
                                                            <ClientIcon clientId={client.id} size={20}
                                                                        className="opacity-40 flex-shrink-0"/>
                                                            <span
                                                                className="text-[12px] text-[var(--color-muted)] truncate">{client.name}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </div>

                    {/* 运行时环境 */}
                    <div className="card overflow-hidden">
                        <div className="px-4 py-3 border-b border-[var(--color-border)]">
                            <h2 className="text-[13px] font-semibold text-[var(--color-text)]">
                                {t('settings.runtimes')}
                            </h2>
                            <p className="text-[12px] text-[var(--color-muted)] mt-0.5">
                                {t('settings.runtimesDesc')}
                            </p>
                        </div>

                        {isInitialLoading && !runtimes ? (
                            // 初始加载时显示骨架屏
                            <>
                                <div
                                    className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] animate-pulse">
                                    <div className="flex items-center gap-3">
                                        <div className="w-6 h-6 rounded bg-[var(--color-surface-hover)]"/>
                                        <div className="h-4 w-20 bg-[var(--color-surface-hover)] rounded"/>
                                    </div>
                                    <div className="h-4 w-12 bg-[var(--color-surface-hover)] rounded"/>
                                </div>
                                <div className="flex items-center justify-between px-4 py-3 animate-pulse">
                                    <div className="flex items-center gap-3">
                                        <div className="w-6 h-6 rounded bg-[var(--color-surface-hover)]"/>
                                        <div className="h-4 w-20 bg-[var(--color-surface-hover)] rounded"/>
                                    </div>
                                    <div className="h-4 w-12 bg-[var(--color-surface-hover)] rounded"/>
                                </div>
                            </>
                        ) : runtimes && (
                            <>
                                <RuntimeRow name="Node.js" runtime="node" info={runtimes.node}/>
                                <RuntimeRow name="Python" runtime="python" info={runtimes.python}/>
                                <RuntimeRow name="Git" runtime="git" info={runtimes.git} isLast/>
                            </>
                        )}
                    </div>

                    {/* API 令牌 */}
                    <TokenManager/>

                    {/* MCP 源管理 */}
                    <McpSourceManager onChanged={handleSourcesChanged}/>

                    {/* Skill 源管理 */}
                    <ConnectionManager onChanged={handleSourcesChanged}/>

                    {/* 云同步 */}
                    <CloudSyncManager runtimes={runtimes} onChanged={() => loadData()}/>

                    {/* 关于 */}
                    <div
                        className="card p-4 cursor-pointer hover:bg-[var(--color-surface-hover)]/40 transition-colors"
                        onClick={() => setShowAbout(true)}
                    >
                        <div className="flex items-center gap-3">
                            <img src={mcpDockIcon} alt="AI-Tools" className="w-10 h-10 rounded-lg"/>
                            <div>
                                <h3 className="text-[13px] font-semibold text-[var(--color-text)]">{t('settings.about')}</h3>
                                <p className="text-[12px] text-[var(--color-muted)]">{version ? `v${version}` : 'Loading...'}</p>
                            </div>
                            <svg className="ml-auto w-4 h-4 text-[var(--color-muted)]" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/>
                            </svg>
                        </div>
                    </div>
                </div>
            </div>

            {/* 客户端配置弹窗 */}
            <Modal
                isOpen={!!editingClient}
                onClose={() => setEditingClient(null)}
                title={`${t('settings.editPath') || 'Edit'}: ${editingClient?.name || ''}`}
            >
                <div className="space-y-4">
                    <p className="text-[12px] text-[var(--color-muted2)]">
                        {t('settings.editPathHint') || 'Customize the configuration paths for this client.'}
                    </p>

                    {/* MCP Config 路径 */}
                    <div>
                        <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                            {t('settings.mcpConfigPath')}
                        </label>
                        <input
                            type="text"
                            value={editMcpPath}
                            onChange={(e) => setEditMcpPath(e.target.value)}
                            className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] font-mono text-[12px] focus:border-[var(--color-accent)] transition-colors"
                            placeholder={t('settings.enterCustomPath') || 'Enter custom config path...'}
                        />
                    </div>

                    {/* Skills 目录（仅支持 Skills 的客户端显示） */}
                    {editingClient?.supportsSkills && (
                        <div>
                            <label className="block text-[12px] text-[var(--color-muted2)] mb-1.5">
                                {t('settings.skillsDirectory')}
                            </label>
                            <input
                                type="text"
                                value={editSkillsPath}
                                onChange={(e) => setEditSkillsPath(e.target.value)}
                                className="w-full px-3 py-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] font-mono text-[12px] focus:border-[var(--color-accent)] transition-colors"
                                placeholder={t('settings.enterSkillsPath') || 'Enter custom skills directory...'}
                            />
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => setEditingClient(null)} className="btn btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button onClick={saveClientConfig} className="btn btn-primary">
                            {t('common.save')}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* 关于弹窗 */}
            <Modal
                isOpen={showAbout}
                onClose={() => setShowAbout(false)}
                title={t('settings.aboutTitle')}
            >
                <div className="flex flex-col items-center text-center">
                    <img src={mcpDockIcon} alt="AI-Tools" className="w-16 h-16 rounded-2xl mb-3"/>
                    <h3 className="text-[16px] font-semibold text-[var(--color-text)]">AI-Tools</h3>
                    <p className="text-[12px] text-[var(--color-muted2)] mt-0.5">{version ? `Version ${version}` : 'Loading...'}</p>
                    <p className="text-[12px] text-[var(--color-muted2)] mt-3 leading-relaxed">
                        {t('settings.aboutIntro')}
                    </p>
                    <div className="w-full mt-4 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-left">
                        <p className="text-[12px] text-[var(--color-muted2)] font-medium">License</p>
                        <p className="text-[12px] text-[var(--color-muted)] mt-1.5 leading-relaxed break-all">
                            {t('settings.aboutLicense')}
                        </p>
                    </div>
                    <p className="text-[12px] text-[var(--color-muted)] mt-4 leading-relaxed whitespace-pre-line">
                        {t('settings.aboutCopyright')}
                    </p>
                    <a
                        href="mailto:qingchuang12@gmail.com"
                        className="mt-4 text-[12px] text-[var(--color-accent)] hover:underline"
                    >
                        {t('settings.aboutEmail')}
                    </a>
                </div>
            </Modal>
        </div>
    );
}

// 运行时行组件
function RuntimeRow({
                        name,
                        runtime,
                        info,
                        isLast = false,
                    }: {
    name: string;
    runtime: 'node' | 'python' | 'git';
    info: { available: boolean; version: string | null; path: string | null };
    isLast?: boolean;
}) {
    return (
        <div className={`flex items-center justify-between px-4 py-3 ${!isLast ? 'border-b border-[var(--color-border)]' : ''}`}>
            <div className="flex items-center gap-3">
                <RuntimeIcon runtime={runtime} size={24}/>
                <div>
                    <span className="text-[13px] font-medium text-[var(--color-text)]">{name}</span>
                    {info.path && (
                        <p className="text-[12px] text-[var(--color-muted)] font-mono truncate max-w-[200px]">
                            {info.path}
                        </p>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
                {info.available ? (
                    <>
            <span className="text-[12px] text-[var(--color-muted2)]">
              v{info.version}
            </span>
                        <span className="status-dot active"/>
                    </>
                ) : (
                    <span className="status-dot inactive"/>
                )}
            </div>
        </div>
    );
}
