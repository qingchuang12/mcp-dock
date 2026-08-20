/**
 * 平台适配器统一类型层。
 *
 * 这一层把「软件商店」里各平台的搜索/解析逻辑抽象成一致的 PlatformAdapter 接口，
 * 取代 platform-skill-resolver.ts 中按 SupportedPlatform 硬编码 if/switch 分支的旧做法。
 * 新增平台只需实现 PlatformAdapter 并在 registry 注册，resolver 的 facade 无需改动。
 */
import type {PlatformType} from '../../shared/platform-constants';
import type {DiscoveredSkill, ImportParseResult, SkillsManager} from '../skills-manager';

/** 受支持的平台标识（含 unknown 兜底；bailian 为离线索引优先的新平台）。 */
export type SupportedPlatform =
    | 'modelscope'
    | 'safeskill'
    | 'skillhub'
    | 'skillsmp'
    | 'clawhub'
    | 'bailian'
    | 'unknown';

/** 归一化后的 skill 列表项（渲染层直接使用）。 */
export interface PlatformSkillListItem {
    id: string;
    name: string;
    description: string;
    descriptions?: Record<string, string>;
    source: SupportedPlatform;
    sourceUrl: string;
    downloadUrl?: string;
    stars?: number;
    updatedAt?: string;
    category?: string;
    extra?: Record<string, unknown>;
}

/** 归一化后的 MCP server 列表项。 */
export interface PlatformServerListItem {
    id: string;
    name: string;
    displayName: string;
    description: string;
    iconUrl?: string;
    categories?: string[];
    stars?: number;
    sourceUrl?: string;
    author?: string;
    publisher?: string;
    isHosted?: boolean;
    isVerified?: boolean;
    tags?: string[];
    source: SupportedPlatform;
    extra?: Record<string, unknown>;
}
export interface PlatformPageInfo {
    page: number;
    pageSize: number;
    total: number | null;
    totalPages: number | null;
    hasMore: boolean;
}

/** 分页搜索结果。 */
export interface PlatformSearchPage {
    items: PlatformSkillListItem[];
    pageInfo: PlatformPageInfo;
    /** 上游真实总量（服务端真分页时透传，供前端顶部「共 N 个」展示）。 */
    serverTotal?: number;
    /** 分页模式：server=服务端真分页，client=本地切片分页。 */
    pagingMode?: 'server' | 'client';
    /** 本地切片分页是否已完成全量加载。 */
    complete?: boolean;
    /** 哨兵串（如 __QUOTA_LIMIT_EXCEED__）或上游业务错误提示。 */
    message?: string;
    /** 所有候选端点均返回 SPA 页面（非 JSON）：平台未提供公开列表接口。 */
    unsupported?: boolean;
}

/** MCP server 搜索结果。 */
export interface PlatformServerSearchPage {
    items: PlatformServerListItem[];
    pageInfo: PlatformPageInfo;
    message?: string;
}

/** MCP server 详情（含安装配置 / README）。 */
export interface PlatformServerDetail {
    id: string;
    name: string;
    displayName: string;
    description: string;
    iconUrl?: string;
    categories?: string[];
    stars?: number;
    sourceUrl?: string;
    author?: string;
    publisher?: string;
    isHosted?: boolean;
    isVerified?: boolean;
    tags?: string[];
    readme?: string;
    install: {command: string; args: string[]; env?: Record<string, unknown>} | null;
    envSchema?: unknown;
    source: SupportedPlatform;
    extra?: Record<string, unknown>;
}

/** 单条端点探测诊断记录。 */
export interface DirectSearchAttempt {
    url: string;
    ok: boolean;
    status?: number;
    contentType?: string;
    bytes?: number;
    itemCount?: number;
    durationMs: number;
    reason?: string;
    errorCode?: string;
    message?: string;
}

/** 完整搜索诊断（按平台缓存，供 IPC 查询回传「为什么没有结果」）。 */
export interface DirectSearchDiagnostics {
    platform: SupportedPlatform;
    baseUrl: string;
    query: string;
    page: number;
    category?: string;
    authorized: boolean;
    attempts: DirectSearchAttempt[];
    matchedUrl: string | null;
    totalDurationMs: number;
    hint?: string;
}

/** skill 解析结果。 */
export interface ResolvePlatformResult extends ImportParseResult {
    platform: SupportedPlatform;
    resolvedVia?: 'github' | 'direct-skill-md' | 'zip' | 'list' | 'unknown';
}

/** 平台搜索/解析统一参数。 */
export interface PlatformSearchParams {
    query: string;
    page: number;
    pageSize: number;
    category?: string;
    /** 排序选项 id（见 PlatformFacets.sortOptions）。 */
    sort?: string;
    /** 来源过滤（如百炼的 source slug）。 */
    source?: string;
    /** 平台可访问的 baseUrl（用户配置或默认）。 */
    baseUrl: string;
    /** 可选 Bearer 令牌。 */
    secret?: string | null;
}

/**
 * 统一分类节点（一级 + 子类两栏）。所有数据源（内置源 + 平台源）都映射到此结构，
 * 前端 FilterBar 只认 CategoryNode 树，平台差异在 adapter 内消化。
 */
export interface CategoryNode {
    id: string;
    name: string;
    /** 子类节点（可选）。 */
    children?: CategoryNode[];
    /** 该分类下的条目计数（可选，平台提供时展示）。 */
    count?: number;
}

/** 排序选项。 */
export interface SortOption {
    id: string;
    name: string;
    /** 排序字段（adapter 内部解释）。 */
    field: string;
    order: 'asc' | 'desc';
}

/** 来源过滤项（如百炼的 source 维度）。 */
export interface SourceFilter {
    id: string;
    name: string;
    count?: number;
}

/** 平台可提供的分类/排序/来源/标签等面元数据。 */
export interface PlatformFacets {
    /** 一级分类 + 子类。 */
    categories: CategoryNode[];
    /** 排序选项。 */
    sortOptions: SortOption[];
    /** 来源过滤（可选）。 */
    sourceFilter?: SourceFilter[];
    /** 热门标签（可选，标签云）。 */
    tags?: string[];
    /** 是否支持子类（决定 UI 用两栏还是单栏）。 */
    supportsSubcategories?: boolean;
}

/**
 * 平台适配器接口：所有平台能力通过实现本接口接入商店。
 *
 * 设计要点：
 * - searchSkills / searchServers 由 resolver 的 facade 统一调用，内部按平台特化实现；
 * - 离线优先平台（如 bailian）可依赖内置索引，无需网络/令牌；
 * - 解析通道（resolveSkill / resolveServerDetail）按平台能力可选实现，缺省抛错提示。
 */
export interface PlatformAdapter {
    /** 平台标识。 */
    readonly id: Exclude<SupportedPlatform, 'unknown'>;
    /** 展示名。 */
    readonly name: string;

    /**
     * 分页搜索 skill 列表（纯 MCP server 平台如百炼可省略，改用 searchServers）。
     * @param sm 仅在需要复用 GitHub/zip 通道时传入（多数平台仅做网络请求，可忽略）。
     */
    searchSkills?(params: PlatformSearchParams, sm?: SkillsManager): Promise<PlatformSearchPage>;

    /** 分页搜索 MCP server 列表（不支持的平台返回空结果）。 */
    searchServers?(params: PlatformSearchParams): Promise<PlatformServerSearchPage>;

    /** 获取单个 MCP server 详情（不支持的平台抛错）。 */
    fetchServerDetail?(params: PlatformSearchParams, serverId: string): Promise<PlatformServerDetail>;

    /** 把某平台 skill 的 sourceUrl 解析为可安装 Skill。 */
    resolveSkill?(sm: SkillsManager, sourceUrl: string): Promise<ResolvePlatformResult>;

    /**
     * 返回该平台的分类/排序/来源/标签等面元数据（Frontend FilterBar 消费）。
     * 纯离线平台（百炼）可同步返回；需在线探测的平台可返回静态分类枚举。
     */
    getFacets?(): PlatformFacets | Promise<PlatformFacets>;
}

/**
 * 把连接配置层的 PlatformType 映射到平台搜索层的 SupportedPlatform。
 * 仅保留「平台直连类」映射；official/smithery/github/custom 等非直连类型返回 null
 * （这些由内置抓取通道处理，不走平台适配器）。
 */
export function platformTypeToSupported(pt: string): SupportedPlatform | null {
    switch (pt) {
        case 'modelscope':
            return 'modelscope';
        case 'safeskill':
            return 'safeskill';
        case 'skillhub':
            return 'skillhub';
        case 'skillsmp':
            return 'skillsmp';
        case 'clawhub':
            return 'clawhub';
        // 百炼作为新平台，连接类型为 'bailian'（连接配置层扩展）
        case 'bailian':
            return 'bailian';
        default:
            return null;
    }
}

export type {PlatformType, SkillsManager, DiscoveredSkill, ImportParseResult};
