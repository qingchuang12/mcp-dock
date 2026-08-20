import {useTranslation} from 'react-i18next';
import type {StoreResourceType} from '../hooks/storeTypes';

interface StoreEmptyStateProps {
  resourceType: StoreResourceType;
  friendlyMessage: string | null;
  isUnsupported: boolean;
  connectionsCount: number;
  mcpConnId: string | null;
  connName: string | null;
}

export default function StoreEmptyState({
  resourceType,
  friendlyMessage,
  isUnsupported,
  connectionsCount,
  mcpConnId,
  connName,
}: StoreEmptyStateProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-full px-8">
      <div className="w-14 h-14 rounded-full bg-[var(--color-accent)]/10 flex items-center justify-center mb-4">
        <svg className="w-7 h-7 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75" />
        </svg>
      </div>

      {friendlyMessage ? (
        renderFriendlyMessage(friendlyMessage, t)
      ) : (
        renderNormalEmpty(resourceType, isUnsupported, connectionsCount, mcpConnId, connName, t)
      )}

      {resourceType === 'skills' && connectionsCount === 0 ? (
        <button
          onClick={() => { window.location.hash = '#/settings'; }}
          className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
        >
          {t('store.goToSettings')}
        </button>
      ) : resourceType === 'mcp' && mcpConnId ? (
        <button
          onClick={() => { window.location.hash = '#/settings'; }}
          className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
        >
          {t('store.goToSettings')}
        </button>
      ) : (
        <button
          onClick={() => { window.location.hash = '#/library'; }}
          className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-white text-[13px] font-medium rounded-lg transition-colors"
        >
          {t('store.goToLibrary', 'Go to Library')}
        </button>
      )}
    </div>
  );
}

function renderFriendlyMessage(
  friendlyMessage: string,
  t: ReturnType<typeof useTranslation>['t']
) {
  const isQuota = friendlyMessage === '__QUOTA_LIMIT_EXCEED__';
  return (
    <>
      <p className="text-[15px] text-[var(--color-text)] font-medium mb-2">
        {isQuota
          ? (t('store.quotaLimitTitle', '请尝试使用关键字搜索') as string)
          : (t('store.queryHintTitle', '无法完成查询') as string)}
      </p>
      <p className="text-[13px] text-[var(--color-muted2)] text-center leading-relaxed mb-4">
        {isQuota
          ? (t('store.quotaLimitHint', '当前查询超出了 ModelScope 接口的单次配额限制（页码 × 每页条数上限为 100）。请在上方搜索框输入关键字以缩小范围后再试。') as string)
          : friendlyMessage}
      </p>
    </>
  );
}

function renderNormalEmpty(
  resourceType: StoreResourceType,
  isUnsupported: boolean,
  connectionsCount: number,
  mcpConnId: string | null,
  connName: string | null,
  t: ReturnType<typeof useTranslation>['t']
) {
  let title: string;
  let desc: string;

  if (resourceType === 'skills' && isUnsupported) {
    title = t('store.emptySkillUnsupported', '该 Skill 源未提供公开列表接口');
    desc = t('store.emptySkillUnsupportedDesc', '{{name}} is an SPA site...', { name: connName || t('store.emptySkillUnsupported') });
  } else if (resourceType === 'skills' && connectionsCount === 0) {
    title = t('store.emptySkillNoConnections', '添加 Skill 源管理以浏览平台 Skills');
    desc = t('store.emptySkillNoConnectionsDesc', '当前 Skills 来自 GitHub Registry...');
  } else if (resourceType === 'mcp' && mcpConnId) {
    title = t('store.emptyMcpPlatform', '该平台暂无匹配的 MCP Server');
    desc = t('store.emptyMcpPlatformDesc', '来自...', { name: connName || t('store.emptyMcpPlatform') });
  } else {
    title = t('store.emptyDefault', '暂无数据');
    desc = t('store.communityEditionDesc', 'No items found. Try switching the data source or adjusting your search.') as string;
  }

  return (
    <>
      <p className="text-[15px] text-[var(--color-text)] font-medium mb-2">{title}</p>
      <p className="text-[13px] text-[var(--color-muted2)] text-center leading-relaxed mb-4">{desc}</p>
    </>
  );
}