import {useTranslation} from 'react-i18next';
import type {PlatformFacets} from '../lib/electron';

interface StoreFilterBarProps {
  facets: PlatformFacets | null;
  category: string;
  sort: string;
  sourceFilter: string;
  onCategoryChange: (id: string) => void;
  onSortChange: (id: string) => void;
  onSourceFilterChange: (id: string) => void;
  onClearFilters: () => void;
}

export default function StoreFilterBar({
  facets,
  category,
  sort,
  sourceFilter,
  onCategoryChange,
  onSortChange,
  onSourceFilterChange,
  onClearFilters,
}: StoreFilterBarProps) {
  const { t } = useTranslation();

  if (!facets || (facets.categories.length === 0 && facets.sortOptions.length === 0)) {
    return null;
  }

  const hasActiveFilters = category !== 'all' || sort !== 'relevance' || sourceFilter !== 'all';

  return (
    <div className="px-4 pt-3 pb-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]/60 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => onCategoryChange('all')}
          className={`px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors ${
            category === 'all'
              ? 'bg-[var(--color-accent)] text-white'
              : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)] hover:text-[var(--color-text)]'
          }`}
        >
          {t('store.allCategories')}
        </button>
        {facets.categories.map(cat => (
          <div key={cat.id} className="relative group" tabIndex={0}>
            <button
              onClick={() => onCategoryChange(cat.id)}
              className={`px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors ${
                category === cat.id
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-surface-hover)] text-[var(--color-muted2)] hover:text-[var(--color-text)]'
              }`}
              title={cat.count != null ? `${cat.name} (${cat.count})` : cat.name}
              tabIndex={-1}
            >
              {cat.name}{cat.count != null ? ` (${cat.count})` : ''}
            </button>
            {cat.children && cat.children.length > 0 && (
              <div className="hidden group-hover:flex group-focus-within:flex absolute z-20 top-full left-0 mt-1 p-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-xl flex-col gap-1 min-w-[140px]">
                <button
                  onClick={() => onCategoryChange(cat.id)}
                  className="px-2 py-1 rounded-md text-[12px] text-left text-[var(--color-muted2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                >
                  {t('store.allCategories')}{cat.name}
                </button>
                {cat.children.map(sub => (
                  <button
                    key={sub.id}
                    onClick={() => onCategoryChange(sub.id)}
                    className={`px-2 py-1 rounded-md text-[12px] text-left transition-colors ${
                      category === sub.id
                        ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                        : 'text-[var(--color-muted2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]'
                    }`}
                  >
                    {sub.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <span className="text-[12px] text-[var(--color-muted)] shrink-0">{t('store.sort')}</span>
        <select
          value={sort}
          onChange={e => onSortChange(e.target.value)}
          className="px-2 py-0.5 rounded-md text-[12px] bg-[var(--color-surface-hover)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        >
          {facets.sortOptions.map(o => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>

        {facets.sourceFilter && facets.sourceFilter.length > 0 && (
          <>
            <span className="text-[12px] text-[var(--color-muted)] shrink-0 ml-2">{t('store.source')}</span>
            <select
              value={sourceFilter}
              onChange={e => onSourceFilterChange(e.target.value)}
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