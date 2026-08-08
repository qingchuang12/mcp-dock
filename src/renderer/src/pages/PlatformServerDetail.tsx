/**
 * 平台 MCP Server 详情页（如 ModelScope MCP 广场）
 * 复用设置下的连接令牌获取详情，支持一键安装 / 卸载。
 * 安装配置直接来自平台返回的 server_config（command / args / env）。
 */

import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {
    type ClientInfo,
    type ClientType,
    type McpServerConfig,
    type PlatformServerDetail as PlatformServerDetailType,
    type RuntimeInfo,
    useElectronAPI,
} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import {useStore} from '../store/useStore';
import Modal from '../components/Modal';
import ClientIcon from '../components/ClientIcon';
import {BackIcon, CheckIcon, ExternalLinkIcon, GitHubIcon, StarIcon, VerifiedIcon} from '../components/Icons';
import {toast} from '../components/Toast';
import WindowControls from '../components/WindowControls';

// 根据命令推断所需运行时
function commandToRuntime(cmd: string): 'node' | 'python' | 'docker' {
    const c = cmd.toLowerCase();
    if (c === 'docker') return 'docker';
    if (c === 'uvx' || c === 'python' || c === 'python3' || c === 'pip' || c === 'uv') return 'python';
    return 'node'; // npx / node / bun / deno 等
}

// 将平台命令映射为本地可执行文件路径
async function resolveCommand(
    cmd: string,
    getNpxPath: () => Promise<string>,
    getUvxPath: () => Promise<string>
): Promise<string> {
    if (cmd === 'npx') return getNpxPath();
    if (cmd === 'uvx') return getUvxPath();
    return cmd;
}

function formatNumber(count: number): string {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
}

function PlatformIcon({name, iconUrl}: { name: string; iconUrl?: string }) {
    const [imgError, setImgError] = useState(false);
    if (iconUrl && !imgError) {
        return (
            <img
                src={iconUrl}
                alt={name}
                className="w-12 h-12 rounded-xl object-cover"
                onError={() => setImgError(true)}
            />
        );
    }
    const initial = name.charAt(0).toUpperCase();
    const colors = ['bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500', 'bg-pink-500'];
    const colorIndex = name.charCodeAt(0) % colors.length;
    return (
        <div
            className={`w-12 h-12 rounded-xl ${colors[colorIndex]} flex items-center justify-center text-[var(--color-text)] font-bold text-lg`}>
            {initial}
        </div>
    );
}

interface Props {
    connId: string;
    serverId: string;
}

export default function PlatformServerDetail({connId, serverId}: Props) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const api = useElectronAPI();
    const isMac = useIsMac();
    const {addInstalledServerId, removeInstalledServerId} = useStore();

    const [clients, setClients] = useState<ClientInfo[]>([]);
    const [selectedClients, setSelectedClients] = useState<ClientType[]>([]);
    const [installedClients, setInstalledClients] = useState<ClientType[]>([]);
    const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
    const [isInstalling, setIsInstalling] = useState(false);
    const [isUninstalling, setIsUninstalling] = useState(false);
    const [installError, setInstallError] = useState<string | null>(null);
    const [showInstallModal, setShowInstallModal] = useState(false);
    const [iconError] = useState(false);
    // 环境变量表单（envSchema 有必填项时让用户填写）
    const [envInputs, setEnvInputs] = useState<Record<string, string>>({});

    const {data: detail, isLoading, error} = useQuery({
        queryKey: ['platformServerDetail', connId, serverId],
        queryFn: () => api.apiConnections.getServerDetail(connId, serverId) as Promise<PlatformServerDetailType>,
        retry: 1,
    });

    // 加载已安装客户端
    const refreshInstalledClients = async () => {
        try {
            const {servers} = await api.config.getAllServers();
            const info = servers[serverId];
            setInstalledClients(info ? info.clients : []);
        } catch (e) {
            console.error('Failed to get installed clients:', e);
        }
    };

    useEffect(() => {
        api.clients.getAll().then(setClients);
        refreshInstalledClients();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, serverId, connId]);

    // 运行时检测 + 初始化环境变量表单
    useEffect(() => {
        if (!detail?.install) {
            setRuntimeInfo(null);
            return;
        }
        const runtime = commandToRuntime(detail.install.command);
        if (runtime === 'docker') {
            setRuntimeInfo({available: true, version: null, path: 'docker'});
        } else {
            api.env.checkRuntime(runtime).then(setRuntimeInfo);
        }
        const initEnv: Record<string, string> = {...(detail.install.env ?? {})};
        setEnvInputs(initEnv);
    }, [detail, api]);

    // 默认选中已安装客户端
    useEffect(() => {
        // 排除云端存储：它不是真实客户端，安装目标默认不应落到云端
        const installed = clients.filter(c => c.installed && c.id !== 'cloud').map(c => c.id);
        if (installed.length > 0 && selectedClients.length === 0) {
            if (installed.includes('cursor')) setSelectedClients(['cursor']);
            else if (installed.includes('claude-code')) setSelectedClients(['claude-code']);
            else setSelectedClients([installed[0]]);
        }
    }, [clients]);

    const toggleClient = (id: ClientType) => {
        setSelectedClients(prev => (prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]));
    };

    const envProps = (detail?.envSchema?.properties ?? {}) as Record<string, {
        description?: string;
        [k: string]: unknown
    }>;
    const requiredEnv = detail?.envSchema?.required ?? [];
    const hasEnvForm = Object.keys(envProps).length > 0;

    const handleInstall = async () => {
        if (!detail?.install) return;
        const targets = selectedClients.filter(c => !installedClients.includes(c));
        if (targets.length === 0) {
            setInstallError(t('detail.selectAtLeastOne') || '请至少选择一个客户端');
            return;
        }
        // 校验必填环境变量
        for (const key of requiredEnv) {
            if (!envInputs[key]) {
                setInstallError(`${t('detail.envRequired') || '请填写必填环境变量'}：${key}`);
                return;
            }
        }

        setIsInstalling(true);
        setInstallError(null);
        try {
            const command = await resolveCommand(
                detail.install.command,
                api.env.getNpxPath,
                api.env.getUvxPath
            );
            const env: Record<string, string> = {...(detail.install.env ?? {})};
            for (const k of Object.keys(envProps)) {
                if (envInputs[k]) env[k] = envInputs[k];
            }
            const config: McpServerConfig = {
                command,
                args: detail.install.args,
                ...(Object.keys(env).length > 0 ? {env} : {}),
            };
            const result = await api.config.installServer(serverId, config, targets);
            if (result.success.length > 0) {
                addInstalledServerId(serverId);
                await refreshInstalledClients();
                setShowInstallModal(false);
                toast.success(t('detail.installSuccess') || 'Installed successfully');
            }
            if (result.failed.length > 0) {
                setInstallError(`安装失败：${result.failed.join(', ')}`);
            }
        } catch (e) {
            console.error('Install failed:', e);
            setInstallError(String(e));
        } finally {
            setIsInstalling(false);
        }
    };

    const handleUninstall = async () => {
        if (installedClients.length === 0) return;
        if (!confirm(t('installed.confirmRemove'))) return;
        setIsUninstalling(true);
        try {
            await api.config.uninstallServer(serverId, installedClients);
            await refreshInstalledClients();
            const {servers} = await api.config.getAllServers();
            if (!servers[serverId]) removeInstalledServerId(serverId);
        } catch (e) {
            console.error('Uninstall failed:', e);
        } finally {
            setIsUninstalling(false);
        }
    };

    const openInspector = () => {
        if (!detail?.install) return;
        const config: { command: string; args?: string[]; env?: Record<string, string> } = {
            command: detail.install.command,
            args: detail.install.args,
            ...(detail.install.env ? {env: detail.install.env} : {}),
        };
        const configStr = encodeURIComponent(JSON.stringify(config));
        navigate(`/inspector?config=${configStr}`);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[#0a84ff] rounded-full animate-spin"/>
            </div>
        );
    }

    if (error || !detail) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[var(--color-bg)]">
                <div className="w-12 h-12 rounded-full bg-[#ff3b30]/10 flex items-center justify-center mb-3">
                    <svg className="w-6 h-6 text-[#ff3b30]" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                         strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                    </svg>
                </div>
                <p className="text-[13px] text-[var(--color-text)] mb-1">{t('detail.loadFailed')}</p>
                <p className="text-[12px] text-[var(--color-muted)] mb-4 max-w-sm text-center">{(error as Error)?.message || t('detail.loadFailedHint')}</p>
                <button onClick={() => navigate('/store')} className="btn btn-secondary">
                    {t('detail.back')}
                </button>
            </div>
        );
    }

    const runtime = detail.install ? commandToRuntime(detail.install.command) : 'node';
    const runtimeAvailable = runtimeInfo?.available ?? false;
    const canInstall = !!detail.install;

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部导航（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center gap-2 px-4 h-[32px] drag-region relative border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-xl text-[12px] text-[var(--color-muted)] ${isMac ? 'pl-20' : 'pr-[140px]'}`}>
                <button onClick={() => navigate(-1)} className="no-drag hover:text-[var(--color-text)] transition-colors">
                    <BackIcon className="w-4 h-4"/>
                </button>
                <span className="no-drag hover:text-[var(--color-text)] cursor-pointer" onClick={() => navigate('/store')}>Store</span>
                <span>/</span>
                <span className="no-drag hover:text-[var(--color-text)] cursor-pointer"
                      onClick={() => navigate('/store')}>{t('store.mcpPlatform') || '平台源'}</span>
                <span>/</span>
                <span className="text-[var(--color-text)]">{detail.displayName}</span>
                <WindowControls />
            </div>

            <div className="flex-1 overflow-hidden flex">
                {/* 左侧主内容 */}
                <div className="flex-1 overflow-y-auto">
                    <div className="p-6">
                        {/* 标题区域 */}
                        <div className="mb-6">
                            <div className="flex items-start gap-4 mb-3">
                                <div className="flex-shrink-0">
                                    <PlatformIcon name={detail.displayName}
                                                  iconUrl={iconError ? undefined : detail.iconUrl}/>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                        <h1 className="text-2xl font-bold text-[var(--color-text)]">{detail.displayName}</h1>
                                        {detail.isVerified && (
                                            <span
                                                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20">
                        <VerifiedIcon className="w-3 h-3"/>
                                                {t('detail.verified') || 'Verified'}
                      </span>
                                        )}
                                        {detail.isHosted && (
                                            <span
                                                className="px-1.5 py-0.5 rounded text-[12px] font-medium bg-[#34c759]/15 text-[#34c759] border border-[#34c759]/20">
                        {t('detail.hosted') || 'Hosted'}
                      </span>
                                        )}
                                    </div>
                                    <p className="text-[12px] text-[var(--color-muted)] font-mono break-all">{detail.id}</p>
                                </div>
                            </div>

                            <p className="text-[14px] text-[var(--color-muted2)] leading-relaxed mb-4">
                                {detail.description || t('detail.noDescription')}
                            </p>

                            {/* 统计信息 */}
                            <div className="flex items-center gap-4 text-[13px] text-[var(--color-muted2)] flex-wrap">
                                {typeof detail.stars === 'number' && (
                                    <span className="flex items-center gap-1">
                    <StarIcon className="w-4 h-4 text-yellow-400"/>
                                        {formatNumber(detail.stars)} {t('detail.views') || 'views'}
                  </span>
                                )}
                                {detail.author && (
                                    <span>by @{detail.author}</span>
                                )}
                            </div>

                            {/* 分类标签 */}
                            {detail.categories.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-3">
                                    {detail.categories.map(cat => (
                                        <span
                                            key={cat}
                                            className="px-2 py-0.5 rounded-full text-[12px] bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20"
                                        >
                      {t(`mcpCategory.${cat}`) || cat}
                    </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* 运行时警告 */}
                        {canInstall && !runtimeAvailable && runtime !== 'docker' && (
                            <div className="card p-4 border-[#ff9f0a]/30 bg-[#ff9f0a]/5 mb-6">
                                <div className="flex items-start gap-3">
                                    <span className="text-xl">{runtime === 'node' ? '⬢' : '🐍'}</span>
                                    <div className="flex-1">
                                        <h3 className="text-[13px] font-semibold text-[#ff9f0a] mb-1">{t('detail.runtimeRequired')}</h3>
                                        <p className="text-[12px] text-[var(--color-muted2)] mb-3">
                                            {t('detail.runtimeRequiredDesc', {
                                                runtime: runtime === 'node' ? 'Node.js' : 'Python',
                                            })}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* README */}
                        <h2 className="text-[15px] font-semibold text-[var(--color-text)] mb-4">README.md</h2>
                        <div className="card p-4 mb-6 overflow-x-auto">
                            {detail.readme ? (
                                <pre
                                    className="text-[12px] text-[var(--color-text)] font-mono leading-relaxed whitespace-pre-wrap">
                  <code>{detail.readme}</code>
                </pre>
                            ) : (
                                <p className="text-[14px] text-[#8b949e] text-center py-4">{t('detail.noReadme')}</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* 右侧边栏 */}
                <div className="w-[280px] flex-shrink-0 border-l border-[var(--color-border)] overflow-y-auto p-4">
                    {/* 安装按钮 */}
                    <div className="mb-4 space-y-2">
                        {canInstall && runtimeAvailable && (
                            <button
                                onClick={() => setShowInstallModal(true)}
                                className="w-full btn btn-primary text-[13px]"
                            >
                                {installedClients.length > 0 ? t('detail.installMore') : t('detail.install')}
                            </button>
                        )}
                        {!canInstall && (
                            <div className="w-full btn btn-secondary text-[13px] opacity-60 cursor-not-allowed">
                                {t('detail.noInstallConfig') || '无可用安装配置'}
                            </div>
                        )}
                        {installedClients.length > 0 && (
                            <button
                                onClick={handleUninstall}
                                disabled={isUninstalling}
                                className="w-full btn btn-danger text-[13px]"
                            >
                                {isUninstalling ? t('common.loading') : t('detail.uninstallAll')}
                            </button>
                        )}
                        {canInstall && (
                            <button
                                onClick={openInspector}
                                className="w-full btn btn-secondary text-[13px] flex items-center justify-center gap-1.5"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                     strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"/>
                                </svg>
                                {t('detail.inspect') || 'Inspect'}
                            </button>
                        )}
                    </div>

                    {/* 已安装的客户端 */}
                    {installedClients.length > 0 && (
                        <div className="mb-4 p-3 bg-[var(--color-surface-hover)]/30 rounded-lg">
                            <p className="text-[12px] text-[var(--color-muted)] mb-2">{t('detail.installedIn')}</p>
                            <div className="flex flex-wrap gap-1">
                                {installedClients.map(clientId => {
                                    const client = clients.find(c => c.id === clientId);
                                    return (
                                        <span key={clientId}
                                              className="flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-[12px] text-[var(--color-muted2)]">
                      <ClientIcon clientId={clientId} size={12}/>
                                            {client?.name || clientId}
                    </span>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Source 卡片 */}
                    <div className="card p-4 space-y-3 mb-4">
                        <h3 className="text-[13px] font-semibold text-[var(--color-text)]">Source</h3>
                        {detail.sourceUrl && (
                            <a
                                href="#"
                                onClick={(e) => {
                                    e.preventDefault();
                                    api.system.openExternal(detail.sourceUrl!);
                                }}
                                className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
                            >
                <span className="flex items-center gap-2">
                  <GitHubIcon className="w-4 h-4"/>
                    {detail.sourceUrl.includes('github.com') ? 'GitHub Repository' : (t('detail.viewSource') || 'View Source')}
                </span>
                                <ExternalLinkIcon className="w-3.5 h-3.5"/>
                            </a>
                        )}
                        <a
                            href="#"
                            onClick={(e) => {
                                e.preventDefault();
                                api.system.openExternal(`https://modelscope.cn/mcp?name=${encodeURIComponent(serverId)}`);
                            }}
                            className="flex items-center justify-between text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
                        >
              <span className="flex items-center gap-2">
                <ExternalLinkIcon className="w-4 h-4"/>
                  {t('store.mcpPlatform') || '平台源'}（ModelScope）
              </span>
                            <ExternalLinkIcon className="w-3.5 h-3.5"/>
                        </a>
                    </div>

                    {/* Details 卡片 */}
                    <div className="card p-4">
                        <h3 className="text-[13px] font-semibold text-[var(--color-text)] mb-3">Details</h3>
                        <div className="space-y-2 text-[12px]">
                            <div className="flex justify-between">
                                <span className="text-[var(--color-muted)]">Platform</span>
                                <span className="text-[var(--color-text)] capitalize">{detail.source}</span>
                            </div>
                            {detail.install && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">{t('detail.runtime') || 'Runtime'}</span>
                                    <div className="flex items-center gap-1">
                                        <span
                                            className={`w-2 h-2 rounded-full ${runtimeAvailable || runtime === 'docker' ? 'bg-[#34c759]' : 'bg-[#ff9f0a]'}`}/>
                                        <span className="text-[var(--color-text)] capitalize">{detail.install.command}</span>
                                    </div>
                                </div>
                            )}
                            {detail.publisher && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">{t('detail.publisher') || 'Publisher'}</span>
                                    <span className="text-[var(--color-text)]">{detail.publisher}</span>
                                </div>
                            )}
                            {detail.tags.length > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-muted)]">Tags</span>
                                    <span
                                        className="text-[var(--color-text)] text-right max-w-[160px] truncate">{detail.tags.join(', ')}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* 安装模态框（客户端选择 + 环境变量） */}
            <Modal
                isOpen={showInstallModal}
                onClose={() => {
                    setShowInstallModal(false);
                    setInstallError(null);
                }}
                title={t('detail.configTitle')}
                size="lg"
            >
                <div className="space-y-4">
                    {installError && (
                        <div
                            className="p-3 rounded-md bg-[#ff3b30]/10 border border-[#ff3b30]/20 text-[#ff3b30] text-[12px]">
                            {installError}
                        </div>
                    )}

                    <div className="flex items-center gap-3 p-3 bg-[var(--color-surface-hover)]/30 rounded-lg">
                        <PlatformIcon name={detail.displayName} iconUrl={iconError ? undefined : detail.iconUrl}/>
                        <div>
                            <h3 className="text-[14px] font-medium text-[var(--color-text)]">{detail.displayName}</h3>
                            <p className="text-[12px] text-[var(--color-muted)] font-mono break-all">{detail.id}</p>
                        </div>
                    </div>

                    {/* 环境变量表单 */}
                    {hasEnvForm && (
                        <div>
                            <label
                                className="block text-[12px] font-medium text-[var(--color-text)] mb-2">{t('detail.envVars') || 'Environment Variables'}</label>
                            <div className="space-y-2">
                                {Object.entries(envProps).map(([key, schema]) => {
                                    const isRequired = requiredEnv.includes(key);
                                    return (
                                        <div key={key}>
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-[12px] font-mono text-[var(--color-text)]">{key}</span>
                                                {isRequired && <span className="text-[#ff3b30] text-[12px]">*</span>}
                                                {schema?.description && (
                                                    <span
                                                        className="text-[12px] text-[var(--color-muted)] truncate">{(schema.description as string)}</span>
                                                )}
                                            </div>
                                            <input
                                                type="text"
                                                value={envInputs[key] ?? ''}
                                                onChange={(e) => setEnvInputs(prev => ({
                                                    ...prev,
                                                    [key]: e.target.value
                                                }))}
                                                placeholder={isRequired ? (t('detail.required') || 'required') : ''}
                                                className="w-full px-2.5 py-1.5 rounded-md bg-[var(--color-surface-hover)] text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-muted)] border-none focus:ring-1 focus:ring-[#0a84ff]"
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* 客户端选择 */}
                    <div>
                        <label
                            className="block text-[12px] font-medium text-[var(--color-text)] mb-2">{t('detail.selectClients')}</label>
                        <div className="grid grid-cols-2 gap-2">
                            {clients.filter(c => c.installed).map(client => {
                                const isSelected = selectedClients.includes(client.id);
                                const isAlreadyInstalled = installedClients.includes(client.id);
                                return (
                                    <button
                                        key={client.id}
                                        onClick={() => !isAlreadyInstalled && toggleClient(client.id)}
                                        disabled={isAlreadyInstalled}
                                        className={`
                      flex items-center gap-2 p-3 rounded-md border text-left transition-colors
                      ${isAlreadyInstalled
                                            ? 'bg-[#34c759]/10 border-[#34c759]/30 text-[#34c759]'
                                            : isSelected
                                                ? 'bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30 text-[var(--color-accent)]'
                                                : 'bg-[var(--color-surface-hover)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[#636366]'
                                        }
                    `}
                                    >
                                        <ClientIcon clientId={client.id} size={20}/>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[12px] font-medium">{client.name}</div>
                                            <div className="text-[12px] opacity-60">
                                                {isAlreadyInstalled ? t('detail.alreadyInstalled') : t('detail.available')}
                                            </div>
                                        </div>
                                        {(isSelected || isAlreadyInstalled) && <CheckIcon className="w-4 h-4"/>}
                                    </button>
                                );
                            })}
                        </div>
                        {clients.filter(c => c.installed).length === 0 && (
                            <p className="text-center text-[var(--color-muted)] text-[13px] py-4">
                                {t('detail.noClientsInstalled') || 'No installed clients support MCP'}
                            </p>
                        )}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button onClick={() => {
                            setShowInstallModal(false);
                            setInstallError(null);
                        }} className="btn btn-secondary">{t('common.cancel')}</button>
                        <button
                            onClick={handleInstall}
                            disabled={selectedClients.filter(c => !installedClients.includes(c)).length === 0 || isInstalling}
                            className="btn btn-primary disabled:opacity-50"
                        >
                            {isInstalling ? t('common.loading') : t('detail.install')}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
