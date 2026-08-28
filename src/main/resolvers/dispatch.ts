/**
 * 平台 Skill 解析器 —— 统一分发层。
 * 负责：直连搜索的诊断缓存、searchPlatformDirect(Paged) 的候选端点自适应探测、
 * 以及 resolveDirectSkill 的源归一化分发。详见原文件注释。
 */

import type {PlatformType} from '../../shared/platform-constants';
import {SkillsManager} from '../skills-manager';
import type {
    DirectSearchAttempt,
    DirectSearchDiagnostics,
    PlatformPageInfo,
    PlatformSearchPage,
    PlatformSkillListItem,
    ResolvePlatformResult,
    SupportedPlatform,
} from './types';
import {
    DIRECT_SEARCH_PAGE_SIZE,
    DIRECT_UA,
    MODELSCOPE_QUOTA_PRODUCT,
    PLATFORM_NAMES,
} from './types';
import {
    buildUrl,
    emptyPageInfo,
    extractPageInfo,
    fillTpl,
    locateSkillArray,
    pickSkillLike,
    toListItem,
} from './pagination';
import {extractRepoPaths, resolvePlatformSkillUrl} from './url-detect';
import {isZipDownloadUrl, resolveSkillsShSkill, resolveZipSkill, SKILLS_SH_URL_RE} from './install-zip';
import {SKILLHUB_API_BASE, searchSkillhubPaged} from './skillhub';
import {CLAWHUB_TRENDING_URL, searchClawhubPaged} from './clawhub';

/**
 * 各平台候选搜索端点模板（{q}=关键词, {page}=页码, {size}=每页条数）
 *
 * 端点顺序 = 探测优先级，已按真实环境实测结果排序（2026-08 实测）：
 *  - modelscope：`/openapi/v1/skills` 为唯一可用契约，返回 {success,data:{skills,total,page_number,page_size}}。
 *    注意：`/api/v1/*` 与 `/api/skills/*` 在直连环境下会 **连接超时**（UND_ERR_CONNECT_TIMEOUT，约 10s），
 *    并非 404 —— 这类路径疑似被网关按 Referer/浏览器上下文限制，故必须排在最后或移除，
 *    否则每次搜索会先白白阻塞 10~20s 再降级。
 *  - skillsmp：`/api/skills?search=` 返回标准 JSON（{skills,pagination,filters}），
 *    优先于 SSR HTML 抓取（更快且字段完整）。
 *  - safeskill / skillhub：实测所有候选 API 均返回 HTML（SPA 壳或 404 页），
 *    暂无公开 JSON 契约，保留候选以便平台开放后自动命中。
 */
const PLATFORM_SEARCH_ENDPOINTS: Record<Exclude<SupportedPlatform, 'unknown'>, string[]> = {
    modelscope: [
        // ModelScope skills 公开分页接口：GET /openapi/v1/skills?name={q}&page_number={page}&page_size={size}
        '/openapi/v1/skills?name={q}&page_number={page}&page_size={size}',
    ],
    safeskill: [
        '/api/v1/skills?query={q}&page={page}',
        '/hub/api/skills?search={q}&page={page}',
    ],
    skillhub: [
        '/api/v1/skills?search={q}&page={page}',
        '/api/skills?keyword={q}&page={page}',
    ],
    clawhub: [
        // 无公开关键词搜索契约：走专用趋势榜单实现（loadClawhubTrending），此处仅占位
        '/api/v1/trending?kind=skills&limit=20',
    ],
    skillsmp: [
        // 扁平搜索端点：实测 /api/skills?search={q} 对「空 q」也返回 40 条（total≈1200），
        // 而 v1 的 /api/v1/skills/search?q= 在空 q 时返回 MISSING_QUERY，会导致 Store 默认（空）搜索整条失败。
        // 故优先用扁平端点；其 {skills,pagination} 结构与 githubUrl/stars/updatedAt 字段已被 locateSkillArray/extractPageInfo/toListItem 兼容。
        '/api/skills?search={q}&page={page}&limit={size}',
        '/api/skills?search={q}&page={page}',
    ],
    bailian: [
        // 百炼离线索引，不走搜索端点
        '/api/v1/skills?search={q}&page={page}',
    ],
};

/** 最近一次直连搜索的诊断信息（按平台缓存，供 IPC 查询） */
const lastDiagnostics = new Map<string, DirectSearchDiagnostics>();

export function getLastDirectSearchDiagnostics(platform: string): DirectSearchDiagnostics | null {
    return lastDiagnostics.get(platform) || null;
}

/**
 * 用 API 直连（带 Bearer 令牌）搜索某平台 skill 列表（仅返回条目）。
 *
 * 保留此签名以兼容既有调用方；需要分页元信息时请使用
 * {@link searchPlatformDirectPaged}。
 */
export async function searchPlatformDirect(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    query: string,
    page = 1,
    pageSize = DIRECT_SEARCH_PAGE_SIZE,
    category = ''
): Promise<PlatformSkillListItem[]> {
    const {items} = await searchPlatformDirectPaged(platform, baseUrl, secret, query, page, pageSize, category);
    return items;
}

/**
 * 用 API 直连（带 Bearer 令牌）分页搜索某平台 skill 列表。
 * 自适应探测候选端点；命中即映射返回，并附带平台分页元信息。
 */
export async function searchPlatformDirectPaged(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    query: string,
    page = 1,
    pageSize = DIRECT_SEARCH_PAGE_SIZE,
    category = ''
): Promise<PlatformSearchPage> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DIRECT_SEARCH_PAGE_SIZE;

    if (platform === 'custom') {
        return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
    }
    const sp = platform as Exclude<SupportedPlatform, 'unknown'>;
    const startedAll = Date.now();

    // ModelScope 配额硬限制：page_number × page_size ≤ 100（见 source.md 错误码 QuotaLimitExceed）。
    // skills 与 mcp 同源，同样受此配额约束。按规则直接预判，越界时无需发起请求即可返回友好提示。
    if (sp === 'modelscope' && safePage * safeSize > MODELSCOPE_QUOTA_PRODUCT) {
        const maxPages = Math.max(1, Math.floor(MODELSCOPE_QUOTA_PRODUCT / safeSize));
        return {
            items: [],
            pageInfo: {page: safePage, pageSize: safeSize, total: MODELSCOPE_QUOTA_PRODUCT, totalPages: maxPages, hasMore: false},
            message: '__QUOTA_LIMIT_EXCEED__',
        };
    }

    // SkillHub：站点为 Next.js SPA，无任何公开 JSON 列表接口（所有候选端点均返回
    // HTML 壳），直接改用其开源清单仓库 iflytek/skillhub 的 builtin-skills 目录。
    // 提前返回可跳过必然失败的端点探测，避免每次搜索白等数秒。
    if (sp === 'skillhub') {
        try {
            const res = await searchSkillhubPaged(query, safePage, safeSize, category);
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: SKILLHUB_API_BASE,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: SKILLHUB_API_BASE,
                        ok: true,
                        itemCount: res.items.length,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: SKILLHUB_API_BASE,
                totalDurationMs: Date.now() - startedAll,
            });
            return res;
        } catch (e) {
            const msg = (e as Error).message;
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: SKILLHUB_API_BASE,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: SKILLHUB_API_BASE,
                        ok: false,
                        reason: 'network',
                        message: msg,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: null,
                totalDurationMs: Date.now() - startedAll,
                hint: `获取 SkillHub 技能清单失败：${msg}`,
            });
            // 网络失败属于真实故障，不能标记 unsupported（否则前端会误报"平台不支持"）
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }
    }

    // ClawHub：公开趋势榜单接口（无凭证），不支持关键词搜索，走专用本地分页实现
    if (sp === 'clawhub') {
        try {
            const res = await searchClawhubPaged(query, safePage, safeSize, category);
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: CLAWHUB_TRENDING_URL,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: CLAWHUB_TRENDING_URL,
                        ok: true,
                        itemCount: res.items.length,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: CLAWHUB_TRENDING_URL,
                totalDurationMs: Date.now() - startedAll,
            });
            return res;
        } catch (e) {
            const msg = (e as Error).message;
            lastDiagnostics.set(sp, {
                platform: sp,
                baseUrl: CLAWHUB_TRENDING_URL,
                query,
                page: safePage,
                category,
                authorized: !!secret,
                attempts: [
                    {
                        url: CLAWHUB_TRENDING_URL,
                        ok: false,
                        reason: 'network',
                        message: msg,
                        durationMs: Date.now() - startedAll,
                    },
                ],
                matchedUrl: null,
                totalDurationMs: Date.now() - startedAll,
                hint: `获取 ClawHub 技能榜单失败：${msg}`,
            });
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }
    }

    const diag: DirectSearchDiagnostics = {
        platform: sp,
        baseUrl,
        query,
        page: safePage,
        category,
        authorized: !!secret,
        attempts: [],
        matchedUrl: null,
        totalDurationMs: 0,
    };

    const headers: Record<string, string> = {
        'User-Agent': DIRECT_UA,
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    // 仅在有令牌时附带 Authorization：部分平台（如 ModelScope 公开接口）
    // 对携带无效 Bearer 的请求会直接 401，反而不如匿名可用。
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const log = (..._args: unknown[]) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[resolver]', ..._args);
    };

    log(`begin platform=${sp} base=${baseUrl} q="${query}" page=${safePage} size=${safeSize} auth=${!!secret}`);

    const endpoints = PLATFORM_SEARCH_ENDPOINTS[sp] || [];

    for (const ep of endpoints) {
        const url = buildUrl(baseUrl, fillTpl(ep, query, safePage, safeSize, category));
        const controller = new AbortController();
        // ModelScope 首字节较慢（实测 6s+），给足 20s；其余 15s
        const timeoutMs = sp === 'modelscope' ? 20000 : 15000;
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const started = Date.now();
        const attempt: DirectSearchAttempt = {url, ok: false, durationMs: 0};

        try {
            const res = await fetch(url, {headers, redirect: 'follow', signal: controller.signal});
            attempt.status = res.status;
            attempt.contentType = res.headers.get('content-type') || '';

            if (!res.ok) {
                attempt.reason = 'http';
                attempt.message =
                    res.status === 401 || res.status === 403
                        ? `鉴权失败（HTTP ${res.status}）：令牌无效或无该接口权限`
                        : `HTTP ${res.status}`;
                log(`  ✗ ${url} -> ${attempt.message}`);
                continue;
            }

            const text = await res.text();
            attempt.bytes = text.length;

            // 关键：SPA 平台常以 200 返回 HTML 壳，必须按内容而非状态码判定
            if (!attempt.contentType.includes('json') && !text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
                attempt.reason = 'non-json';
                attempt.message = `返回 HTML 而非 JSON（SPA 壳页，${text.length} 字节），该端点非数据接口`;
                log(`  ✗ ${url} -> ${attempt.message}`);
                continue;
            }

            let json: any;
            try {
                json = JSON.parse(text);
            } catch (e) {
                attempt.reason = 'parse';
                attempt.message = `JSON 解析失败：${(e as Error).message}`;
                log(`  ✗ ${url} -> ${attempt.message}`);
                continue;
            }

            const arr = locateSkillArray(json);
            const liked = pickSkillLike(arr);
            attempt.itemCount = liked.length;

            if (liked.length > 0) {
                attempt.ok = true;
                attempt.durationMs = Date.now() - started;
                diag.attempts.push(attempt);
                diag.matchedUrl = url;
                diag.totalDurationMs = Date.now() - startedAll;
                lastDiagnostics.set(sp, diag);

                const pageInfo = extractPageInfo(json, safePage, safeSize, liked.length);

                // ModelScope 配额：单次最多可检索 page × size ≤ 100 条，超出边界的页上游必拒。
                // 把可翻页数钳制在配额内（与 Smithery/MCP 的 totalPages 一样作为分页控件唯一真相），
                // 避免 UI 跳到必然失败的空白页；当 catalog 实际量大于可检索上限时，在末页提示关键字。
                if (sp === 'modelscope') {
                    const maxPages = Math.max(1, Math.floor(MODELSCOPE_QUOTA_PRODUCT / safeSize));
                    const maxTotal = maxPages * safeSize;
                    const rawTotal = json?.data?.total_count ?? json?.data?.total;
                    const rawTotalNum = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null;
                    const cappedTotal = rawTotalNum !== null ? Math.min(rawTotalNum, maxTotal) : maxTotal;
                    pageInfo.total = cappedTotal;
                    pageInfo.totalPages = Math.max(1, Math.ceil(cappedTotal / safeSize));
                    pageInfo.hasMore = safePage < pageInfo.totalPages;
                    if (rawTotalNum !== null && rawTotalNum > maxTotal && safePage >= pageInfo.totalPages) {
                        log(
                            `  ✓ ${url} -> 已达配额上限（catalog=${rawTotalNum} > ${maxTotal}），提示关键字搜索`
                        );
                        return {
                            items: liked.map(r => toListItem(r, sp)),
                            pageInfo,
                            message: '__QUOTA_LIMIT_EXCEED__',
                        };
                    }
                }

                log(
                    `  ✓ ${url} -> ${liked.length} items in ${attempt.durationMs}ms ` +
                    `(page ${pageInfo.page}/${pageInfo.totalPages ?? '?'}, total=${pageInfo.total ?? '?'}, hasMore=${pageInfo.hasMore})`
                );
                // 这些端点携带 {page}/{page_number} 与 {size} 参数、返回对应切片，本质是服务端真分页。
                // 前端据此按「client 预取」模式工作：先用首屏（page=1）立即渲染，再在后台把剩余页
                // 补全进本地列表做切片分页；分页总数一律由 pageInfo.total（服务端稳定真实总量）驱动，
                // 不会随本地列表累积增长而跳动。故不返回 pagingMode（默认 client）。
                return {items: liked.map(r => toListItem(r, sp)), pageInfo};
            }

            attempt.reason = 'empty';
            attempt.message = `响应为合法 JSON 但未找到 skill 数组（topKeys=${Object.keys(json || {}).join(',')}）`;
            log(`  ✗ ${url} -> ${attempt.message}`);
        } catch (e) {
            const err = e as Error & { cause?: { code?: string } };
            const code = err.cause?.code || err.name;
            attempt.errorCode = code;
            attempt.reason = err.name === 'AbortError' ? 'timeout' : 'network';
            attempt.message =
                err.name === 'AbortError'
                    ? `请求超时（>${timeoutMs}ms），该端点可能被网关限制或不可达`
                    : `网络错误 ${code}：${err.message}`;
            log(`  ✗ ${url} -> ${attempt.message}`);
        } finally {
            clearTimeout(t);
            if (!attempt.ok) {
                attempt.durationMs = Date.now() - started;
                diag.attempts.push(attempt);
            }
        }
    }

    // 兜底：SkillsMP 的 SSR 列表页可提取 "仓库: owner/repo"
    if (sp === 'skillsmp') {
        const listUrl = buildUrl(
            baseUrl,
            `/zh/skills?q=${encodeURIComponent(query)}&page=${safePage}`
        );
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        const started = Date.now();
        const attempt: DirectSearchAttempt = {url: listUrl, ok: false, durationMs: 0};
        try {
            const res = await fetch(listUrl, {headers, signal: controller.signal});
            attempt.status = res.status;
            if (res.ok) {
                const html = await res.text();
                attempt.bytes = html.length;
                const repos = extractRepoPaths(html);
                attempt.itemCount = repos.length;
                if (repos.length > 0) {
                    attempt.ok = true;
                    attempt.durationMs = Date.now() - started;
                    diag.attempts.push(attempt);
                    diag.matchedUrl = listUrl;
                    diag.totalDurationMs = Date.now() - startedAll;
                    lastDiagnostics.set(sp, diag);

                    // SSR 页面无分页契约：若该页已按 page 参数返回对应内容，则整页使用；
                    // 否则（服务端忽略 page）在本地切片，保证翻页行为一致、不重复。
                    const sliced = repos.length > safeSize
                        ? repos.slice((safePage - 1) * safeSize, safePage * safeSize)
                        : repos;

                    const pageInfo: PlatformPageInfo =
                        repos.length > safeSize
                            ? {
                                page: safePage,
                                pageSize: safeSize,
                                total: repos.length,
                                totalPages: Math.ceil(repos.length / safeSize),
                                hasMore: safePage * safeSize < repos.length,
                            }
                            : {
                                page: safePage,
                                pageSize: safeSize,
                                total: null,
                                totalPages: null,
                                hasMore: repos.length >= safeSize,
                            };

                    log(`  ✓ ${listUrl} (SSR) -> ${repos.length} repos, page ${safePage} -> ${sliced.length}`);
                    return {
                        items: sliced.map(r => ({
                            id: r,
                            name: r.split('/').pop() || r,
                            description: `GitHub 仓库 ${r}（来自 SkillsMP）`,
                            source: 'skillsmp' as SupportedPlatform,
                            sourceUrl: `https://github.com/${r}`,
                        })),
                        pageInfo,
                    };
                }
                attempt.reason = 'empty';
                attempt.message = 'SSR 页面未提取到仓库路径';
            } else {
                attempt.reason = 'http';
                attempt.message = `HTTP ${res.status}`;
            }
        } catch (e) {
            const err = e as Error & { cause?: { code?: string } };
            attempt.reason = err.name === 'AbortError' ? 'timeout' : 'network';
            attempt.errorCode = err.cause?.code || err.name;
            attempt.message = err.message;
        } finally {
            clearTimeout(t);
            if (!attempt.ok) {
                attempt.durationMs = Date.now() - started;
                diag.attempts.push(attempt);
            }
        }
    }

    // 全部候选端点未命中：生成可操作的用户提示
    const allNonJson = diag.attempts.length > 0 && diag.attempts.every(a => a.reason === 'non-json');
    const anyAuthFail = diag.attempts.some(a => a.status === 401 || a.status === 403);
    const allTimeout = diag.attempts.length > 0 && diag.attempts.every(a => a.reason === 'timeout');

    const allEmpty = diag.attempts.length > 0 && diag.attempts.every(a => a.reason === 'empty');

    if (anyAuthFail) {
        diag.hint = '令牌鉴权失败（401/403）。请在「设置 → API 令牌」确认令牌有效且具备读取权限。';
    } else if (allEmpty && safePage > 1) {
        // 翻页翻过头：接口正常但该页无数据，明确引导回上一页
        diag.hint = `第 ${safePage} 页没有更多技能了，请返回上一页。`;
    } else if (allTimeout) {
        diag.hint = '所有端点请求超时。请检查网络/代理，或该平台接口对客户端直连有网关限制。';
    } else if (allNonJson) {
        diag.hint =
            `${PLATFORM_NAMES[sp]} 当前未开放公开的 JSON 搜索接口（所有候选端点均返回 SPA 页面）。` +
            `请改用「粘贴 GitHub 仓库链接」方式导入该平台的技能。`;
    } else {
        diag.hint = `${PLATFORM_NAMES[sp]} 未返回可解析的技能列表，详见诊断信息。`;
    }

    diag.totalDurationMs = Date.now() - startedAll;
    lastDiagnostics.set(sp, diag);
    log(`end platform=${sp} NO MATCH in ${diag.totalDurationMs}ms; hint=${diag.hint}`);
    log('  attempts:', JSON.stringify(diag.attempts, null, 2));

    // 所有候选端点均返回 SPA 页面（非 JSON）：平台未提供公开列表接口，
    // 标记 unsupported 让前端区分「平台不支持」与「真实加载故障」。
    const unsupported = allNonJson;

    return {items: [], pageInfo: emptyPageInfo(safePage, safeSize), unsupported};
}

/**
 * 直连方式将某平台 skill 解析为可安装 Skill（复用 GitHub 通道 / 直链）。
 */
export async function resolveDirectSkill(
    skillsManager: SkillsManager,
    platform: PlatformType,
    sourceUrl: string
): Promise<ResolvePlatformResult> {
    // GitHub 仓库源 → 复用现有通道
    if (sourceUrl.includes('github.com')) {
        const gh = await skillsManager.parseImportUrl(sourceUrl);
        return {...gh, platform: platform as SupportedPlatform, resolvedVia: gh.success ? 'github' : 'unknown'};
    }
    // skills.sh 详情页（ClawHub 榜单里 install.kind='skills-sh' 的条目）→ 定位其 GitHub 源
    if (SKILLS_SH_URL_RE.test(sourceUrl)) {
        return resolveSkillsShSkill(skillsManager, sourceUrl, platform as SupportedPlatform);
    }
    // 各平台 zip 下载直链 → 下载解压后取 SKILL.md：
    //  - ModelScope：/skills/<owner>/<slug>/archive/zip/master
    //  - ClawHub / SkillHub：/api/v1/download?slug=<slug>
    if (isZipDownloadUrl(sourceUrl)) {
        return resolveZipSkill(skillsManager, sourceUrl, platform as SupportedPlatform);
    }
    // 平台直链（SKILL.md / zip）→ 复用详情页解析
    return resolvePlatformSkillUrl(skillsManager, sourceUrl);
}
