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
    | 'npm'
    | 'coze'
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
    /** 分类友好展示名（slug → 中文名映射，适配器内填充；用于卡片展示，避免直接显示英文 slug）。 */
    categoryName?: string;
    /** 浏览量（ModelScope 列表字段 view_count）。 */
    viewCount?: number;
    /** 下载量（ModelScope 列表字段 downloads）。 */
    downloads?: number;
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
    /** 分类友好展示名（与 categories 一一对应，slug → 中文名映射；适配器内填充，用于卡片展示）。 */
    categoryNames?: string[];
    stars?: number;
    sourceUrl?: string;
    author?: string;
    publisher?: string;
    isHosted?: boolean;
    isVerified?: boolean;
    tags?: string[];
    /** 浏览量（ModelScope 列表字段 view_count）。 */
    viewCount?: number;
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

/** 本地命令型安装配置（npx / uvx / docker 等，ModelScope / npm 源）。 */
export interface LocalInstall {
    command: string;
    args?: string[];
    env?: Record<string, unknown>;
    cwd?: string;
}

/**
 * 远程托管型安装配置（如百炼）：向客户端 MCP 配置写入 URL 接入点而非本地命令，
 * 客户端直连远程服务（SSE / Streamable HTTP），无需本地运行时。
 */
export interface RemoteInstall {
    url: string;
    type: 'sse' | 'http' | 'streamable-http';
    /**
     * 鉴权头模板：值为 `${KEY}` 占位符，安装时由用户在环境变量表单输入的值填充
     * （如百炼 `{'Authorization': 'Bearer ${DASHSCOPE_API_KEY}'}`）。各远程源自行声明，
     * 详情页不再硬编码具体键名。占位符未填/填空时对应键值对被剔除。
     */
    headersTemplate?: Record<string, string>;
}

/** MCP server 详情（含安装配置 / README）。 */
export interface PlatformServerDetail {
    id: string;
    name: string;
    displayName: string;
    description: string;
    iconUrl?: string;
    categories?: string[];
    /** 分类友好展示名（与 categories 一一对应，slug → 中文名映射；适配器内填充，用于卡片展示）。 */
    categoryNames?: string[];
    stars?: number;
    sourceUrl?: string;
    author?: string;
    publisher?: string;
    isHosted?: boolean;
    isVerified?: boolean;
    tags?: string[];
    readme?: string;
    /** 安装配置：本地命令型（LocalInstall）或远程托管型（RemoteInstall），null 表示无可用配置。 */
    install: LocalInstall | RemoteInstall | null;
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
    /** 可选的运行时缓存目录：adapter 用它累积在线结果作为离线索引（避免写死静态索引）。 */
    cacheDir?: string;
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

/**
 * 平台侧 Skill 下载请求参数。
 * secret 为连接绑定的令牌（如虾评的 API Key），由调用方从 secretStore 取出后注入，
 * 适配器本身不接触凭证存储。
 */
export interface PlatformSkillDownloadParams {
    /** 平台可访问的 baseUrl（用户配置或默认）。 */
    baseUrl: string;
    /** skill 在该平台的 id。 */
    skillId: string;
    /** 可选 Bearer 令牌；未绑定时为 null。 */
    secret?: string | null;
}

/** 平台侧 Skill 下载结果。downloadUrl 指向可直接下载的 zip 包。 */
export interface PlatformSkillDownload {
    downloadUrl: string;
    /** 平台返回的版本号（可选）。 */
    version?: string;
    /**
     * 本次下载在平台侧消耗的积分数（可选）。部分平台下载付费技能会扣费，
     * 需在 UI 明确提示，且失败时不应自动重试。
     */
    coinsSpent?: number;
}

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
     * 取该平台某个 Skill 的 zip 下载直链（需鉴权的平台如虾评走此通道）。
     * 是否实现本方法 = 该平台「能否在 mcp-dock 内安装 Skill」的唯一事实源，
     * 渲染层据此决定安装按钮可用性（见 PLATFORM_SKILL_DOWNLOAD）。
     * 未实现的平台视为不可安装，UI 应禁用安装并给出原因，而不是让安装静默产出空壳目录。
     */
    fetchSkillDownload?(params: PlatformSkillDownloadParams): Promise<PlatformSkillDownload>;

    /**
     * 返回该平台的分类/排序/来源/标签等面元数据（Frontend FilterBar 消费）。
     * 纯离线平台（百炼）可同步返回；需在线探测的平台可返回静态分类枚举。
     * @param resourceType 当前浏览的资源类型（'mcp' = MCP server 分类，'skills' = Skill 分类）。
     *        像 ModelScope 这类两接口分类体系不同的平台，需据此返回不同分类枚举。
     */
    getFacets?(resourceType?: 'mcp' | 'skills'): PlatformFacets | Promise<PlatformFacets>;
}

/**
 * 把连接配置层的 PlatformType 映射到平台搜索层的 SupportedPlatform。
 * 仅保留「平台直连类」映射；smithery/github/custom 等非直连类型返回 null
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
        // npm Registry：匿名公开，无 baseUrl 限制，走统一平台适配器通道
        case 'npm':
            return 'npm';
        // 虾评（Coze）Skill 平台源
        case 'coze':
            return 'coze';
        default:
            return null;
    }
}

export type {PlatformType, SkillsManager, DiscoveredSkill, ImportParseResult};
