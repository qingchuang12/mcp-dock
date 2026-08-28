/**
 * 服务器卡片组件 - 网格布局卡片
 * 支持多数据源 (Official / Smithery)
 * 紧凑高度设计
 */

import {memo, type KeyboardEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import type {DataSource, ServerListItem} from '../api/registry';
import {isOfficialListItem, isSmitheryListItem} from '../api/registry';
import {ClockIcon, DownloadIcon, EyeIcon, VerifiedIcon} from './Icons';
import {formatCompactNumber, formatRelativeTime, localizeKey} from '../lib/format';

interface ServerCardProps {
  server: ServerListItem;
  dataSource: DataSource;
  isInstalled?: boolean;
  /** 平台源（如 ModelScope）连接 ID，用于跳转到平台详情页 */
  platformConnId?: string | null;
}

import EntityAvatar from './store/EntityAvatar';

function ServerCard({ server, dataSource, isInstalled, platformConnId }: ServerCardProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const githubUsername = isOfficialListItem(server) 
    ? server.repository?.url?.match(/github\.com\/([^\/]+)/)?.[1] ?? null
    : null;

  const isPlatformSource =
    server.source === 'platform' ||
    ['modelscope', 'safeskill', 'skillhub', 'skillsmp', 'clawhub', 'bailian'].includes(server.source ?? '');

  const handleClick = () => {
    // 平台源（如 ModelScope）走独立的详情页路由，附带连接 ID；同时透传列表项以便详情页展示分类/浏览量
    if (isPlatformSource && platformConnId) {
      navigate(`/detail/platform/${encodeURIComponent(server.id)}?conn=${encodeURIComponent(platformConnId)}`, {state: {server}});
      return;
    }
    navigate(`/detail/${dataSource}/${encodeURIComponent(server.id)}`);
  };

  // S1-7: 卡片需键盘可达（Enter / Space 触发跳转）
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  // 分类徽章（平台源提供的 categories/tags）
  // 平台源优先用中文展示名（categoryNames，与 categories 一一对应），避免直接显示英文 slug；
  // categories 仍保留原始 slug，供分类过滤精确匹配。
  const catList: string[] = isPlatformSource
    ? (server.categoryNames?.length ? server.categoryNames : server.categories ?? server.tags ?? [])
    : server.tags ?? [];

  // 获取更新时间（Official 数据源）
  const lastCommitAt = isOfficialListItem(server) ? server.lastCommitAt : null;
  const updatedAt = isOfficialListItem(server) ? server.updatedAt : null;
  const updateTime = lastCommitAt || updatedAt;

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      className="card p-3 cursor-pointer hover:bg-[var(--color-surface-hover)]/30 transition-colors flex flex-col h-[115px]"
    >
      {/* 顶部内容区域 */}
      <div className="flex items-start gap-2.5 flex-1 min-h-0">
        {/* 图标 */}
        <div className="flex-shrink-0">
          <EntityAvatar name={server.displayName} iconUrl={server.iconUrl} githubUsername={githubUsername} />
        </div>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[13px] font-medium text-[var(--color-text)] truncate min-w-0 flex-1">
              {server.displayName}
            </h3>
            {catList.slice(0, 3).map(cat => (
              <span key={cat} className="px-1.5 py-0 rounded-full text-[9px] bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20 flex-shrink-0 whitespace-nowrap">
                {localizeKey(t, i18n, `mcpCategory.${cat}`, cat)}
              </span>
            ))}
            {catList.length > 3 && (
              <span className="px-1.5 py-0 rounded-full text-[9px] text-[var(--color-muted2)] border border-[var(--color-border)] flex-shrink-0 whitespace-nowrap">
                +{catList.length - 3}
              </span>
            )}
            {isInstalled && (
              <span className="tag tag-success text-[9px] px-1 py-0 flex-shrink-0">
                {t('detail.installed')}
              </span>
            )}
          </div>
          <p className="text-[12px] text-[var(--color-muted2)] line-clamp-2 mt-0.5 leading-relaxed">
            {server.description || 'No description'}
          </p>
        </div>
      </div>

      {/* 底部信息 - 紧凑设计 */}
      <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[var(--color-border)]/50">
        {isOfficialListItem(server) ? (
          // Official 数据源
          <>
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
              <span className="font-mono">v{server.version}</span>
              {server.author && (
                <span>@{server.author}</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
              {/* Star 数 */}
              {(server.stars ?? 0) > 0 && (
                <span className="flex items-center gap-0.5">
                  <svg className="w-3 h-3 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  {formatCompactNumber(server.stars)}
                </span>
              )}
              {/* 更新时间 */}
              {updateTime && (
                <span className="flex items-center gap-0.5">
                  <ClockIcon className="w-3 h-3" />
                  {formatRelativeTime(t, updateTime)}
                </span>
              )}
            </div>
          </>
        ) : isSmitheryListItem(server) ? (
          // Smithery 数据源
          <>
            {typeof server.downloads === 'number' && server.downloads > 0 && (
              <span className="text-[12px] text-[var(--color-muted)] flex items-center gap-1">
                <DownloadIcon className="w-3 h-3" />
                {formatCompactNumber(server.downloads)}
              </span>
            )}
            {server.verified && (
              <VerifiedIcon className="w-3.5 h-3.5 text-[var(--color-accent)]" />
            )}
          </>
        ) : isPlatformSource ? (
          // 平台源（modelscope / skillhub / bailian 等）
          <>
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
              {server.author && (
                <span>@{server.author}</span>
              )}
              {server.stars != null && server.stars > 0 && (
                <span className="flex items-center gap-0.5">
                  <svg className="w-3 h-3 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  {formatCompactNumber(server.stars)}
                </span>
              )}
              {typeof server.viewCount === 'number' && server.viewCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <EyeIcon className="w-3 h-3" />
                  {formatCompactNumber(server.viewCount)}
                </span>
              )}
              {server.extra?.callTotalCount != null && (
                <span>{formatCompactNumber(server.extra.callTotalCount as number)} {t('store.callCount')}</span>
              )}
            </div>
            {(server.extra?.isHosted === true || server.isHosted === true) ? (
              <span className="text-[10px] text-[var(--color-accent)] flex-shrink-0">{t('store.cloudHosted')}</span>
            ) : (
              <span className="text-[10px] text-[var(--color-muted2)] flex-shrink-0">{server.source}</span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default memo(ServerCard);
