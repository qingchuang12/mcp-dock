/**
 * 分页组件 - Surge 风格
 *
 * - 始终显示「当前范围 / 总数」计数（即使只有一页也展示，避免「分页功能消失」的错觉）。
 * - 多页时提供页码跳转（首页 / 上一页 / 当前页附近 / 下一页 / 尾页），并用省略号收敛中间页码。
 * - 服务端无总数（canJump=false，如 npm 平台分类/下载排序的候选池模式）时退化为「仅上/下一页」：
 *   有下一页由 hasMore 判定，避免因 totalPages=1 而整块隐藏、导致分类切换后无法翻页。
 */

import {useTranslation} from 'react-i18next';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
  /** 是否允许页码跳转；total 为 null（服务端无总数）时 false，仅保留上/下一页 */
  canJump?: boolean;
  /** 是否还有下一页；total 为 null（canJump=false）时唯一可靠的翻页依据 */
  hasMore?: boolean;
}

/** 生成需要展示的页码序列（含省略号占位 -1） */
function buildPageList(current: number, total: number): number[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set<number>([1, total, current]);
  for (let d = 1; d <= 1; d++) {
    if (current - d >= 1) pages.add(current - d);
    if (current + d <= total) pages.add(current + d);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: number[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push(-1); // 省略号
    out.push(p);
    prev = p;
  }
  return out;
}

export default function Pagination({
  currentPage,
  totalPages,
  totalItems,
  startIndex,
  endIndex,
  onPageChange,
  canJump = true,
  hasMore = false,
}: PaginationProps) {
  const { t } = useTranslation();

  const go = (p: number) => {
    if (p < 1 || p > totalPages || p === currentPage) return;
    onPageChange(p);
  };

  // 完整页码跳转需满足：允许跳页 且 已知总页数（>1）。
  const showJump = canJump && totalPages > 1;
  // 上/下一页可用性：总量未知（canJump=false）时下一页由 hasMore 判定。
  const hasPrev = currentPage > 1;
  const hasNext = canJump ? currentPage < totalPages : hasMore;
  // 任一方向可导航（或可页码跳转）时就渲染按钮组——否则分类/下载排序等 total 未知场景
  // 会因 totalPages=1 而整块隐藏，出现「分类切换后分页消失」。
  const showNav = showJump || hasPrev || hasNext;
  // 总量未知时无法给出精确总数，用「+」标示可能有后续命中。
  const tail = canJump ? '' : '+';

  return (
    <div className="flex items-center gap-3">
      <span className="text-[12px] text-[var(--color-muted)] whitespace-nowrap">
        {startIndex + 1}-{endIndex} / {totalItems}{tail}
      </span>

      {showNav && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => go(currentPage - 1)}
            disabled={!hasPrev}
            aria-label={t('store.prevPage', {defaultValue: 'Previous'})}
            className="p-1 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-muted2)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>

          {showJump && buildPageList(currentPage, totalPages).map((p, i) =>
            p === -1 ? (
              <span key={`e-${i}`} className="text-[12px] text-[var(--color-muted)] px-1">
                …
              </span>
            ) : (
              <button
                key={p}
                onClick={() => go(p)}
                className={
                  'min-w-[24px] h-[24px] px-1.5 rounded text-[12px] transition-colors ' +
                  (p === currentPage
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'text-[var(--color-muted2)] hover:text-white hover:bg-[var(--color-surface-active)]')
                }
              >
                {p}
              </button>
            )
          )}

          <button
            onClick={() => go(currentPage + 1)}
            disabled={!hasNext}
            aria-label={t('store.nextPage', {defaultValue: 'Next'})}
            className="p-1 rounded text-[var(--color-muted2)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-muted2)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
