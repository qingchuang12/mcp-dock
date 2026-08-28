/**
 * 平台 Skill 链接解析器（薄 facade）。
 *
 * 本文件仅负责把先前集中在单一文件中的公共 API 重新导出，
 * 具体实现已拆分到 src/main/resolvers/* 各叶模块中。
 * 对外（如 index.ts）仍通过 `./platform-skill-resolver` 引入，
 * 导出的名称集合与原实现完全一致，因此任何外部 import 均无需改动。
 */

// ---- 类型 / 常量 ----
export type {
    SupportedPlatform,
    ResolvePlatformResult,
    PlatformSkillListItem,
    PlatformPageInfo,
    PlatformSearchPage,
    PlatformServerListItem,
    PlatformServerSearchPage,
    PlatformServerDetail,
    DirectSearchAttempt,
    DirectSearchDiagnostics,
} from './resolvers/types';
export {
    PLATFORM_NAMES,
    DIRECT_SEARCH_PAGE_SIZE,
    MODELSCOPE_QUOTA_PRODUCT,
} from './resolvers/types';

// ---- URL 检测 / HTML 提取 + resolvePlatformSkillUrl ----
export {detectPlatform, resolvePlatformSkillUrl} from './resolvers/url-detect';

// ---- 平台 MCP Server 搜索 / 详情 ----
export {searchPlatformServersPaged, fetchPlatformServerDetail} from './resolvers/servers';

// ---- 统一分发（直连搜索 + 源归一化）----
export {
    getLastDirectSearchDiagnostics,
    searchPlatformDirect,
    searchPlatformDirectPaged,
    resolveDirectSkill,
} from './resolvers/dispatch';
