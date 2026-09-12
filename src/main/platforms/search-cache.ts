/**
 * 平台直连源搜索结果的磁盘缓存（SWR）。
 *
 * 为什么需要：内置源（GitHub / Smithery）走磁盘缓存 + 后台 revalidate，首屏命中缓存秒开；
 * 而平台直连源（ModelScope 等）此前只有渲染层 10 分钟的内存缓存，应用重启即失效，
 * 每次冷启动都要实打实等一次网络（实测 ModelScope 0.36~0.63s），体感明显慢于内置源。
 *
 * 语义与内置源对齐：命中缓存立即返回，过期则在后台静默刷新，下次调用拿到新数据。
 * 放在主进程侧，对所有平台源通用，渲染层无需改动。
 */
import {createHash} from 'crypto';
import type {CacheManager} from '../cache-manager';
import type {PlatformSearchPage} from './types';

export type PlatformSearchCacheKey = `platform-search-${string}`;

export interface PlatformSearchCacheInput {
    platformType: string;
    /** 连接标识，用于区分指向同一 baseUrl 的不同连接；缺省时回退 baseUrl */
    connectionId?: string | null;
    baseUrl?: string;
    query?: string;
    page?: number;
    pageSize?: number;
    category?: string;
    sort?: string;
    /** 鉴权态（是否携带令牌）。只进布尔态，secret 本身不进 key、不落盘。 */
    authorized?: boolean;
}

/**
 * 只缓存「成功且有数据」的结果：
 * - 失败结果（403 限流 / 网络错误 / 页码越界，均带 message）不落盘，否则会把异常固化一个 TTL 周期；
 * - 空结果同样不落盘，避免一次偶然的空响应让后续请求长时间拿不到数据。
 */
function isCacheable(page: PlatformSearchPage | null | undefined): page is PlatformSearchPage {
    return !!page && Array.isArray(page.items) && page.items.length > 0 && !page.message;
}

/**
 * 构造缓存 key。凭证（secret）**不参与** key，也不落盘；但鉴权**态**参与——
 * 否则先匿名搜索落缓存、再绑定 Token 搜同一条件会命中匿名旧结果，
 * 带鉴权才能看到的数据永远拿不到（D11）。结果做 sha1 摘要，
 * 避免长 query / 中文分类导致 key 过长（key 会用作缓存文件名）。
 */
export function buildPlatformSearchKey(p: PlatformSearchCacheInput): PlatformSearchCacheKey {
    const raw = [
        p.platformType,
        p.connectionId || p.baseUrl || '',
        p.query ?? '',
        p.page ?? 1,
        p.pageSize ?? 20,
        p.category ?? '',
        p.sort ?? '',
        p.authorized ? 'auth' : 'anon',
    ].join('|');
    const digest = createHash('sha1').update(raw).digest('hex').slice(0, 16);
    return `platform-search-${p.platformType}-${digest}`;
}

/**
 * 以 SWR 语义执行平台搜索：命中缓存立即返回（过期则后台静默刷新），未命中才同步请求。
 * @param fetcher 真正发起网络请求的闭包，由调用方保证已绑定凭据等参数
 */
export async function withPlatformSearchCache(
    cache: CacheManager,
    key: PlatformSearchCacheKey,
    fetcher: () => Promise<PlatformSearchPage>
): Promise<PlatformSearchPage> {
    const cached = await cache.get<PlatformSearchPage>(key).catch(() => null);
    if (cached?.data) {
        const expired = await cache.isExpired(key).catch(() => true);
        if (expired) {
            // 后台刷新不阻塞本次返回；失败也不影响已缓存数据
            void fetcher()
                .then(fresh => (isCacheable(fresh) ? cache.set(key, fresh) : undefined))
                .catch(() => undefined);
        }
        return cached.data;
    }

    const fresh = await fetcher();
    if (isCacheable(fresh)) {
        await cache.set(key, fresh).catch(() => undefined);
    }
    return fresh;
}
