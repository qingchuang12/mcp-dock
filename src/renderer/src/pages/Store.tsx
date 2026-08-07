/**
 * 商店页面 - Surge 风格
 * 支持 MCP Servers 和 Skills 双资源类型
 * 网格布局：每行2个卡片，每页20个
 */

import {useCallback, useEffect, useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {
    fetchServerList,
    fetchSkillsList,
    forceRefreshServerList,
    forceRefreshSkillsList,
    inferSkillCategoryId,
    type ServerListItem,
    type SkillListItem
} from '../api/registry';
import {useStore} from '../store/useStore';
import {paginateServers, searchServers} from '../lib/search';
import type {ApiConnection, PlatformServerListItem, PlatformSkillListItem} from '../lib/electron';
import {useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import ServerCard from '../components/ServerCard';
import SkillCard from '../components/SkillCard';
import Pagination from '../components/Pagination';
import {BUILTIN_SKILL_SOURCE_IDS} from '../../../shared/platform-constants';
import {getTotalCache, setTotalCache} from '../lib/storeStats';
import {toast} from '../components/Toast';

// 直连源（skillsMp / skillhub 等）服务端分页单页上限约 50，拉全量时按此尺寸翻页
const DIRECT_FETCH_PAGE_SIZE = 50;
// 翻页防御上限（每页最多 50 条 → 约 1250 条上限），防止服务端契约异常时无限循环
const DIRECT_FETCH_MAX_PAGES = 25;

// 将 Skill 源管理返回的 PlatformSkillListItem 映射为统一的 SkillListItem，
// 以便所有 Skills 来源（GitHub Registry 与各 Skill 源管理）共用同一套卡片网格样式
function mapPlatformSkill(item: PlatformSkillListItem): SkillListItem {
    // 优先用服务端返回的真实分类（如 SkillsMP 的 architecture-patterns），否则按名字推断
    const categoryId = item.category || inferSkillCategoryId(item.name);
    return {
        id: item.id,
        name: item.name,
        description: item.description || '',
        descriptions: item.descriptions,
        author: item.source,
        authorUrl: item.sourceUrl,
        downloadUrl: item.downloadUrl,
        category: categoryId,
        categoryId,
        stars: item.stars ?? 0,
        forks: 0,
        updatedAt: item.updatedAt || new Date().toISOString(),
        // 非 GitHub 源优先带 downloadUrl 作为详情/安装直链；GitHub 源 downloadUrl 为空，回退到 sourceUrl（github 链接）
        repository: {url: item.downloadUrl || item.sourceUrl, branch: '', skillPath: ''},
    };
}

// 将平台 MCP server 列表项映射为统一的 ServerListItem，复用 ServerCard 渲染
function mapPlatformServer(item: PlatformServerListItem): ServerListItem {
    return {
        id: item.id,
        displayName: item.displayName,
        description: item.description,
        iconUrl: item.iconUrl ?? null,
        source: 'platform',
        author: item.source,
        stars: item.stars ?? 0,
        categories: item.categories,
        repository: item.sourceUrl ? {url: item.sourceUrl, branch: '', owner: '', repo: ''} : undefined,
    } as ServerListItem;
}

export default function Store() {
    const {t} = useTranslation();
    const api = useElectronAPI();

    const {
        resourceType,
        setResourceType,
        dataSource,
        setDataSource,
        searchQuery,
        setSearchQuery,
        currentPage,
        setCurrentPage,
        pageSize,
        setPageSize,
        serverLists,
        setServerList,
        skillsList,
        setSkillsList,
        installedServerIds,
        setInstalledServerIds,
        installedSkillIds,
        setInstalledSkillIds,
        mcpConnId,
        setMcpConnId,
        selectedSkillSourceId,
        setSelectedSkillSourceId,
    } = useStore();

    // 强制刷新状态
    const [isForceRefreshing, setIsForceRefreshing] = useState(false);

    // 平台判断（mac 需为左上角交通灯预留拖拽空间）
    const isMac = useIsMac();

    // Skills 来源：用户已配置的 Skill 源管理（不再使用独立的 Skill 直连来源）
    const [connections, setConnections] = useState<ApiConnection[]>([]);
    // MCP 来源：MCP 源管理里配置的源（仅取已启用项）
    const [mcpSources, setMcpSources] = useState<ApiConnection[]>([]);
    // 直连源的服务端真实总数（SkillsMP 等由 pageInfo.total 返回），用于分类栏显示真实数量
    const [directTotal, setDirectTotal] = useState<number | null>(null);
    // 选中的 Skill 源是否「未提供公开 skills 列表接口」（如 SkillHub/SafeSkill 等 SPA 站点），
    // 用于空态给出友好提示，区别于真实加载故障
    const [directUnsupported, setDirectUnsupported] = useState(false);
    // 直连源分页模式：'server'（如 SkillHub 真分页，翻页需重拉对应页）| 'client'（如 ClawHub 本地切片）
    const [directPagingMode, setDirectPagingMode] = useState<'server' | 'client' | null>(null);
    // 直连源服务端真实总页数（SkillHub 等真分页源由 pageInfo.totalPages 返回）
    const [directTotalPages, setDirectTotalPages] = useState<number | null>(null);
    // 直连源异步累积列表：先以第 1 页立即显示首页，后续页在后台补全（避免等待全量才渲染）
    const [skillsDirectItems, setSkillsDirectItems] = useState<SkillListItem[] | null>(null);

    // MCP 平台源（连接）选中的连接 ID；为 null 时走内置源（official/smithery）
    // 注意：mcpConnId 来自 useStore，跨详情页返回可保留选择
    // MCP 平台源服务端真实总数 / 总页数（用于翻页控件）
    const [directMcpTotal, setDirectMcpTotal] = useState<number | null>(null);
    const [directMcpTotalPages, setDirectMcpTotalPages] = useState<number | null>(null);

    // 获取 MCP 服务器列表（内置源 official/smithery）
    const {data: serverData, isLoading: isLoadingServers, error: serverError, refetch: refetchServers} = useQuery({
        queryKey: ['serverList', dataSource],
        queryFn: async () => {
            const list = await fetchServerList(dataSource);
            // 「全部」总数（不随分类筛选变化）写入 1 天缓存
            setTotalCache('mcp', dataSource, list.length);
            return list;
        },
        staleTime: 10 * 60 * 1000,
        enabled: resourceType === 'mcp' && !mcpConnId,
    });

    // 获取 MCP 平台源列表（选中连接时，服务端分页，复用设置下的令牌）
    const {
        data: mcpPlatformData,
        isLoading: isLoadingPlatform,
        error: platformError,
        refetch: refetchPlatform
    } = useQuery({
        queryKey: ['mcpPlatformList', mcpConnId, searchQuery, currentPage],
        queryFn: async () => {
            if (!mcpConnId) return [] as ServerListItem[];
            // 服务端的分类筛选已移除，统一按「全部」拉取（前端不再提供分类筛选 UI）
            const res = await api.apiConnections.searchPlatformServersPaged(
                mcpConnId, searchQuery, currentPage, DIRECT_FETCH_PAGE_SIZE, ''
            );
            setDirectMcpTotal(typeof res.pageInfo.total === 'number' ? res.pageInfo.total : null);
            setDirectMcpTotalPages(typeof res.pageInfo.totalPages === 'number' ? res.pageInfo.totalPages : null);
            // 「全部」总数写入 1 天缓存
            if (typeof res.pageInfo.total === 'number') {
                setTotalCache('mcp', mcpConnId, res.pageInfo.total);
            }
            return res.items.map(mapPlatformServer);
        },
        staleTime: 10 * 60 * 1000,
        enabled: resourceType === 'mcp' && !!mcpConnId,
    });

    // 当前选中的 Skill 源（直连 or GitHub Registry）
    const selectedConn = connections.find(c => c.id === selectedSkillSourceId) || null;
    const isDirectSkillSource = !!selectedConn && selectedConn.platformType !== 'github';

    // 获取 Skills 列表 —— GitHub Registry（内置）：一次性返回全量
    const {data: skillsData, isLoading: isLoadingSkills, error: skillsError, refetch: refetchSkills} = useQuery({
        queryKey: ['skillsList', selectedSkillSourceId || 'github', searchQuery],
        queryFn: async () => {
            // GitHub Registry 内置来源走 fetchSkillsList（GitHub 官方仓库），不走平台搜索 API
            setDirectTotal(null);
            setDirectUnsupported(false);
            setSkillsDirectItems(null);
            const list = await fetchSkillsList();
            // 「全部」总数写入 1 天缓存
            setTotalCache('skills', selectedSkillSourceId || 'github', list.length);
            return list;
        },
        staleTime: 10 * 60 * 1000,
        enabled: resourceType === 'skills' && !isDirectSkillSource,
    });

    // 获取 Skills 列表 —— 直连源：服务端真分页源（如 SkillHub）按 currentPage 拉对应页；
    // 本地分页源（如 ClawHub）只拉首页，由后台补全累积后在本地切片分页。
    const {
        data: skillsDirectFirst,
        isLoading: isLoadingSkillsDirect,
        error: skillsDirectError,
        refetch: refetchSkillsDirect
    } = useQuery({
        // server 模式需随 currentPage 重拉对应页；client 模式固定在第 1 页（本地切片）
        queryKey: ['skillsDirectFirst', selectedConn?.id, searchQuery, directPagingMode === 'server' ? currentPage : 1],
        queryFn: async () => {
            if (!selectedConn) return [] as SkillListItem[];
            // 分类筛选 UI 已移除，统一按「全部」拉取；server 模式用当前页，client 模式固定第 1 页
            const page = directPagingMode === 'server' ? currentPage : 1;
            const res = await api.apiConnections.searchPlatformPaged(
                selectedConn.id, searchQuery, page, DIRECT_FETCH_PAGE_SIZE, ''
            );
            // 优先使用后端透传的上游真实总量（如 ClawHub 的 totalItems，可能大于本地已拉取条数），
            // 回退到本地分页 total。
            const realTotal = typeof res.serverTotal === 'number' ? res.serverTotal : res.pageInfo.total;
            setDirectTotal(typeof realTotal === 'number' ? realTotal : null);
            // 「全部」总数写入 1 天缓存
            if (typeof realTotal === 'number') {
                setTotalCache('skills', selectedConn.id, realTotal);
            }
            setDirectPagingMode(res.pagingMode === 'server' ? 'server' : 'client');
            setDirectTotalPages(typeof res.pageInfo.totalPages === 'number' ? res.pageInfo.totalPages : null);
            setDirectUnsupported(!!res.unsupported);
            setSkillsDirectItems(res.items.map(mapPlatformSkill));
            return res.items.map(mapPlatformSkill);
        },
        staleTime: 10 * 60 * 1000,
        enabled: resourceType === 'skills' && isDirectSkillSource,
    });

    // 直连源：第 1 页显示后，后台继续拉取剩余页并异步补全（首页不等待全量）
    useEffect(() => {
        if (resourceType !== 'skills' || !isDirectSkillSource || !selectedConn) {
            return;
        }
        let cancelled = false;
        const categoryParam = '';
        const first = skillsDirectFirst ? [...skillsDirectFirst] : [];
        setSkillsDirectItems(first);
        (async () => {
            let all = [...first];
            let page = 2;
            try {
                while (page <= DIRECT_FETCH_MAX_PAGES) {
                    const res = await api.apiConnections.searchPlatformPaged(
                        selectedConn.id, searchQuery, page, DIRECT_FETCH_PAGE_SIZE, categoryParam
                    );
                    if (cancelled) return;
                    all = [...all, ...res.items.map(mapPlatformSkill)];
                    setSkillsDirectItems([...all]);
                    if (!res.pageInfo.hasMore) break;
                    page++;
                }
            } catch {
                // 后台补全失败不影响已显示的首页
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [resourceType, isDirectSkillSource, selectedConn, selectedSkillSourceId, searchQuery, skillsDirectFirst]);

    // 更新 MCP 缓存
    useEffect(() => {
        if (serverData) {
            setServerList(dataSource, serverData);
        }
    }, [serverData, dataSource, setServerList]);

    // 更新 Skills 缓存
    useEffect(() => {
        if (skillsData) {
            setSkillsList(skillsData);
        }
    }, [skillsData, setSkillsList]);

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

    useEffect(() => {
        api.apiConnections
            .list('skill')
            .then(list => setConnections(list.filter(c => c.enabled ?? true)))
            .catch(() => setConnections([]));
    }, [api]);

    // 默认来源选择：用户已显式选择时保持不变；未选择时优先用「设为默认」的源（kind=skill），
    // 回退内置 GitHub Registry，再回退到列表第一条。
    // 注意：必须等 connections 列表加载完成（length>0）后再判断，否则来源列表刷新/详情页返回瞬间
    // connections 为空会把用户已选的源误判为失效，从而被覆盖成默认源，导致"返回后数据源变化"。
    useEffect(() => {
        if (connections.length === 0) return;
        const stillValid = selectedSkillSourceId && connections.some(c => c.id === selectedSkillSourceId);
        if (!stillValid) {
            const def = connections.find(c => c.isDefault && (c.kind ?? 'skill') === 'skill');
            const gh = connections.find(c => c.id === BUILTIN_SKILL_SOURCE_IDS.github);
            const fallback = (def || gh || connections[0])?.id ?? null;
            setSelectedSkillSourceId(fallback);
        }
    }, [connections, selectedSkillSourceId]);

    // 加载 MCP 源管理列表（只保留启用项）
    useEffect(() => {
        api.apiConnections
            .list('mcp')
            .then(list => setMcpSources(list.filter(c => c.enabled ?? true)))
            .catch(() => setMcpSources([]));
    }, [api]);

    // MCP 默认源同步：等 mcpSources 加载完成后，若当前 mcpConnId/dataSource 未指向有效源，
    // 按「默认源 → dataSource 对应内置源 → 首条」回退并设置，保证下拉显示与实际数据一致，
    // 避免持久化选择指向已删除源时出现「下拉与实际不符」的异常。
    useEffect(() => {
        if (mcpSources.length === 0) return;
        const isValid = mcpConnId
            ? mcpSources.some(c => c.id === mcpConnId)
            : mcpSources.some(c => c.platformType === dataSource);
        if (isValid) return;
        const def = mcpSources.find(c => c.isDefault && (c.kind ?? 'mcp') === 'mcp');
        const byDataSource = mcpSources.find(c => c.platformType === dataSource);
        const fallback = def || byDataSource || mcpSources[0];
        if (!fallback) return;
        if (fallback.platformType === 'official' || fallback.platformType === 'smithery') {
            setDataSource(fallback.platformType);
            setMcpConnId(null);
        } else {
            setMcpConnId(fallback.id);
        }
    }, [mcpSources, mcpConnId, dataSource, setDataSource, setMcpConnId]);

    // 切换资源类型时重置分类和分页
    useEffect(() => {
        setCurrentPage(1);
    }, [resourceType, setCurrentPage]);

    // 搜索和分页 - MCP
    const mcpResult = useMemo(() => {
        if (resourceType !== 'mcp') return {items: [], totalPages: 0, totalItems: 0, startIndex: 0, endIndex: 0};
        if (mcpConnId) {
            // 平台源：服务端已分页，单页直接渲染，用服务端总数/总页数驱动翻页
            const items = (mcpPlatformData || []) as ServerListItem[];
            const totalItems = directMcpTotal ?? items.length;
            const totalPages = directMcpTotalPages ?? (items.length > 0 ? 1 : 0);
            const startIndex = (currentPage - 1) * pageSize + 1;
            const endIndex = Math.min(startIndex - 1 + items.length, totalItems);
            return {items, totalPages, totalItems, startIndex, endIndex};
        }
        // 内置源：客户端搜索 + 切片分页
        const list = serverData || serverLists[dataSource] || [];
        const filtered = searchServers(list, searchQuery);
        return paginateServers(filtered, currentPage, pageSize);
    }, [resourceType, mcpConnId, mcpPlatformData, serverData, serverLists, dataSource, searchQuery, currentPage, pageSize, directMcpTotal, directMcpTotalPages]);

    // 搜索和分页 - Skills
    const skillsResult = useMemo(() => {
        if (resourceType !== 'skills') return {items: [], totalPages: 0, totalItems: 0, startIndex: 0, endIndex: 0};

        // 服务端真分页源（如 SkillHub）：后端按 page/pageSize 已返回当前页，且 pageInfo.total
        // 为上游真实总量、totalPages 为真实总页数。前端直接用其驱动分页控件，不再本地切片。
        if (isDirectSkillSource && directPagingMode === 'server') {
            const items = skillsDirectItems || [];
            const totalItems = typeof directTotal === 'number' ? directTotal : items.length;
            const totalPages = typeof directTotalPages === 'number' ? directTotalPages : (items.length > 0 ? 1 : 0);
            const startIndex = (currentPage - 1) * pageSize + 1;
            const endIndex = Math.min(startIndex - 1 + items.length, totalItems);
            return {items, totalPages, totalItems, startIndex, endIndex};
        }

        // 本地分页源（如 ClawHub）或 GitHub Registry：对本地已加载/累积列表做搜索过滤 + 切片分页
        const list = isDirectSkillSource
            ? (skillsDirectItems || [])
            : (skillsData || skillsList || []);

        // 搜索过滤（分类筛选 UI 已移除，不再按分类过滤）
        const filtered = searchQuery
            ? list.filter(skill =>
                skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                skill.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                skill.author.toLowerCase().includes(searchQuery.toLowerCase())
            )
            : list;

        // 分页范围基于「实际可浏览的本地条数」：直连源为本地全量分页（受主进程拉取上限约束，
        // 如 ClawHub 最多拉 CLAWHUB_MAX_ITEMS 条），因此翻页范围须与本地数据一致，避免翻到空白页。
        // 顶部「共 N 个」的真实平台总量由 displayTotal（后端透传的 serverTotal）单独展示。
        const totalItems = filtered.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        const startIndex = (currentPage - 1) * pageSize;
        const endIndex = Math.min(startIndex + pageSize, totalItems);
        const items = filtered.slice(startIndex, endIndex);
        return {items, totalPages, totalItems, startIndex: startIndex + 1, endIndex};
    }, [resourceType, isDirectSkillSource, skillsDirectItems, skillsData, skillsList, searchQuery, currentPage, pageSize, directTotal, directTotalPages, directPagingMode]);

    const isLoading = resourceType === 'mcp'
        ? (mcpConnId ? isLoadingPlatform : isLoadingServers)
        : (isDirectSkillSource ? isLoadingSkillsDirect : isLoadingSkills);
    const error = resourceType === 'mcp'
        ? (mcpConnId ? platformError : serverError)
        : (isDirectSkillSource ? skillsDirectError : skillsError);
    const result = resourceType === 'mcp' ? mcpResult : skillsResult;
    const baseRefetch = resourceType === 'mcp'
        ? (mcpConnId ? refetchPlatform : refetchServers)
        : (isDirectSkillSource ? refetchSkillsDirect : refetchSkills);

    // 重试并显示 toast
    const handleRetry = useCallback(async () => {
        try {
            await baseRefetch();
            toast.success(t('store.retrySuccess') || 'Data loaded successfully');
        } catch {
            toast.error(t('store.retryFailed') || 'Failed to load data');
        }
    }, [baseRefetch, t]);

    // 强制刷新数据（跳过缓存）
    // 注意：依赖数组必须包含 mcpConnId / selectedConn / isDirectSkillSource / selectedSkillSourceId，
    // 否则在 resourceType/dataSource 未变的纯源切换场景下，闭包会沿用旧的分支判断值，
    // 导致强制刷新刷的是「切换前」的源而非当前选中的源。
    const handleForceRefresh = useCallback(async () => {
        setIsForceRefreshing(true);
        const startTime = Date.now();
        try {
            if (resourceType === 'mcp') {
                if (mcpConnId) {
                    await refetchPlatform();
                } else {
                    const data = await forceRefreshServerList(dataSource);
                    setServerList(dataSource, data);
                    // 强制刷新后覆盖「全部」总数缓存
                    setTotalCache('mcp', dataSource, data.length);
                }
            } else {
                if (isDirectSkillSource) {
                    await refetchSkillsDirect();
                } else {
                    const skillKey = selectedSkillSourceId || 'github';
                    const data = await forceRefreshSkillsList();
                    setSkillsList(data);
                    // 强制刷新后覆盖「全部」总数缓存
                    setTotalCache('skills', skillKey, data.length);
                }
            }
            const elapsed = Date.now() - startTime;
            if (elapsed < 1500) await new Promise(r => setTimeout(r, 1500 - elapsed));
            toast.success(t('store.refreshSuccess') || 'Data refreshed');
        } catch {
            toast.error(t('store.refreshFailed') || 'Failed to refresh data');
        } finally {
            setIsForceRefreshing(false);
        }
    }, [resourceType, dataSource, mcpConnId, isDirectSkillSource, selectedConn, selectedSkillSourceId, refetchPlatform, refetchSkillsDirect, setServerList, setSkillsList, t]);

    // 获取 attribution 文本
    const selectedMcpConn = mcpSources.find(c => c.id === mcpConnId) || null;
    // 下拉当前值：以「实际生效的来源」为准，保证下拉显示 = 实际加载的数据。
    // 优先级：用户已选平台连接(mcpConnId) → dataSource 对应的内置源 → 列表首条。
    // 注意：不再让「默认源」优先于 dataSource，否则 mcpConnId 为 null（内置源生效）而
    // 默认源是平台连接时，下拉会高亮平台连接但内容仍是内置源，且点选内置源也无法切换（默认源始终胜出）。
    const selectedMcpSourceId =
        mcpConnId ??
        mcpSources.find(c => c.platformType === dataSource)?.id ??
        mcpSources[0]?.id ??
        '';
    const attributionText = resourceType === 'mcp'
        ? selectedMcpConn
            ? `MCP servers from ${selectedMcpConn.name || selectedMcpConn.baseUrl}`
            : (dataSource === 'official'
                ? t('store.attributionOfficial')
                : t('store.attributionSmithery'))
        : selectedConn
            ? `Skills from ${selectedConn.name || selectedConn.baseUrl}`
            : (t('store.attributionSkills') || 'Data from GitHub repositories');

    // 顶部「全部」总数：优先读 1 天缓存；缓存缺失时回退到当前结果数（列表加载完成后由 queryFn 写入缓存）
    const totalSourceKey = resourceType === 'mcp'
        ? (mcpConnId ?? dataSource)
        : (isDirectSkillSource ? (selectedConn?.id ?? '') : (selectedSkillSourceId || 'github'));
    const cachedTotal = getTotalCache(resourceType, totalSourceKey);
    const displayTotal = cachedTotal ?? result.totalItems;

    return (
        <div className="flex flex-col h-full bg-[#1c1c1e]">
            {/* 头部工具栏（一体化标题栏：mac 上兼作拖拽区并为交通灯留白） */}
            <div
                className={`flex items-center justify-between gap-3 px-4 h-12 drag-region border-b border-[#3a3a3c] bg-[#1c1c1e]/80 backdrop-blur-xl sticky top-0 z-10 ${isMac ? 'pl-20' : ''}`}
            >
                {/* min-w-0 让左侧在空间不足时收缩，避免把右侧搜索框挤到重叠 */}
                <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden no-drag">
                    <h1 className="text-[14px] font-semibold text-white whitespace-nowrap tracking-tight">
                        {t('store.title')}
                    </h1>

                    {/* 资源类型切换 */}
                    <div className="flex items-center bg-[#3a3a3c] rounded-lg p-0.5 shrink-0">
                        <button
                            onClick={() => setResourceType('mcp')}
                            className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                resourceType === 'mcp'
                                    ? 'bg-[#636366] text-white'
                                    : 'text-[#98989d] hover:text-white'
                            }`}
                        >
                            MCP Servers
                        </button>
                        <button
                            onClick={() => setResourceType('skills')}
                            className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                resourceType === 'skills'
                                    ? 'bg-[#636366] text-white'
                                    : 'text-[#98989d] hover:text-white'
                            }`}
                        >
                            Skills
                        </button>
                    </div>

                    <span className="text-[12px] text-[#98989d] whitespace-nowrap shrink-0 tabular-nums">
            {displayTotal} {resourceType === 'mcp' ? (t('store.servers') || 'servers') : (t('store.skills') || 'skills')}
          </span>

                    {/* 数据源切换 - 仅 MCP 显示：来自「MCP 源管理」的已启用源 */}
                    {resourceType === 'mcp' && (
                        <select
                            value={selectedMcpSourceId}
                            onChange={e => {
                                const v = e.target.value;
                                if (v === '__add__') {
                                    window.location.hash = '#/settings';
                                    return;
                                }
                                const src = mcpSources.find(c => c.id === v);
                                if (!src) return;
                                // 内置源走 registry 内置抓取；其余走平台源直连
                                if (src.platformType === 'official' || src.platformType === 'smithery') {
                                    setDataSource(src.platformType);
                                    setMcpConnId(null);
                                } else {
                                    setMcpConnId(src.id);
                                }
                                setCurrentPage(1);
                            }}
                            className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/40 focus:outline-none whitespace-nowrap shrink-0"
                            title="选择 MCP 来源"
                        >
                            {mcpSources.map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                            {mcpSources.length === 0 && (
                                <option value="__add__">＋ 去设置添加 MCP 源…</option>
                            )}
                        </select>
                    )}

                    {/* Skills 来源切换 - 仅 Skills 显示：GitHub Registry + 已配置的 Skill 源管理 */}
                    {resourceType === 'skills' && (
                        <select
                            value={selectedSkillSourceId || ''}
                            onChange={e => {
                                const v = e.target.value;
                                if (v === '__add__') {
                                    window.location.hash = '#/settings';
                                    return;
                                }
                                setSelectedSkillSourceId(v || null);
                                setCurrentPage(1);
                            }}
                            className="px-2.5 py-1 rounded-full text-[12px] font-medium bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/40 focus:outline-none whitespace-nowrap shrink-0"
                            title="选择 Skills 来源"
                        >
                            {connections.map(c => (
                                <option key={c.id} value={c.id}>{c.name}{c.isDefault ? '（默认）' : ''}</option>
                            ))}
                            {connections.length === 0 && (
                                <option value="__add__">＋ 去设置添加 Skill 源管理…</option>
                            )}
                        </select>
                    )}

                    {/* 强制刷新按钮 */}
                    <button
                        onClick={handleForceRefresh}
                        disabled={isForceRefreshing || isLoading}
                        className="p-1.5 rounded-md text-[#98989d] hover:text-white hover:bg-[#3a3a3c] transition-colors disabled:opacity-50 shrink-0"
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
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#636366]"
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
                        className={`w-full pl-9 ${searchQuery ? 'pr-8' : 'pr-3'} py-1.5 rounded-lg bg-[#3a3a3c] text-[13px] text-white placeholder:text-[#636366] border-none focus:ring-1 focus:ring-[#0a84ff] text-ellipsis`}
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[#636366] hover:text-white cursor-pointer transition-colors"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                 strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto">
                {isLoading ? (
                    <div className="flex flex-col items-center justify-center h-full">
                        <div
                            className="w-8 h-8 border-2 border-[#3a3a3c] border-t-[#0a84ff] rounded-full animate-spin mb-3"/>
                        <p className="text-[13px] text-[#98989d]">{t('store.loading')}</p>
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
                        <p className="text-[13px] text-[#98989d] mb-3">{t('store.error')}</p>
                        <button
                            onClick={handleRetry}
                            className="btn btn-secondary text-[13px]"
                        >
                            {t('store.retry')}
                        </button>
                    </div>
                ) : result.items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full px-8">
                        <div className="w-14 h-14 rounded-full bg-[#0a84ff]/10 flex items-center justify-center mb-4">
                            <svg className="w-7 h-7 text-[#0a84ff]" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round"
                                      d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75"/>
                            </svg>
                        </div>
                        <p className="text-[15px] text-white font-medium mb-2">
                            {resourceType === 'skills' && directUnsupported
                                ? '该 Skill 源未提供公开列表接口'
                                : resourceType === 'skills' && connections.length === 0
                                    ? '添加 Skill 源管理以浏览平台 Skills'
                                    : resourceType === 'mcp' && mcpConnId
                                        ? '该平台暂无匹配的 MCP Server'
                                        : '暂无数据'}
                        </p>
                        <p className="text-[13px] text-[#98989d] text-center leading-relaxed mb-4">
                            {resourceType === 'skills' && directUnsupported
                                ? `「${selectedConn?.name || '该平台'}」是 SPA 站点，未开放公开的 skills 列表接口（所有候选端点均返回页面外壳），无法在此直接浏览。如需安装其技能，请用「粘贴 GitHub 仓库链接」方式导入。`
                                : resourceType === 'skills' && connections.length === 0
                                    ? '当前 Skills 来自 GitHub Registry。你可以在「设置 → Skill 源管理」中添加 ModelScope / SafeSkill / SkillHub / SkillsMP 等平台直连（或任意自定义 skill 站点），切换后即可浏览各平台的技能。'
                                    : resourceType === 'mcp' && mcpConnId
                                        ? `来自「${selectedMcpConn?.name || '该平台'}」的搜索没有结果，试试切换分类或更换来源（确保连接已通过验证）。`
                                        : (t('store.communityEditionDesc', 'No items found. Try switching the data source or adjusting your search.') as string)}
                        </p>
                        {resourceType === 'skills' && connections.length === 0 ? (
                            <button
                                onClick={() => {
                                    window.location.hash = '#/settings';
                                }}
                                className="px-4 py-2 bg-[#0a84ff] hover:bg-[#0a84ff]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
                            >
                                去设置添加 Skill 源管理
                            </button>
                        ) : resourceType === 'mcp' && mcpConnId ? (
                            <button
                                onClick={() => {
                                    window.location.hash = '#/settings';
                                }}
                                className="px-4 py-2 bg-[#0a84ff] hover:bg-[#0a84ff]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
                            >
                                去设置管理 Skill 源管理
                            </button>
                        ) : (
                            <button
                                onClick={() => window.location.hash = '#/library'}
                                className="px-4 py-2 bg-[#0a84ff] hover:bg-[#0a84ff]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
                            >
                                {t('store.goToLibrary', 'Go to Library')}
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="p-4">
                        {/* 网格布局：每行2个卡片 */}
                        {/* 使用包含 currentPage 的 key 确保翻页时完全重新渲染列表 */}
                        <div key={`grid-${resourceType}-${currentPage}`} className="grid grid-cols-2 gap-3">
                            {resourceType === 'mcp' ? (
                                // MCP Servers 网格
                                (result.items as any[]).map((server, index) => (
                                    <ServerCard
                                        key={`${currentPage}-${index}-${server.id}`}
                                        server={server}
                                        dataSource={dataSource}
                                        isInstalled={installedServerIds.has(server.id)}
                                        platformConnId={mcpConnId}
                                    />
                                ))
                            ) : (
                                // Skills 网格
                                (result.items as SkillListItem[]).map((skill, index) => (
                                    <SkillCard
                                        key={`${currentPage}-${index}-${skill.id}`}
                                        skill={skill}
                                        isInstalled={installedSkillIds.has(skill.name)}
                                        connectionId={isDirectSkillSource ? selectedSkillSourceId ?? undefined : undefined}
                                        sourceUrl={isDirectSkillSource ? (skill.repository?.url || skill.authorUrl || undefined) : undefined}
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
                    className="flex items-center justify-between gap-3 px-4 py-2 border-t border-[#3a3a3c] bg-[#2c2c2e]">
          <span className="text-[11px] text-[#636366] truncate">
            {attributionText}
          </span>
                    <div className="flex items-center gap-3 shrink-0">
                        {/* 每页条数控制 */}
                        <label className="flex items-center gap-1.5 text-[11px] text-[#98989d] whitespace-nowrap">
                            {t('store.pageSize') || '每页'}
                            <select
                                value={pageSize}
                                onChange={(e) => setPageSize(Number(e.target.value))}
                                className="px-1.5 py-0.5 rounded-md text-[11px] bg-[#3a3a3c] text-white border border-[#48484a] focus:outline-none focus:ring-1 focus:ring-[#0a84ff]"
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
