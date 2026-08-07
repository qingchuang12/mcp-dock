/**
 * 平台与令牌的共享静态常量。
 *
 * 该文件不依赖任何 Node / Electron 运行时模块（无 fs/path/crypto/electron 导入），
 * 因此可以安全地被渲染进程（浏览器环境）与主进程同时导入，避免渲染端因引入
 * 主进程模块而连带加载 Node 内置模块导致 chunk 崩溃。
 */

export type TokenScope =
  | 'skills:read'
  | 'skills:download'
  | 'models:read'
  | 'models:download'
  | 'admin';

export const ALL_TOKEN_SCOPES: TokenScope[] = [
  'skills:read',
  'skills:download',
  'models:read',
  'models:download',
  'admin',
];

export type PlatformType =
  | 'modelscope'
  | 'safeskill'
  | 'skillhub'
  | 'skillsmp'
  | 'custom'
  // MCP 源平台类型：内置抓取实现，非通用 baseUrl 探测
  | 'official'
  | 'smithery'
  // Skill 源内置来源（GitHub Registry），由 fetchSkillsList 直连，不通过平台搜索 API
  | 'github'
  // ClawHub：公开 API 直连，无凭证即可查询 skill 趋势榜单
  | 'clawhub';

export const PLATFORM_META: Record<PlatformType, { label: string; defaultBaseUrl: string }> = {
  modelscope: { label: 'ModelScope', defaultBaseUrl: 'https://www.modelscope.cn' },
  safeskill: { label: 'SafeSkill', defaultBaseUrl: 'https://safeskill.cn' },
  skillhub: { label: 'SkillHub', defaultBaseUrl: 'https://skillhub.cn' },
  skillsmp: { label: 'SkillsMP', defaultBaseUrl: 'https://skillsmp.com' },
  custom: { label: '自定义', defaultBaseUrl: '' },
  official: { label: 'Official Registry', defaultBaseUrl: 'https://api.github.com' },
  smithery: { label: 'Smithery', defaultBaseUrl: 'https://registry.smithery.ai' },
  github: { label: 'GitHub Registry', defaultBaseUrl: 'https://api.github.com' },
  clawhub: { label: 'ClawHub', defaultBaseUrl: 'https://clawhub.ai' },
};

/** 连接归属的资源类型：mcp 源 / skill 源 */
export type ConnectionKind = 'mcp' | 'skill';

/** MCP 源可选的平台类型（内置两种 + 平台直连 + 自定义） */
export const MCP_PLATFORM_TYPES: PlatformType[] = ['official', 'smithery', 'modelscope', 'custom'];

/** Skill 源可选的平台类型 */
export const SKILL_PLATFORM_TYPES: PlatformType[] = [
  'modelscope',
  'safeskill',
  'skillhub',
  'skillsmp',
  'clawhub',
  'custom',
];

/** 内置 MCP 源的固定 id，用于 seed 与内置抓取逻辑分发 */
export const BUILTIN_MCP_SOURCE_IDS = {
  official: 'mcpsrc_official',
  smithery: 'mcpsrc_smithery',
} as const;

/** 内置 Skill 源的固定 id（GitHub Registry），用于 seed 与商店下拉内置抓取分发 */
export const BUILTIN_SKILL_SOURCE_IDS = {
  github: 'src_github',
  clawhub: 'src_clawhub',
} as const;

/**
 * ClawHub 公开趋势榜单接口（无凭证即可查询 skill 列表）。
 * 该源为只读的「skills 趋势」列表，不支持关键词搜索，故前端走本地分页/分类。
 *
 * 该接口用 `cursor` 做游标翻页（响应里的 `nextCursor` 传回即为下一页），
 * `limit` 实测上限为 100（>100 返回 400），总量由响应的 `totalItems` 给出。
 * 因此主进程会按游标连续拉取，而不是只取首屏 20 条。
 */
export const CLAWHUB_TRENDING_URL = 'https://clawhub.ai/api/v1/trending?kind=skills&limit=100';

/** ClawHub 趋势榜单基址（不含分页参数），供游标翻页拼装使用 */
export const CLAWHUB_TRENDING_BASE = 'https://clawhub.ai/api/v1/trending?kind=skills';

/** ClawHub 单次请求条数上限（实测 >100 返回 400） */
export const CLAWHUB_PAGE_LIMIT = 100;

/** ClawHub 全量拉取的条数上限，避免上游数千条时首屏等待过久 */
export const CLAWHUB_MAX_ITEMS = 600;

/**
 * ClawHub 原生技能的 zip 下载直链（`?slug=<slug>`，无凭证，实测返回 application/zip）。
 *
 * 榜单里 `install.kind === 'clawhub'` 的条目（实测约占 60%）只有
 * `install.reference = "<owner>/<slug>"`，既不是 GitHub 仓库也没有 `sourceUrl`；
 * 若按 owner/repo 拼成 github.com 链接会 404（如 plato-1/fable-method 无此仓库）。
 * 这些技能必须走本直链下载 zip（包内含 SKILL.md）。
 */
export const CLAWHUB_DOWNLOAD_BASE = 'https://clawhub.ai/api/v1/download';

/**
 * 各平台「测试连接」使用的探活路径（相对 baseUrl，按顺序尝试，任一成功即视为连通）。
 *
 * 为什么不直接请求 baseUrl：部分站点首页对非浏览器请求不响应（实测
 * `https://skillsmp.com` 直接超时 12s），但其 API 端点 398ms 正常返回 200。
 * 若拿首页当探活目标，会把可用连接误判为「连接失败」。
 *
 * 因此优先探测与实际功能一致的 API 端点；平台无公开 API 时再回退首页。
 */
export const PLATFORM_HEALTH_PATHS: Record<PlatformType, string[]> = {
  // 实测可用：返回 {success,data:{skills,...}}
  modelscope: ['/openapi/v1/skills?page_number=1&page_size=1', '/'],
  // 实测可用：返回 {skills,pagination,filters}
  skillsmp: ['/api/skills?search=&page=1', '/'],
  // 无公开 JSON API，只能探首页连通性
  safeskill: ['/'],
  skillhub: ['/'],
  // 自定义连接由用户填写完整 baseUrl，直接探该地址
  custom: ['/'],
  // MCP 内置源：探测各自真实的 registry 端点
  official: ['/repos/modelcontextprotocol/servers/contents/src', '/'],
  smithery: ['/servers?page=1&pageSize=1', '/'],
  // Skill 内置来源：GitHub Registry 探活指向官方 servers 仓库内容端点
  github: ['/repos/modelcontextprotocol/servers/contents/src', '/'],
  // ClawHub：公开趋势榜单接口，无凭证即可 200
  clawhub: ['/api/v1/trending?kind=skills&limit=1', '/'],
};

/**
 * SkillsMP 网站（https://skillsmp.com/zh/search?category=slug）的真实分类 slug。
 * 以公开站点可见分类为准，可随站点扩展。分类点击时作为 `category` 参数透传到
 * 搜索端点，由服务端过滤，而非前端按名字推断。
 */
export const SKILLSMP_CATEGORIES: string[] = [
  'architecture-patterns',
  'coding',
  'testing',
  'devops',
  'data-analytics',
  'security',
  'content-writing',
  'design',
  'productivity',
  'agents',
  'mcp-integration',
  'rag',
];
