/**
 * 商店页面 - 编排容器
 * 支持 MCP Servers 和 Skills 双资源类型，网格布局
 * 数据查询收口到 hooks，本文件只负责状态编排与子组件渲染
 */

import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useStore} from '../store/useStore';
import {useElectronAPI} from '../lib/electron';
import {useIsMac} from '../lib/useIsMac';
import Pagination from '../components/Pagination';
import {toast} from '../components/Toast';
import {useStoreSourceSelection} from '../hooks/useStoreSourceSelection';
import {useStoreData} from '../hooks/useStoreData';
import {useStoreFacets} from '../hooks/useStoreFacets';
import {useDebouncedValue} from '../hooks/useDebouncedValue';
import {useStoreAttribution} from '../hooks/useStoreAttribution';
import StoreToolbar from './StoreToolbar';
import StoreFilterBar from './StoreFilterBar';
import StoreGrid from './StoreGrid';
import StoreEmptyState from './StoreEmptyState';
import StoreErrorState from './StoreErrorState';

export default function StorePage() {
  const { t } = useTranslation();
  const api = useElectronAPI();
  const isMac = useIsMac();

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
  const [category, setCategory] = useState<string>('all');
  const [sort, setSort] = useState<string>('relevance');
  const [sourceFilter, setSourceFilter] = useState<string>('all');

  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const source = useStoreSourceSelection();

  useEffect(() => {
    setCategory('all');
    setSort('relevance');
    setSourceFilter('all');
  }, [resourceType, source.mcpConnId, source.selectedSkillSourceId]);

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
    category,
    sort,
    source: sourceFilter,
  });

  const facets = useStoreFacets({
    resourceType,
    mcpConnId: source.mcpConnId,
    selectedConn: source.selectedConn,
    isDirectSkillSource: source.isDirectSkillSource,
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [resourceType, setCurrentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [category, sort, sourceFilter, debouncedSearch, setCurrentPage]);

  useEffect(() => {
    api.config.getAllServers().then(({ servers }) => {
      setInstalledServerIds(Object.keys(servers));
    });
  }, [api, setInstalledServerIds]);

  useEffect(() => {
    api.skills.getAllInstalled().then(({ skills }) => {
      setInstalledSkillIds(Object.keys(skills));
    });
  }, [api, setInstalledSkillIds]);

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

  const selectedMcpConn = source.mcpSources.find(c => c.id === source.mcpConnId) || null;
  const attributionText = useStoreAttribution({
    resourceType,
    dataSource: source.dataSource,
    selectedMcpConn,
    selectedConn: source.selectedConn,
  });

  const result = data;
  const displayTotal = result.totalItems;
  const isLoading = data.isLoading;
  const isFetching = data.isFetching;
  const error = data.error;
  const friendlyMessage = data.message;

  const handleMcpSourceChange = useCallback((sourceId: string) => {
    const src = source.mcpSources.find(c => c.id === sourceId);
    if (!src) return;
    if (src.platformType === 'official' || src.platformType === 'smithery') {
      source.setDataSource(src.platformType);
      source.setMcpConnId(null);
    } else {
      source.setMcpConnId(src.id);
    }
  }, [source]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <StoreToolbar
        isMac={isMac}
        resourceType={resourceType}
        displayTotal={displayTotal}
        searchQuery={searchQuery}
        dataSource={source.dataSource}
        mcpSources={source.mcpSources}
        selectedMcpSourceId={source.selectedMcpSourceId}
        selectedMcpConn={selectedMcpConn}
        connections={source.connections}
        selectedSkillSourceId={source.selectedSkillSourceId}
        isForceRefreshing={isForceRefreshing}
        isLoading={isLoading}
        isFetching={isFetching}
        onResourceTypeChange={setResourceType}
        onSearchQueryChange={setSearchQuery}
        onMcpSourceChange={handleMcpSourceChange}
        onSkillSourceChange={source.setSelectedSkillSourceId}
        onForceRefresh={handleForceRefresh}
        onPageReset={() => setCurrentPage(1)}
      />

      <div className="flex-1 overflow-y-auto">
        <StoreFilterBar
          facets={facets}
          category={category}
          sort={sort}
          sourceFilter={sourceFilter}
          onCategoryChange={setCategory}
          onSortChange={setSort}
          onSourceFilterChange={setSourceFilter}
          onClearFilters={() => { setCategory('all'); setSort('relevance'); setSourceFilter('all'); }}
        />

        {isLoading && result.items.length === 0 ? (
          <LoadingSpinner />
        ) : error ? (
          <StoreErrorState onRetry={handleRetry} />
        ) : result.items.length === 0 ? (
          <StoreEmptyState
            resourceType={resourceType}
            friendlyMessage={friendlyMessage ?? null}
            isUnsupported={data.isUnsupported}
            connectionsCount={source.connections.length}
            mcpConnId={source.mcpConnId}
            connName={source.selectedConn?.name || null}
          />
        ) : (
          <StoreGrid
            resourceType={resourceType}
            currentPage={currentPage}
            items={result.items}
            dataSource={source.dataSource}
            installedServerIds={installedServerIds}
            installedSkillIds={installedSkillIds}
            mcpConnId={source.mcpConnId}
            isDirectSkillSource={source.isDirectSkillSource}
            selectedSkillSourceId={source.selectedSkillSourceId}
          />
        )}
      </div>

      {!isLoading && !error && result.items.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <span className="text-[12px] text-[var(--color-muted)] truncate">
            {attributionText}
          </span>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted2)] whitespace-nowrap">
              {t('store.pageSize') || '每页'}
              <select
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
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

function LoadingSpinner() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[var(--color-border)] border-t-[#0a84ff] rounded-full animate-spin mb-3" />
      <p className="text-[13px] text-[var(--color-muted2)]">{t('store.loading')}</p>
    </div>
  );
}