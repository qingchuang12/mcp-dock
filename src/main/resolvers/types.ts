/**
 * 平台 Skill 解析器 —— 公共类型 / 常量定义。
 *
 * 共享类型（SupportedPlatform、PlatformSkillListItem 等）统一收敛到
 * platforms/types.ts 作为单一来源，本文件仅做 re-export。
 * resolvers 专属类型（PlatformServerEndpoint）与常量（PLATFORM_NAMES 等）保留于此。
 */

// ---- 共享类型（re-export from platforms/types.ts） ----
export type {
    SupportedPlatform,
    PlatformSkillListItem,
    PlatformPageInfo,
    PlatformSearchPage,
    PlatformServerListItem,
    PlatformServerSearchPage,
    PlatformServerDetail,
    DirectSearchAttempt,
    DirectSearchDiagnostics,
    ResolvePlatformResult,
} from '../platforms/types';

// ---- resolvers 专属常量 ----
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export const DIRECT_SEARCH_PAGE_SIZE = 20;

/**
 * ModelScope MCP 广场配额硬上限：page_number × page_size 不得超过 100
 * （见 source.md 错误码 QuotaLimitExceed）。
 */
export const MODELSCOPE_QUOTA_PRODUCT = 100;

export const DIRECT_UA = UA;

export const PLATFORM_NAMES: Record<string, string> = {
    modelscope: 'ModelScope',
    safeskill: 'SafeSkill',
    skillhub: 'SkillHub',
    skillsmp: 'SkillsMP',
    clawhub: 'ClawHub',
    bailian: '百炼',
    unknown: 'Unknown',
};

export {UA};

// ---- resolvers 专属类型 ----

/**
 * 各平台 MCP server 搜索端点定义。
 */
export interface PlatformServerEndpoint {
    method: 'GET' | 'PUT';
    path: string;
    buildBody?: (q: string, page: number, size: number, category: string) => Record<string, unknown>;
    buildQuery?: (q: string, page: number, size: number, category: string) => Record<string, string>;
}
