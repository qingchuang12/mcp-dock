/**
 * 商店页面 - Surge 风格
 * 支持 MCP Servers 和 Skills 双资源类型
 * 网格布局：每行2个卡片，每页20个
 *
 * 数据查询已收口到 hooks/useStoreData（内置源前端切片 + 平台源服务端分页），
 * 本文件只负责渲染、交互与数据源选择。
 */

import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useStore} from '../store/useStore';
import {useElectronAPI} from '../lib/electron';
import type {SkillListItem} from '../api/registry';
import {useIsMac} from '../lib/useIsMac';
import ServerCard from '../components/ServerCard';
import SkillCard from '../components/SkillCard';
import Pagination from '../components/Pagination';
import WindowControls from '../components/WindowControls';
import {toast} from '../components/Toast';
import {useStoreSourceSelection} from '../hooks/useStoreSourceSelection';
import {useStoreData} from '../hooks/useStoreData';

/**
 * 轻量防抖 hook：value 变化后延迟 delay 毫秒才同步到返回值。
 * 用于把搜索框的即时回显（searchQuery）与服务端查询链路解耦，
 * 避免每次按键都发起并发、不可取消的服务端请求（会导致分页总页数跳动）。
 */
function useDebouncedValue<T>(value: T, delay = 300): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}

export default function Store() {
    const {t} = useTranslation();
    const api = useElectronAPI();

    const {
        resourceType,
        setResourceType,
        searchQuery,
        setSearchQuery,
        currentPage,
        setCurrentPage,
        pageSize,
        setPageSize,
        installedServerIds,
        setInstalledServerIds,
        installedSkillIds,
        setInstalledSkillIds,
    } = useStore();

    const [isForceRefreshing, setIsForceRefreshing] = useState(false);
    const isMac = useIsMac();

    // 搜索防抖：搜索框即时回显 searchQuery，但服务端查询链路（queryKey + 实际请求）
    // 使用 debouncedSearch，避免每次按键触发并发请求导致分页总页数跳动。
    const debouncedSearch = useDebouncedValue(searchQuery, 300);

    // 数据源选择（默认源回退 / 有效性校正）收口到 hook
    const source = useStoreSourceSelection();
    // 统一数据查询：内置源前端切片 + 平台源服务端分页（按页查询、首页只查首页）
    const data = useStoreData({
        resourceType,
        mcpConnId: source.mcpConnId,
        dataSource: source.dataSource,
        selectedConn: source.selectedConn,
        isDirectSkillSource: source.isDirectSkillSource,
        selectedSkillSourceId: source.selectedSkillSourceId,
        page: currentPage,
        pageSize,
        debouncedSearch,
    });

    const result = data;
    const isLoading = data.isLoading;
    const isFetching = data.isFetching;
    const error = data.error;
    const friendlyMessage = data.message;

    // 切换资源类型时重置分页
    useEffect(() => {
        setCurrentPage(1);
    }, [resourceType, setCurrentPage]);

    // 获取已安装服务器
    useEffect(() => {
        api.config.getAllServers().then(({servers}) => {
            setInstalledServerIds(Object.keys(servers));
        });
    }, [api, setInstalledServerIds]);

    // 获取已安装 Skills
    useEffect(() => {
        api.skills.getAllInstalled().then(({skills}) => {
            setInstalledSkillIds(Object.keys(skills));
        });
    }, [api, setInstalledSkillIds]);

    // 强制刷新数据（重新拉取当前源，refetch 会忽略缓存直接请求在线数据）
    const handleForceRefresh = useCallback(async () => {
        setIsForceRefreshing(true);
        const startTime = Date.now();
        try {
            await data.refetch();
            const elapsed = Date.now() - startTime;
            if (elapsed < 1500) await new Promise(r => setTimeout(r, 1500 - elapsed));
            toast.success(t('store.refreshSuccess') || 'Data refreshed');
        } catch {
            toast.error(t('store.refreshFailed') || 'Failed to refresh data');
        } finally {
            setIsForceRefreshing(false);
        }
    }, [data, t]);

    const handleRetry = useCallback(async () => {
        try {
            await data.refetch();
            toast.success(t('store.retrySuccess') || 'Data loaded successfully');
        } catch {
            toast.error(t('store.retryFailed') || 'Failed to load data');
        }
    }, [data, t]);

    // 下拉当前值相关
    const selectedMcpConn = source.mcpSources.find(c => c.id === source.mcpConnId) || null;
    const attributionText = resourceType === 'mcp'
        ? selectedMcpConn
            ? `MCP servers from ${selectedMcpConn.name || selectedMcpConn.baseUrl}`
            : (source.dataSource === 'official'
                ? t('store.attributionOfficial')
                : t('store.attributionSmithery'))
        : source.selectedConn
            ? `Skills from ${source.selectedConn.name || source.selectedConn.baseUrl}`
            : (t('store.attributionSkills') || 'Data from GitHub repositories');

    // 顶部「全部」总数：使用当前查询的实时结果数（商店数据不缓存）
    const displayTotal = result.totalItems;

    return (
        <div className="flex flex-col h-full bg-[var(--color-bg)]">
            {/* 头部工具栏（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center justify-between gap-3 px-4 h-[38px] drag-region border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-xl sticky top-0 z-10 ${isMac ? 'pl-20' : 'pr-[140px]'}`}
            >
                {/* min-w-0 让左侧在空间不足时收缩，避免把右侧搜索框挤到重叠 */}
                <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden no-drag">
                    <h1 className="text-[14px] font-semibold text-[var(--color-text)] whitespace-nowrap tracking-tight">
                        {t('store.title')}
                    </h1>

                    {/* 资源类型切换 */}
                    <div className="flex items-center bg-[var(--color-surface-hover)] rounded-lg p-0.5 shrink-0">
                        <button
                            onClick={() => setResourceType('mcp')}
                            className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                resourceType === 'mcp'
                                    ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]'
                                    : 'text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                            }`}
                        >
                            MCP Servers
                        </button>
                        <button
                            onClick={() => setResourceType('skills')}
                            className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                resourceType === 'skills'
                                    ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]'
                                    : 'text-[var(--color-muted2)] hover:text-[var(--color-text)]'
                            }`}
                        >
                            Skills
                        </button>
                    </div>

                    <span className="text-[12px] text-[var(--color-muted2)] whitespace-nowrap shrink-0 tabular-nums">
            {displayTotal} {resourceType === 'mcp' ? (t('store.servers') || 'servers') : (t('store.skills') || 'skills')}
          </span>

                    {/* 数据源切换 - 仅 MCP 显示：来自「MCP 源管理」的已启用源 */}
                    {resourceType === 'mcp' && (
                        <select
                            value={source.selectedMcpSourceId}
                            onChange={e => {
                                const v = e.target.value;
                                if (v === '__add__') {
                                    window.location.hash = '#/settings';
                                    return;
                                }
                                const src = source.mcpSources.find(c => c.id === v);
                                if (!src) return;
                                // 内置源走 registry 内置抓取；其余走平台源直连
                                if (src.platformType === 'official' || src.platformType === 'smithery') {
                                    source.setDataSource(src.platformType);
                                    source.setMcpConnId(null);
                                } else {
                                    source.setMcpConnId(src.id);
                                }
                                setCurrentPage(1);
                            }}
                            className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-[var(--color-accent)]/15 text-[var(--color-accent)] border border-[var(--color-accent)]/40 focus:outline-none whitespace-nowrap shrink-0"
                            title="选择 MCP 来源"
                        >
                            {source.mcpSources.map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                            {source.mcpSources.length === 0 && (
                                <option value="__add__">＋ 去设置添加 MCP 源…</option>
                            )}
                        </select>
                    )}

                    {/* Skills 来源切换 - 仅 Skills 显示：GitHub Registry + 已配置的 Skill 源管理 */}
                    {resourceType === 'skills' && (
                        <select
                            value={source.selectedSkillSourceId || ''}
                            onChange={e => {
                                const v = e.target.value;
                                if (v === '__add__') {
                                    window.location.hash = '#/settings';
                                    return;
                                }
                                source.setSelectedSkillSourceId(v || null);
                                setCurrentPage(1);
                            }}
                            className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-[var(--color-accent)]/15 text-[var(--color-accent)] border border-[var(--color-accent)]/40 focus:outline-none whitespace-nowrap shrink-0"
                            title="选择 Skills 来源"
                        >
                            {source.connections.map(c => (
                                <option key={c.id} value={c.id}>{c.name}{c.isDefault ? '（默认）' : ''}</option>
                            ))}
                            {source.connections.length === 0 && (
                                <option value="__add__">＋ 去设置添加 Skill 源管理…</option>
                            )}
                        </select>
                    )}

                    {/* 强制刷新按钮 */}
                    <button
                        onClick={handleForceRefresh}
                        disabled={isForceRefreshing || isLoading || isFetching}
                        className="p-1.5 rounded-md text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50 shrink-0"
                        title={t('store.forceRefresh') || 'Force refresh data'}
                    >
                        <svg
                            className={`w-3.5 h-3.5 ${isForceRefreshing ? 'animate-spin' : ''}`}
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

                {/* 搜索框：shrink-0 防止左侧内容变多时被压缩、与左侧元素视觉重叠 */}
                <div className="relative w-[240px] shrink-0 no-drag">
                    <svg
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-muted)]"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                        />
                    </svg>
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={resourceType === 'mcp' ? t('store.search') : (t('store.searchSkills') || 'Search skills...')}
                        className={`w-full pl-9 ${searchQuery ? 'pr-8' : 'pr-3'} py-1.5 rounded-lg bg-[var(--color-surface-hover)] text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-muted)] border-none focus:ring-1 focus:ring-[#0a84ff] text-ellipsis`}
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] cursor-pointer transition-colors"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                 strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </button>
                    )}
                </div>
                <WindowControls />
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto">
                {isLoading || isFetching ? (
                    <div className="flex flex-col items-center justify-center h-full">
                        <div
                            className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[#0a84ff] rounded-full animate-spin mb-3"/>
                        <p className="text-[13px] text-[var(--color-muted2)]">{t('store.loading')}</p>
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center h-full">
                        <div className="w-12 h-12 rounded-full bg-[#ff3b30]/10 flex items-center justify-center mb-3">
                            <svg className="w-6 h-6 text-[#ff3b30]" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round"
                                      d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                            </svg>
                        </div>
                        <p className="text-[13px] text-[var(--color-muted2)] mb-3">{t('store.error')}</p>
                        <button
                            onClick={handleRetry}
                            className="btn btn-secondary text-[13px]"
                        >
                            {t('store.retry')}
                        </button>
                    </div>
                ) : result.items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full px-8">
                        <div className="w-14 h-14 rounded-full bg-[var(--color-accent)]/10 flex items-center justify-center mb-4">
                            <svg className="w-7 h-7 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round"
                                      d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75"/>
                            </svg>
                        </div>
                        {friendlyMessage ? (
                            <>
                                <p className="text-[15px] text-[var(--color-text)] font-medium mb-2">
                                    {friendlyMessage === '__QUOTA_LIMIT_EXCEED__'
                                        ? (t('store.quotaLimitTitle', '请尝试使用关键字搜索') as string)
                                        : (t('store.queryHintTitle', '无法完成查询') as string)}
                                </p>
                                <p className="text-[13px] text-[var(--color-muted2)] text-center leading-relaxed mb-4">
                                    {friendlyMessage === '__QUOTA_LIMIT_EXCEED__'
                                        ? (t('store.quotaLimitHint', '当前查询超出了 ModelScope 接口的单次配额限制（页码 × 每页条数上限为 100）。请在上方搜索框输入关键字以缩小范围后再试。') as string)
                                        : friendlyMessage}
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-[15px] text-[var(--color-text)] font-medium mb-2">
                                    {resourceType === 'skills' && data.isUnsupported
                                        ? '该 Skill 源未提供公开列表接口'
                                        : resourceType === 'skills' && source.connections.length === 0
                                            ? '添加 Skill 源管理以浏览平台 Skills'
                                            : resourceType === 'mcp' && source.mcpConnId
                                                ? '该平台暂无匹配的 MCP Server'
                                                : '暂无数据'}
                                </p>
                        <p className="text-[13px] text-[var(--color-muted2)] text-center leading-relaxed mb-4">
                            {resourceType === 'skills' && data.isUnsupported
                                ? `「${source.selectedConn?.name || '该平台'}」是 SPA 站点，未开放公开的 skills 列表接口（所有候选端点均返回页面外壳），无法在此直接浏览。如需安装其技能，请用「粘贴 GitHub 仓库链接」方式导入。`
                                : resourceType === 'skills' && source.connections.length === 0
                                    ? '当前 Skills 来自 GitHub Registry。你可以在「设置 → Skill 源管理」中添加 ModelScope / SafeSkill / SkillHub / SkillsMP 等平台直连（或任意自定义 skill 站点），切换后即可浏览各平台的技能。'
                                    : resourceType === 'mcp' && source.mcpConnId
                                        ? `来自「${selectedMcpConn?.name || '该平台'}」的搜索没有结果，试试切换分类或更换来源（确保连接已通过验证）。`
                                        : (t('store.communityEditionDesc', 'No items found. Try switching the data source or adjusting your search.') as string)}
                        </p>
                            </>
                        )}
                        {resourceType === 'skills' && source.connections.length === 0 ? (
                            <button
                                onClick={() => {
                                    window.location.hash = '#/settings';
                                }}
                                className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
                            >
                                去设置添加 Skill 源管理
                            </button>
                        ) : resourceType === 'mcp' && source.mcpConnId ? (
                            <button
                                onClick={() => {
                                    window.location.hash = '#/settings';
                                }}
                                className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
                            >
                                去设置管理 Skill 源管理
                            </button>
                        ) : (
                            <button
                                onClick={() => window.location.hash = '#/library'}
                                className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
                            >
                                {t('store.goToLibrary', 'Go to Library')}
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="p-4">
                        {/* 配额/查询限制友好提示：即使本页有数据（如已翻到可检索末页）也顶部常驻展示，
                            引导用户用关键字缩小范围，而非只在空态才出现 */}
                        {friendlyMessage && (
                            <div
                                className="mb-3 flex items-start gap-2 rounded-lg border border-[#ff9f0a]/30 bg-[#ff9f0a]/10 px-3 py-2">
                                <svg className="w-4 h-4 text-[#ff9f0a] shrink-0 mt-0.5" fill="none"
                                     viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round"
                                          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-.75 9.75h.008v.008h-.008v-.008z"/>
                                </svg>
                                <div className="text-[13px] leading-relaxed">
                                    <p className="font-medium text-[var(--color-text)]">
                                        {friendlyMessage === '__QUOTA_LIMIT_EXCEED__'
                                            ? (t('store.quotaLimitTitle', '请尝试使用关键字搜索') as string)
                                            : (t('store.queryHintTitle', '无法完成查询') as string)}
                                    </p>
                                    <p className="text-[var(--color-muted2)] mt-0.5">
                                        {friendlyMessage === '__QUOTA_LIMIT_EXCEED__'
                                            ? (t('store.quotaLimitHint', '当前查询超出了 ModelScope 接口的单次配额限制（页码 × 每页条数上限为 100）。请在上方搜索框输入关键字以缩小范围后再试。') as string)
                                            : friendlyMessage}
                                    </p>
                                </div>
                            </div>
                        )}
                        {/* 网格布局：每行2个卡片 */}
                        {/* 使用包含 currentPage 的 key 确保翻页时完全重新渲染列表 */}
                        <div key={`grid-${resourceType}-${currentPage}`} className="grid grid-cols-2 gap-3">
                            {resourceType === 'mcp' ? (
                                // MCP Servers 网格
                                (result.items as any[]).map((server, index) => (
                                    <ServerCard
                                        key={`${currentPage}-${index}-${server.id}`}
                                        server={server}
                                        dataSource={source.dataSource}
                                        isInstalled={installedServerIds.has(server.id)}
                                        platformConnId={source.mcpConnId}
                                    />
                                ))
                            ) : (
                                // Skills 网格
                                (result.items as SkillListItem[]).map((skill, index) => (
                                    <SkillCard
                                        key={`${currentPage}-${index}-${skill.id}`}
                                        skill={skill}
                                        isInstalled={installedSkillIds.has(skill.name)}
                                        connectionId={source.isDirectSkillSource ? source.selectedSkillSourceId ?? undefined : undefined}
                                        sourceUrl={source.isDirectSkillSource ? (skill.repository?.url || skill.authorUrl || undefined) : undefined}
                                    />
                                ))
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* 底部分页和信息 */}
            {!isLoading && !error && result.items.length > 0 && (
                <div
                    className="flex items-center justify-between gap-3 px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <span className="text-[12px] text-[var(--color-muted)] truncate">
            {attributionText}
          </span>
                    <div className="flex items-center gap-3 shrink-0">
                        {/* 每页条数控制 */}
                        <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted2)] whitespace-nowrap">
                            {t('store.pageSize') || '每页'}
                            <select
                                value={pageSize}
                                onChange={(e) => setPageSize(Number(e.target.value))}
                                className="px-1.5 py-0.5 rounded-md text-[12px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                            >
                                {[10, 20, 50, 100].map(n => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </select>
                            {t('store.items') || '条'}
                        </label>
                        <Pagination
                            currentPage={currentPage}
                            totalPages={result.totalPages}
                            totalItems={result.totalItems}
                            startIndex={result.startIndex}
                            endIndex={result.endIndex}
                            onPageChange={setCurrentPage}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
