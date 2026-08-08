import type {SkillListItem, ServerListItem} from '../api/registry';

/**
 * 商店数据源查询的缓存时长：10 分钟。
 * 配合 react-query 的 staleTime / gcTime 使用——在 10 分钟内切换页面 / 标签页 / 分页
 * 时直接命中缓存、立即渲染，无需重新等待在线请求；超过 10 分钟再判定为过期并重新拉取。
 */
export const STORE_QUERY_STALE_MS = 10 * 60 * 1000;

/**
 * 商店数据查询对外统一的返回结构。
 * 无论内置源（前端切片）还是平台源（服务端分页），都收敛为同一形状，
 * 让 Store.tsx 只做渲染、不再感知底层分页策略差异。
 */
export interface StoreData<T> {
    /** 当前页要渲染的条目 */
    items: T[];
    /** 真实总数（平台源取自 pageInfo.total / serverTotal；内置源取过滤后条数） */
    total: number;
    /** 同 total，便于分页组件直接使用 */
    totalItems: number;
    /** 总页数，一律 Math.ceil(total / pageSize) */
    totalPages: number;
    /** 当前页起始序号（从 1 开始，无数据时 0） */
    startIndex: number;
    /** 当前页结束序号（含） */
    endIndex: number;
    /** 分页模式：server=服务端按页查询；client=前端切片 */
    pagingMode: 'server' | 'client';
    /** 平台是否未开放公开接口（SPA 壳页），用于给友好空态提示 */
    isUnsupported: boolean;
    isLoading: boolean;
    isFetching: boolean;
    error: Error | null;
    /** 平台源返回的友好提示（非致命），如 ModelScope 配额超限，UI 应优先展示 */
    message?: string;
    /** 强制重新拉取当前源数据 */
    refetch: () => void;
}

export type StoreResourceType = 'mcp' | 'skills';

export type {SkillListItem, ServerListItem};
