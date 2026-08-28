/**
 * 平台 Skill 解析器 —— ClawHub 趋势榜单专用数据源。
 * 公开接口、无凭证即可查询；游标翻页，首屏优先 + 后台补全。详见原文件注释。
 */

import {
    CLAWHUB_DOWNLOAD_BASE,
    CLAWHUB_PAGE_LIMIT,
    CLAWHUB_TRENDING_BASE,
    CLAWHUB_TRENDING_URL,
} from '../../shared/platform-constants';
import type {PlatformSearchPage, PlatformSkillListItem} from './types';
import {fetchText} from './pagination';

/** 趋势榜单缓存 TTL：10 分钟，避免每次搜索重打接口 */
const CLAWHUB_CACHE_TTL = 10 * 60 * 1000;
/** ClawHub 游标翻页的安全上限（防止上游 nextCursor 异常时不终止）；正常会在 nextCursor 耗尽时停止 */
const CLAWHUB_MAX_FETCH_PAGES = 500;
/**
 * 首屏优先：冷加载时先串行拉前 N 页（≈ N×CLAWHUB_PAGE_LIMIT 条）即返回首页并渲染，
 * 剩余页在后台继续补全。这样把冷加载首屏从「等全量（≈28 页 ≈ 8s）」降到「约 2 页 RTT（≈0.6s）」。
 */
const CLAWHUB_FIRST_PAGES = 2;
let clawhubCache: { ts: number; items: PlatformSkillListItem[]; total: number; complete: boolean } | null = null;
let clawhubInflight: Promise<{ items: PlatformSkillListItem[]; total: number; complete: boolean }> | null = null;

/** 把趋势榜单的单条原始记录映射成通用 skill 列表项，无法识别 id 时返回 null */
function mapClawhubEntry(entry: unknown): PlatformSkillListItem | null {
    const e = (entry ?? {}) as Record<string, unknown>;
    // 稳定 id：优先用 install.reference（如 tuobadaidai/consult-report 或
    // skills-sh:heygen-com/...），缺省回退到顶层 id / slug
    const install = (e.install as Record<string, unknown> | undefined) || {};
    const ref = String(install.reference ?? '');
    const id = ref || String(e.id ?? '') || String(e.slug ?? '');
    if (!id) return null;
    const installSourceUrl = String(install.sourceUrl ?? '');
    const linkSource = String((e.links as Record<string, unknown> | undefined)?.source ?? '');
    const canonical = String(e.canonicalUrl ?? '');
    const kind = String(install.kind ?? '');
    const slug = String(e.slug ?? '');

    // 下载通道按 install.kind 区分（实测榜单只有 clawhub / skills-sh 两类）：
    //  - clawhub 原生：install.reference 是 "<owner>/<slug>" 但 **不是** GitHub 仓库
    //    （如 plato-1/fable-method，github.com 上并不存在），拼 github 链接必然 404。
    //    正确通道是站内 zip 直链 /api/v1/download?slug=<slug>，包内含 SKILL.md。
    //  - skills-sh：install.sourceUrl 指向 skills.sh 详情页（SPA，抓 HTML 拿不到源），
    //    但 sourceIdentity 给出了真实的 GitHub owner/repo，交给 resolveSkillsShSkill
    //    在安装时定位具体 skill 子目录。
    let downloadUrl: string | undefined;
    let sourceUrl = '';
    if (kind === 'clawhub') {
        downloadUrl = `${CLAWHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug || id)}`;
        sourceUrl = canonical ? `https://clawhub.ai${canonical}` : `https://clawhub.ai/skills/${id}`;
    } else {
        sourceUrl = installSourceUrl || linkSource;
        if (!sourceUrl && ref && !ref.includes(':')) {
            sourceUrl = `https://github.com/${ref}`;
        }
        if (!sourceUrl) {
            sourceUrl = canonical ? `https://clawhub.ai${canonical}` : `https://clawhub.ai/skills/${id}`;
        }
    }

    const metrics = (e.metrics as Record<string, unknown> | undefined) || {};
    const lifetimeInstalls = typeof metrics.lifetimeInstalls === 'number' ? metrics.lifetimeInstalls : undefined;
    const updatedAt = typeof metrics.updatedAt === 'number' ? new Date(metrics.updatedAt).toISOString() : undefined;
    return {
        id,
        name: String(e.displayName ?? e.name ?? id),
        description: String(e.summary ?? e.description ?? ''),
        source: 'clawhub',
        sourceUrl,
        downloadUrl,
        stars: lifetimeInstalls,
        updatedAt,
        category: typeof e.lane === 'string' && e.lane ? e.lane : undefined,
        extra: {
            ref,
            slug: e.slug,
            installKind: install.kind,
            installSourceUrl,
            source: e.source,
            lane: e.lane,
            canonicalUrl: canonical,
            lifetimeInstalls,
            sourceIdentity: e.sourceIdentity,
            trust: e.trust,
        },
    };
}

/** 翻页拉取状态（在阶段一与后台补全之间共享） */
interface ClawhubFetchState {
    list: PlatformSkillListItem[];
    seen: Set<string>;
    cursor: string | null;
    upstreamTotal: number;
    fetchPages: number;
}

/**
 * 顺着 nextCursor 串行拉取最多 maxPages 页，累加到 state。
 * - 首页拉取失败：抛出错误（视为数据源不可用）。
 * - 后续页拉取失败 / 空页 / 无下一页：停止（保留已得部分）。
 * 返回 'stop' 表示已拉到尽头或中途一页失败，'done' 表示达到 maxPages。
 */
async function fetchClawhubPages(state: ClawhubFetchState, maxPages: number): Promise<'done' | 'stop'> {
    const log = (..._args: unknown[]) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[resolver]', ..._args);
    };
    while (state.fetchPages < maxPages) {
        const limit = CLAWHUB_PAGE_LIMIT;
        const url =
            `${CLAWHUB_TRENDING_BASE}&limit=${limit}` +
            (state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : '');

        const raw = await fetchText(url);
        if (!raw) {
            // 首页就失败视为不可用；后续页失败则保留已拿到的部分，不整体报错
            if (state.list.length === 0) {
                log(`✗ 无法获取趋势榜单（${url}）`);
                throw new Error('无法获取 ClawHub 技能榜单，请检查网络连接');
            }
            log(`! 第 ${state.list.length / CLAWHUB_PAGE_LIMIT + 1} 页拉取失败，使用已获取的 ${state.list.length} 条`);
            return 'stop';
        }

        let json: unknown;
        try {
            json = JSON.parse(raw);
        } catch {
            if (state.list.length === 0) {
                log(`✗ 响应不是合法 JSON`);
                throw new Error('ClawHub 返回了非预期的数据格式');
            }
            return 'stop';
        }

        const body = (json ?? {}) as { items?: unknown; nextCursor?: unknown; totalItems?: unknown };
        if (typeof body.totalItems === 'number') state.upstreamTotal = body.totalItems;

        const pageItems = Array.isArray(body.items) ? body.items : [];
        if (pageItems.length === 0) return 'stop';

        for (const entry of pageItems) {
            const mapped = mapClawhubEntry(entry);
            // 上游按趋势快照排序，翻页时偶有重复条目，按 id 去重
            if (!mapped || state.seen.has(mapped.id)) continue;
            state.seen.add(mapped.id);
            state.list.push(mapped);
        }

        const next = typeof body.nextCursor === 'string' ? body.nextCursor : '';
        if (!next || next === state.cursor) return 'stop';
        state.cursor = next;
        state.fetchPages++;
    }
    return 'done';
}

/** 阶段一完成后，在后台继续把剩余页拉全并写回缓存 */
async function completeClawhubInBackground(state: ClawhubFetchState): Promise<void> {
    const log = (..._args: unknown[]) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[resolver]', ..._args);
    };
    try {
        await fetchClawhubPages(state, CLAWHUB_MAX_FETCH_PAGES);
    } catch (e) {
        log(`! 后台补全中断：`, e);
    }
    if (clawhubCache) {
        // 用新数组引用，便于前端 refetch 感知到数据增长
        clawhubCache = {ts: clawhubCache.ts, items: [...state.list], total: state.upstreamTotal, complete: true};
    }
    log(`✓ 后台补全完成：${state.list.length} 个 trending skill（上游共 ${state.upstreamTotal || '未知'} 条）`);
}

async function loadClawhubTrending(): Promise<{ items: PlatformSkillListItem[]; total: number; complete: boolean }> {
    const log = (..._args: unknown[]) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[resolver]', ..._args);
    };

    if (clawhubCache && Date.now() - clawhubCache.ts < CLAWHUB_CACHE_TTL) {
        return {items: clawhubCache.items, total: clawhubCache.total, complete: clawhubCache.complete};
    }
    if (clawhubInflight) return clawhubInflight;

    clawhubInflight = (async () => {
        const state: ClawhubFetchState = {
            list: [],
            seen: new Set<string>(),
            cursor: null,
            upstreamTotal: 0,
            fetchPages: 0,
        };

        // 阶段一：仅拉前 CLAWHUB_FIRST_PAGES 页（≈0.6s），足以首页渲染 + 前段本地搜索，
        // 拉满即把 partial 写缓存并返回，剩余页转入后台补全（completeClawhubInBackground）。
        await fetchClawhubPages(state, CLAWHUB_FIRST_PAGES);

        // 写 partial 缓存（complete:false），随后后台继续拉全量
        clawhubCache = {ts: Date.now(), items: state.list, total: state.upstreamTotal, complete: false};
        void completeClawhubInBackground(state);
        log(`✓ 首屏就绪：${state.list.length} 个 trending skill（后台补全剩余页）`);
        return {items: [...state.list], total: state.upstreamTotal, complete: false};
    })();

    try {
        return await clawhubInflight;
    } finally {
        clawhubInflight = null;
    }
}

async function searchClawhubPaged(
    query: string,
    page: number,
    pageSize: number,
    category: string
): Promise<PlatformSearchPage> {
    const {items: all, total: upstreamTotal, complete} = await loadClawhubTrending();
    let filtered = all;

    if (category) {
        filtered = filtered.filter(it => it.category === category);
    }

    const q = query.trim().toLowerCase();
    if (q) {
        filtered = filtered.filter(it => {
            const slug = String((it.extra as Record<string, unknown> | undefined)?.slug || '');
            return (
                it.name.toLowerCase().includes(q) ||
                it.description.toLowerCase().includes(q) ||
                slug.toLowerCase().includes(q)
            );
        });
    }

    const noFilter = !q && !category;
    // 未补全完成且处于无过滤态时，用「已加载条数」驱动分页，避免翻到尚未加载的空白页；
    // 后台补全完成（或上游未给 totalItems）后，再使用上游真实总量 upstreamTotal，保持页数稳定。
    const total = noFilter && complete && upstreamTotal > 0 ? upstreamTotal : filtered.length;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
        items,
        pageInfo: {page, pageSize, total, totalPages, hasMore: start + pageSize < total},
        // serverTotal 透传上游真实总量，供前端顶部「共 N 个」展示
        serverTotal: upstreamTotal > 0 ? upstreamTotal : undefined,
        // 本地切片分页：首屏（page=1）立即渲染，主进程在后台按页补全剩余数据；
        // complete 标记是否已完成全量，前端据此决定是否需要延迟 refetch 补齐。
        pagingMode: 'client',
        complete,
    };
}

export {CLAWHUB_DOWNLOAD_BASE, CLAWHUB_TRENDING_URL, searchClawhubPaged};
