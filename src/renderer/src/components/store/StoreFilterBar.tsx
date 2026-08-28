import {useTranslation} from 'react-i18next';
import type {PlatformFacets} from '../../lib/electron';

interface StoreFilterBarProps {
  facets: PlatformFacets | null;
  sort: string;
  sourceFilter: string;
  onSortChange: (id: string) => void;
  onSourceFilterChange: (id: string) => void;
  onClearFilters: () => void;
}

export default function StoreFilterBar({
  facets,
  sort,
  sourceFilter,
  onSortChange,
  onSourceFilterChange,
  onClearFilters,
}: StoreFilterBarProps) {
  const { t } = useTranslation();

  // 排序与来源过滤都没有可选项时，第二栏整体隐藏
  if (!facets) {
    return null;
  }

  const hasSort = facets.sortOptions.length > 0;
  const hasSourceFilter = !!(facets.sourceFilter && facets.sourceFilter.length > 0);

  if (!hasSort && !hasSourceFilter) {
    return null;
  }

  const hasActiveFilters = sort !== 'relevance' || sourceFilter !== 'all';

  return (
    <div className="px-4 pt-3 pb-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]/60 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        {hasSort && (
          <>
            <span className="text-[12px] text-[var(--color-muted)] shrink-0">{t('store.sort')}</span>
            <select
              value={sort}
              onChange={e => onSortChange(e.target.value)}
              aria-label={t('store.sortLabel', {defaultValue: 'Sort by'})}
              className="px-2 py-0.5 rounded-md text-[12px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              {facets.sortOptions.map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </>
        )}

        {facets.sourceFilter && facets.sourceFilter.length > 0 && (
          <>
            <span className="text-[12px] text-[var(--color-muted)] shrink-0 ml-2">{t('store.source')}</span>
            <select
              value={sourceFilter}
              onChange={e => onSourceFilterChange(e.target.value)}
              aria-label={t('store.sourceFilterLabel', {defaultValue: 'Filter by source'})}
              className="px-2 py-0.5 rounded-md text-[12px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              <option value="all">{t('store.allSources')}</option>
              {facets.sourceFilter.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.count != null ? ` (${s.count})` : ''}</option>
              ))}
            </select>
          </>
        )}

        {hasActiveFilters && (
          <button
            onClick={onClearFilters}
            className="ml-auto text-[12px] text-[var(--color-muted2)] hover:text-[var(--color-accent)] transition-colors"
          >
            {t('store.clearFilters')}
          </button>
        )}
      </div>
    </div>
  );
}
