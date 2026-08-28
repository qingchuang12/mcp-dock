/**
 * 平台 Skill 解析器 —— 平台 MCP Server 搜索 / 详情（复用同一套连接 / 令牌机制）。
 * 当前仅 ModelScope 有稳定公开契约；其它平台返回空结果 + 提示。详见原文件注释。
 */

import type {PlatformType} from '../../shared/platform-constants';
import type {
    PlatformServerDetail,
    PlatformServerEndpoint,
    PlatformServerListItem,
    PlatformServerSearchPage,
    SupportedPlatform,
} from './types';
import {DIRECT_SEARCH_PAGE_SIZE, DIRECT_UA, MODELSCOPE_QUOTA_PRODUCT} from './types';
import {buildUrl, emptyPageInfo, extractPageInfo} from './pagination';

/**
 * 各平台 MCP server 搜索端点定义。
 *  - method：GET（查询串）或 PUT（JSON body）；
 *  - body/getParams：按 (query, page, size, category) 构造请求体 / 查询参数。
 * 当前仅 ModelScope 有稳定公开契约；其它平台保持空（返回空结果 + 提示）。
 */
const PLATFORM_SERVER_SEARCH: Partial<Record<Exclude<SupportedPlatform, 'unknown'>, PlatformServerEndpoint>> = {
    // ModelScope MCP 广场（最新契约，见 source.md：「ModelScope MCP 广场 API」一节）：
    //   PUT {baseUrl}/openapi/v1/mcp/servers
    // 请求体分页字段为 snake_case：page_size + page_number + search + filter{category,tag,is_hosted}。
    // 响应结构：data.mcp_server_list[] + data.total_count。
    // 注意：该接口文档标记 Authorization 为必填（Bearer）；但实测公开环境未携带令牌
    // 也可能放行，因此仅在连接配置了令牌时才附带 Authorization，缺失时交由上游决定。
    modelscope: {
        method: 'PUT',
        path: '/openapi/v1/mcp/servers',
        buildBody: (q, page, size, category) => {
            return {
                page_size: size,
                page_number: page,
                search: q,
                filter: category ? {category} : {},
            };
        },
    },
};

/** 将平台返回的原始 MCP server 条目归一化为 PlatformServerListItem */
function toServerListItem(raw: Record<string, unknown>, platform: SupportedPlatform): PlatformServerListItem {
    const id = String(raw.id || raw.Id || raw.qualifiedName || raw.name || 'server');
    const display = String(raw.chinese_name || raw.ChineseName || raw.displayName || raw.name || id);
    const desc = String(raw.description || raw.Abstract || raw.AbstractCN || raw.desc || raw.summary || raw.detail || '');
    const repo = raw.repo || raw.repository || raw.repo_path;

    const categories = Array.isArray(raw.categories)
        ? (raw.categories as unknown[]).map(String)
        : Array.isArray(raw.Category)
        ? (raw.Category as unknown[]).map(String)
        : typeof raw.category === 'string' && raw.category
        ? [raw.category]
        : [];

    const sourceUrl = raw.source_url
        ? String(raw.source_url)
        : raw.FromSiteUrl
        ? String(raw.FromSiteUrl)
        : raw.github_url
        ? String(raw.github_url)
        : raw.url
        ? String(raw.url)
        : repo
        ? `https://github.com/${String(repo)}`
        : undefined;

    const stars =
        typeof raw.Stars === 'number'
        ? raw.Stars
        : typeof raw.ViewCount === 'number'
        ? raw.ViewCount
        : typeof raw.CallVolume === 'number'
        ? raw.CallVolume
        : typeof raw.view_count === 'number'
        ? raw.view_count
        : typeof raw.stars === 'number'
        ? raw.stars
        : typeof raw.downloads === 'number'
        ? raw.downloads
        : undefined;

    const iconUrl =
        typeof raw.logo_url === 'string' && raw.logo_url
        ? raw.logo_url
        : typeof raw.icon_url === 'string' && raw.icon_url
        ? raw.icon_url
        : undefined;

    return {
        id,
        name: String(raw.name || raw.Name || id),
        displayName: display,
        description: desc,
        categories,
        stars,
        iconUrl,
        sourceUrl,
        source: platform,
        extra: raw,
    };
}

/**
 * 用 API 直连（带 Bearer 令牌，可选）分页搜索某平台的 MCP server 列表。
 * 与 {@link searchPlatformDirectPaged} 共用 extractPageInfo / buildUrl，
 * 但支持 PUT + JSON body（ModelScope 契约）。
 */
export async function searchPlatformServersPaged(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    query: string,
    page = 1,
    pageSize = DIRECT_SEARCH_PAGE_SIZE,
    category = ''
): Promise<PlatformServerSearchPage> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DIRECT_SEARCH_PAGE_SIZE;

    const sp = platform as Exclude<SupportedPlatform, 'unknown'>;
    const def = PLATFORM_SERVER_SEARCH[sp];
    const log = (..._args: unknown[]) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[resolver]', ..._args);
    };

    if (!def) {
        log(`platform=${sp} 暂未实现 MCP server 搜索（无公开契约），返回空结果`);
        return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
    }

    // ModelScope 配额硬限制：page_number × page_size ≤ 100（见 source.md 错误码 QuotaLimitExceed）。
    // 按规则直接预判，越界时无需发起请求即可返回友好提示，避免浪费一次必然失败的调用。
    if (sp === 'modelscope' && safePage * safeSize > MODELSCOPE_QUOTA_PRODUCT) {
        const maxPages = Math.max(1, Math.floor(MODELSCOPE_QUOTA_PRODUCT / safeSize));
        log(`platform=modelscope 命中配额上限（page=${safePage} × size=${safeSize} > ${MODELSCOPE_QUOTA_PRODUCT}），直接返回提示`);
        return {
            items: [],
            pageInfo: {page: safePage, pageSize: safeSize, total: MODELSCOPE_QUOTA_PRODUCT, totalPages: maxPages, hasMore: false},
            message: '__QUOTA_LIMIT_EXCEED__',
        };
    }

    const headers: Record<string, string> = {
        'User-Agent': DIRECT_UA,
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (sp === 'modelscope') {
        // 建议携带语言偏好头（可选），用于返回中文描述
        headers['x-modelscope-accept-language'] = 'zh_CN';
    }
    // ModelScope 公开 skills 接口（/openapi/v1/skills）无需令牌即可访问；
    // MCP 广场接口文档标记 Authorization 为必填，故仅在有令牌时附带 Bearer，
    // 缺失令牌时交由上游决定是否放行（缺失即返回空结果，非代码缺陷）。
    if (secret) headers['Authorization'] = `Bearer ${secret}`;
    if (def.method === 'PUT') headers['Content-Type'] = 'application/json';

    const url = buildUrl(baseUrl, def.path);
    const controller = new AbortController();
    const timeoutMs = sp === 'modelscope' ? 20000 : 15000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const init: RequestInit = {
            method: def.method,
            headers,
            redirect: 'follow',
            signal: controller.signal,
        };
        let requestUrl = url;
        if (def.method === 'PUT' && def.buildBody) {
            init.body = JSON.stringify(def.buildBody(query, safePage, safeSize, category));
        } else if (def.method === 'GET' && def.buildQuery) {
            const qp = def.buildQuery(query, safePage, safeSize, category);
            const qs = Object.entries(qp).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
            requestUrl = buildUrl(baseUrl, `${def.path}?${qs}`);
        }

        log(`begin platform=${sp} ${def.method} ${requestUrl} q="${query}" page=${safePage} size=${safeSize} cat=${category} auth=${!!secret}`);
        const started = Date.now();
        const res = await fetch(requestUrl, init);
        const text = await res.text();
        const durationMs = Date.now() - started;

        if (!res.ok) {
            log(`  ✗ ${url} -> HTTP ${res.status} (${durationMs}ms)`);
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }
        if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
            log(`  ✗ ${url} -> 非 JSON 响应（${text.length} 字节）`);
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }

        let json: any;
        try {
            json = JSON.parse(text);
        } catch (e) {
            log(`  ✗ ${url} -> JSON 解析失败：${(e as Error).message}`);
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
        }

        // ModelScope 等平台在触发配额/频率限制时会返回 success:false 的业务错误体
        // （如 code="QuotaLimitExceed"），此时 data 为空。需给出友好提示，让用户
        // 通过输入关键字缩小范围，而不是静默展示空列表。
        // 配额类错误用哨兵串让渲染层做国际化；其它业务错误直接透传上游 message。
        if (json && json.success === false) {
            const code = String(json.code ?? '');
            const rawMsg = typeof json.message === 'string' ? json.message : '';
            let hint: string;
            if (code === 'QuotaLimitExceed' || /quota|limit exceeded|超出|超过.*限制/i.test(rawMsg)) {
                hint = '__QUOTA_LIMIT_EXCEED__';
            } else {
                hint = rawMsg || '查询被上游拒绝，请稍后重试。';
            }
            log(`  ✗ ${url} -> 业务错误 code=${code} msg=${rawMsg}`);
            return {items: [], pageInfo: emptyPageInfo(safePage, safeSize), message: hint};
        }

        // 定位 mcp_server_list / servers 数组
        // ModelScope MCP 广场（source.md）：data.mcp_server_list
        const arr: unknown[] =
            json?.data?.mcp_server_list ||
            json?.mcp_server_list ||
            json?.data?.servers ||
            json?.servers ||
            json?.data?.list ||
            json?.list ||
            [];
        const liked = arr.filter(
            (x): x is Record<string, unknown> =>
                !!x && typeof x === 'object' && ('id' in x || 'name' in x || 'qualifiedName' in x)
        );

        const pageInfo = extractPageInfo(json, safePage, safeSize, liked.length);

        // ModelScope 配额：单次最多可检索 page_number × page_size ≤ 100 条，
        // 超出边界的页上游必拒。因此把可翻页数钳制在配额内（与 Smithery 的
        // totalPages 一样作为分页控件唯一真相），避免 UI 跳到必然失败的空白页；
        // 当 catalog 实际量大于可检索上限时，在末页提示用户用关键字缩小范围。
        if (sp === 'modelscope') {
            const maxPages = Math.max(1, Math.floor(MODELSCOPE_QUOTA_PRODUCT / safeSize));
            const maxTotal = maxPages * safeSize;
            const rawTotal = json?.data?.total_count;
            const rawTotalNum = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null;
            const cappedTotal = rawTotalNum !== null ? Math.min(rawTotalNum, maxTotal) : maxTotal;
            pageInfo.total = cappedTotal;
            pageInfo.totalPages = Math.max(1, Math.ceil(cappedTotal / safeSize));
            pageInfo.hasMore = safePage < pageInfo.totalPages;
            if (rawTotalNum !== null && rawTotalNum > maxTotal && safePage >= pageInfo.totalPages) {
                return {
                    items: liked.map(r => toServerListItem(r, sp)),
                    pageInfo,
                    message: '__QUOTA_LIMIT_EXCEED__',
                };
            }
        }

        log(`  ✓ ${url} -> ${liked.length} servers in ${durationMs}ms (total=${pageInfo.total ?? '?'}, hasMore=${pageInfo.hasMore})`);
        return {items: liked.map(r => toServerListItem(r, sp)), pageInfo};
    } catch (e) {
        const err = e as Error & { name?: string };
        log(`  ✗ ${url} -> ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        return {items: [], pageInfo: emptyPageInfo(safePage, safeSize)};
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 获取单个平台 MCP server 的详情（含安装配置 / README）。
 *
 * 当前仅 ModelScope 有稳定公开契约：
 *   GET {baseUrl}/openapi/v1/mcp/servers/{id}
 * 返回字段（实测 @modelcontextprotocol/fetch）：
 *   - server_config[].mcpServers[name] = { command, args, env? }  ← 即为安装所需配置
 *   - readme：顶层或 locales.{zh,en}.readme
 *   - source_url / categories / view_count / is_hosted / is_verified / tags 等元信息
 * 其它平台（SafeSkill / SkillHub / SkillsMP）暂无已知公开契约，直接抛错提示。
 */
export async function fetchPlatformServerDetail(
    platform: PlatformType,
    baseUrl: string,
    secret: string | null,
    serverId: string
): Promise<PlatformServerDetail> {
    const sp = platform as Exclude<SupportedPlatform, 'unknown'>;
    const log = (..._args: unknown[]) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[resolver]', ..._args);
    };

    if (sp !== 'modelscope') {
        const msg = `平台 ${sp} 暂不支持 MCP server 详情（无公开契约）`;
        log(msg);
        throw new Error(msg);
    }

    const headers: Record<string, string> = {
        'User-Agent': DIRECT_UA,
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    // ModelScope 详情接口无需令牌即可访问；有令牌才附带 Bearer
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    const url = buildUrl(baseUrl, `/openapi/v1/mcp/servers/${encodeURIComponent(serverId)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
        log(`begin platform=${sp} GET ${url} auth=${!!secret}`);
        const started = Date.now();
        const res = await fetch(url, {headers, redirect: 'follow', signal: controller.signal});
        const text = await res.text();
        const durationMs = Date.now() - started;

        if (!res.ok) {
            log(`  ✗ ${url} -> HTTP ${res.status} (${durationMs}ms)`);
            throw new Error(`获取详情失败（HTTP ${res.status}）`);
        }
        if (!text.trimStart().startsWith('{')) {
            log(`  ✗ ${url} -> 非 JSON 响应（${text.length} 字节）`);
            throw new Error('详情接口返回了非 JSON 内容');
        }

        let json: any;
        try {
            json = JSON.parse(text);
        } catch (e) {
            log(`  ✗ ${url} -> JSON 解析失败：${(e as Error).message}`);
            throw new Error('详情接口返回无法解析的 JSON');
        }

        const d = json?.data;
        if (!d || typeof d !== 'object') {
            log(`  ✗ ${url} -> 未返回 data 字段`);
            throw new Error('详情接口未返回数据');
        }

        // 安装配置：server_config[].mcpServers[name] = { command, args, env }
        let install: PlatformServerDetail['install'] = null;
        const cfgList: unknown[] = Array.isArray(d.server_config) ? d.server_config : [];
        for (const entry of cfgList) {
            const mcp = (entry as any)?.mcpServers;
            if (mcp && typeof mcp === 'object') {
                const key = Object.keys(mcp)[0];
                if (key) {
                    const c = mcp[key];
                    install = {
                        command: String(c.command || ''),
                        args: Array.isArray(c.args) ? c.args.map(String) : [],
                        env: c.env && typeof c.env === 'object' ? c.env : undefined,
                    };
                    break;
                }
            }
        }

        const readme: string =
            d.locales?.zh?.readme || d.locales?.en?.readme || d.readme || '';

        const categories = Array.isArray(d.categories)
            ? (d.categories as unknown[]).map(String)
            : typeof d.category === 'string' && d.category
                ? [d.category]
                : [];

        const stars =
            typeof d.view_count === 'number'
                ? d.view_count
                : typeof d.github_stars === 'number'
                    ? d.github_stars
                    : undefined;

        log(`  ✓ ${url} -> ok (${durationMs}ms, install=${install ? install.command : 'none'})`);
        return {
            id: String(d.id || serverId),
            name: String(d.name || serverId),
            displayName: String(d.chinese_name || d.name || d.id || serverId),
            description: String(d.description || ''),
            iconUrl: typeof d.logo_url === 'string' && d.logo_url ? d.logo_url : undefined,
            categories,
            stars,
            sourceUrl: typeof d.source_url === 'string' && d.source_url ? d.source_url : undefined,
            author: typeof d.author === 'string' && d.author ? d.author : undefined,
            publisher: typeof d.publisher === 'string' && d.publisher ? d.publisher : undefined,
            isHosted: typeof d.is_hosted === 'boolean' ? d.is_hosted : undefined,
            isVerified: typeof d.is_verified === 'boolean' ? d.is_verified : undefined,
            tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [],
            readme,
            install,
            envSchema: d.env_schema,
            source: sp,
            extra: d,
        };
    } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === 'AbortError') {
            log(`  ✗ ${url} -> 请求超时`);
            throw new Error('获取详情超时，请检查网络或连接配置');
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
