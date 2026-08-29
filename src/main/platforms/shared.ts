/**
 * 平台 adapter 共享工具：HTTP 拉取、端点探测、分页元信息抽取、诊断缓存。
 *
 * 这些函数与具体平台无关，被各 adapter 复用，避免重复实现。
 */
import type {
    DirectSearchAttempt,
    DirectSearchDiagnostics,
    PlatformPageInfo,
    PlatformSearchPage,
    SupportedPlatform,
} from './types';

/** 默认 User-Agent（模拟浏览器，避免部分接口拒绝无 UA 请求）。 */
export const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 默认每页条数。 */
export const DIRECT_SEARCH_PAGE_SIZE = 20;

/**
 * 拉取文本（带超时与 UA）。失败/非 2xx 返回 null，由调用方决定如何上报诊断。
 */
export async function fetchText(
    url: string,
    timeoutMs = 15000,
    headers: Record<string, string> = {}
): Promise<string | null> {
    const controller = new AbortController();
    const t = setTimeout(() => (controller as any).abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: {'User-Agent': UA, 'Accept': 'text/plain,application/json,*/*', ...headers},
            redirect: 'follow',
            signal: (controller as any).signal,
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

/**
 * PUT 请求并返回 JSON（用于 ModelScope MCP server 端点）。
 *
 * 返回值区分两种失败，供调用方给出准确提示：
 * - `null`：网络层失败/超时且重试后仍失败，根本没拿到响应；
 * - `{ok: false, status}`：拿到了 HTTP 响应但非 2xx（status 用于区分 403 限流与 5xx 等）。
 *
 * 重试：ModelScope 网关对突发/并发连接偶发返回连接超时（UND_ERR_CONNECT_TIMEOUT），
 * 单次裸请求失败率很高，翻页时几乎每页都可能误报「请求失败」。对网络错误/超时/5xx
 * 自动重试 2 次（退避 400/800ms），与 Skill 端点 probeEndpoints 内的 fetchWithRetry 一致。
 * 4xx（鉴权/参数错误/配额 403）为终态不重试——403 限流需保持原样让调用方提示用户稍后重试。
 */
export async function fetchJson(
    url: string,
    body: Record<string, unknown>,
    timeoutMs = 20000,
    extraHeaders: Record<string, string> = {}
): Promise<{json: any; text: string; status: number; ok: boolean} | null> {
    const headers: Record<string, string> = {
        'User-Agent': UA,
        'Accept': 'application/json,text/html,*/*',
        'Content-Type': 'application/json',
        ...extraHeaders,
    };

    for (let i = 0; i <= 2; i++) {
        const controller = new AbortController();
        const t = setTimeout(() => (controller as any).abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'PUT',
                headers,
                body: JSON.stringify(body),
                redirect: 'follow',
                signal: (controller as any).signal,
            });
            if (res.ok) {
                const text = await res.text();
                let json: any = null;
                try { json = JSON.parse(text); } catch { /* ignore */ }
                return {json, text, status: res.status, ok: true};
            }
            // 4xx 为终态（含 403 配额/限流），不重试，直接返回供调用方判定
            if (res.status >= 400 && res.status < 500) {
                return {json: null, text: '', status: res.status, ok: false};
            }
            // 5xx：落空到下方重试逻辑（下一轮）
        } catch {
            // 网络错误 / 超时（AbortError）：可重试
        } finally {
            clearTimeout(t);
        }
        if (i < 2) await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
    }
    return null;
}

/** 拼接 baseUrl 与 path，自动处理斜杠。 */
export function buildUrl(base: string, path: string): string {
    const b = base.replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return b + p;
}

/** 把模板里的 {q}/{page}/{size}/{category}/{sort}/{order} 占位符替换为转义后的实际值。 */
export function fillTpl(tpl: string, q: string, page: number, size = 20, category = '', sort = '', order = ''): string {
    return tpl
        .replace(/\{q\}/g, encodeURIComponent(q))
        .replace(/\{page\}/g, String(page))
        .replace(/\{size\}/g, String(size))
        .replace(/\{category\}/g, category ? encodeURIComponent(category) : '')
        .replace(/\{sort\}/g, sort ? encodeURIComponent(sort) : '')
        .replace(/\{order\}/g, order ? encodeURIComponent(order) : '');
}

/** 从任意 JSON 响应中定位数组（兼容各平台包裹层级）。 */
export function locateArray(json: any): unknown[] {
    if (Array.isArray(json)) return json;
    const candidates = [
        json?.data?.skills,
        json?.data?.mcp_server_list,
        json?.skills,
        json?.items,
        json?.data?.list,
        json?.data?.items,
        json?.data,
        json?.results,
        json?.list,
    ];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return [];
}

/** 从数组里挑出「像 skill」的条目（含 name/title/id/slug/repo 之一）。 */
export function pickLike(arr: unknown[]): Record<string, unknown>[] {
    return arr.filter(
        (x): x is Record<string, unknown> =>
            !!x &&
            typeof x === 'object' &&
            ('name' in x || 'title' in x || 'id' in x || 'slug' in x || 'repo' in x)
    );
}

/**
 * 从平台响应中抽取分页元信息。
 * 兼容 ModelScope（page/page_size 与 page_number/page_size）、SkillsMP（pagination）等层级。
 */
export function extractPageInfo(
    json: any,
    requestedPage: number,
    requestedSize: number,
    itemCount: number
): PlatformPageInfo {
    const p =
        json?.data?.pagination ||
        json?.pagination ||
        json?.Data?.McpServer ||
        json?.Data ||
        json?.data ||
        json ||
        {};

    const num = (v: unknown): number | null => {
        const n = typeof v === 'string' ? Number(v) : v;
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    };

    const total =
        num(p.total) ?? num(p.total_count) ?? num(p.totalCount) ??
        num(json?.Data?.McpServer?.TotalCount) ?? num(json?.Data?.totalCount) ??
        num(json?.Data?.total) ?? num(json?.total);
    const pageSize = num(p.page_size) ?? num(p.pageSize) ?? num(p.limit) ?? num(p.per_page) ?? requestedSize;
    const page = num(p.page_number) ?? num(p.pageNumber) ?? num(p.page) ?? requestedPage;

    const effectiveSize = pageSize && pageSize > 0 ? pageSize : requestedSize;

    let totalPages = num(p.total_pages) ?? num(p.totalPages) ?? num(p.pages);
    if (totalPages === null && total !== null && effectiveSize > 0) {
        totalPages = Math.ceil(total / effectiveSize);
    }

    let hasMore: boolean;
    if (typeof p.hasNext === 'boolean') hasMore = p.hasNext;
    else if (total !== null) hasMore = page * effectiveSize < total;
    else if (totalPages !== null) hasMore = page < totalPages;
    else hasMore = itemCount >= effectiveSize;

    return {
        page: page > 0 ? page : requestedPage,
        pageSize: effectiveSize,
        total,
        totalPages,
        hasMore,
    };
}

/** 空结果分页信息（保持结构稳定，避免渲染层判空）。 */
export function emptyPageInfo(page: number, pageSize: number): PlatformPageInfo {
    return {page, pageSize, total: 0, totalPages: 0, hasMore: false};
}

// ---------------------------------------------------------------------------
//  诊断缓存：最近一次搜索的诊断按平台缓存，供 IPC 查询回传
// ---------------------------------------------------------------------------
const lastDiagnostics = new Map<string, DirectSearchDiagnostics>();

export function setDiagnostics(platform: SupportedPlatform, diag: DirectSearchDiagnostics): void {
    lastDiagnostics.set(platform, diag);
}

export function getDiagnostics(platform: string): DirectSearchDiagnostics | null {
    return lastDiagnostics.get(platform) || null;
}

/**
 * 探测候选端点，命中第一个返回 skill 数组的端点。
 * 返回 { attempt 序列, 命中 url, 原始 json, 命中条目 } 供调用方映射。
 */
export interface ProbeResult {
    attempts: DirectSearchAttempt[];
    matchedUrl: string | null;
    json: any;
    items: Record<string, unknown>[];
}

/**
 * 带超时与指数退避重试的 fetch（P1-15）。
 * - 网络错误（fetch 抛错）/ 5xx 视为可重试，最多重试 2 次，退避 400ms / 800ms；
 * - 4xx（鉴权/参数错误）与 2xx 为终态，不重试，直接返回。
 * 每个请求自带 AbortController 超时控制。
 */
async function fetchWithRetry(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    maxRetries = 2
): Promise<{res: Response; text: string}> {
    let lastErr: unknown;
    for (let i = 0; i <= maxRetries; i++) {
        const controller = new AbortController();
        const t = setTimeout(() => (controller as any).abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                headers: {'User-Agent': UA, 'Accept': 'application/json,text/html,*/*', ...headers},
                redirect: 'follow',
                signal: (controller as any).signal,
            });
            if (res.ok || (res.status >= 400 && res.status < 500)) {
                const text = await res.text();
                return {res, text};
            }
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (e) {
            lastErr = e;
        } finally {
            clearTimeout(t);
        }
        if (i < maxRetries) {
            await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
        }
    }
    throw lastErr;
}

export async function probeEndpoints(
    platform: SupportedPlatform,
    baseUrl: string,
    endpoints: string[],
    query: string,
    page: number,
    pageSize: number,
    category: string,
    sort = '',
    secret?: string | null,
    order = ''
): Promise<ProbeResult> {
    const headers: Record<string, string> = {
        'User-Agent': UA,
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const attempts: DirectSearchAttempt[] = [];
    let matchedUrl: string | null = null;
    let matchedJson: any = null;
    let matchedItems: Record<string, unknown>[] = [];

    // 总体预算：避免最坏情况串行探测无限挂起（P1-15）
    const perTimeout = platform === 'modelscope' ? 20000 : 15000;
    const deadline = Date.now() + Math.min(perTimeout * endpoints.length, 45000);

    for (const ep of endpoints) {
        if (Date.now() > deadline) {
            attempts.push({
                url: buildUrl(baseUrl, fillTpl(ep, query, page, pageSize, category, sort, order)),
                ok: false,
                durationMs: 0,
                reason: 'budget',
                message: '超过总体探测预算，已中止后续端点',
            });
            break;
        }
        const url = buildUrl(baseUrl, fillTpl(ep, query, page, pageSize, category, sort, order));
        const timeoutMs = perTimeout;
        const started = Date.now();
        const attempt: DirectSearchAttempt = {url, ok: false, durationMs: 0};

        try {
            const {res, text} = await fetchWithRetry(url, headers, timeoutMs);
            attempt.status = res.status;
            attempt.contentType = res.headers.get('content-type') || '';

            if (!res.ok) {
                attempt.reason = 'http';
                attempt.message =
                    res.status === 401 || res.status === 403
                        ? `鉴权失败（HTTP ${res.status}）：令牌无效或无该接口权限`
                        : `HTTP ${res.status}`;
                continue;
            }

            attempt.bytes = text.length;

            if (
                !attempt.contentType.includes('json') &&
                !text.trimStart().startsWith('{') &&
                !text.trimStart().startsWith('[')
            ) {
                attempt.reason = 'non-json';
                attempt.message = `返回 HTML 而非 JSON（SPA 壳页，${text.length} 字节），该端点非数据接口`;
                continue;
            }

            let json: any;
            try {
                json = JSON.parse(text);
            } catch (e) {
                attempt.reason = 'parse';
                attempt.message = `JSON 解析失败：${(e as Error).message}`;
                continue;
            }

            const arr = locateArray(json);
            const liked = pickLike(arr);
            attempt.itemCount = liked.length;

            if (liked.length > 0) {
                attempt.ok = true;
                attempt.durationMs = Date.now() - started;
                matchedUrl = url;
                matchedJson = json;
                matchedItems = liked;
                break;
            }

            attempt.reason = 'empty';
            attempt.message = `响应为合法 JSON 但未找到 skill 数组（topKeys=${Object.keys(json || {}).join(',')}）`;
        } catch (e) {
            const err = e as Error & {cause?: {code?: string}};
            attempt.errorCode = err.cause?.code || err.name;
            attempt.reason = err.name === 'AbortError' ? 'timeout' : 'network';
            attempt.message =
                err.name === 'AbortError'
                    ? `请求超时（>${timeoutMs}ms），该端点可能被网关限制或不可达`
                    : `网络错误 ${attempt.errorCode}：${err.message}`;
        } finally {
            if (!attempt.ok) attempt.durationMs = Date.now() - started;
            attempts.push(attempt);
        }
    }

    return {attempts, matchedUrl, json: matchedJson, items: matchedItems};
}

/** 生成空页结果（结构稳定）。 */
export function emptySearchPage(page: number, pageSize: number): PlatformSearchPage {
    return {items: [], pageInfo: emptyPageInfo(page, pageSize)};
}

/** 构建面向用户的诊断提示（根据各 attempt 的失败原因聚合）。 */
export function buildHint(
    platformName: string,
    attempts: DirectSearchAttempt[],
    safePage: number
): string {
    const allNonJson = attempts.length > 0 && attempts.every(a => a.reason === 'non-json');
    const anyAuthFail = attempts.some(a => a.status === 401 || a.status === 403);
    const allTimeout = attempts.length > 0 && attempts.every(a => a.reason === 'timeout');
    const allEmpty = attempts.length > 0 && attempts.every(a => a.reason === 'empty');

    if (anyAuthFail) {
        return '令牌鉴权失败（401/403）。请在「设置 → API 令牌」确认令牌有效且具备读取权限。';
    } else if (allEmpty && safePage > 1) {
        return `第 ${safePage} 页没有更多技能了，请返回上一页。`;
    } else if (allTimeout) {
        return '所有端点请求超时。请检查网络/代理，或该平台接口对客户端直连有网关限制。';
    } else if (allNonJson) {
        return (
            `${platformName} 当前未开放公开的 JSON 搜索接口（所有候选端点均返回 SPA 页面）。` +
            `请改用「粘贴 GitHub 仓库链接」方式导入该平台的技能。`
        );
    } else {
        return `${platformName} 未返回可解析的技能列表，详见诊断信息。`;
    }
}