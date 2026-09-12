import {getElectronAPI} from '../lib/electron';

/**
 * Registry API - 社区版增强
 *
 * 社区版原本的 fetch 全部硬编码返回空数组（需自建后端）。
 * 本版本在不依赖自建后端的前提下，接入以下**公开、无需密钥**的数据源，
 * 让 Smithery / Skills 列表立即有真实数据：
 *   - Smithery     : 公开 registry API registry.smithery.ai/servers
 *   - Skills       : 平台直连源（api.platforms.searchSkills）统一收口
 *
 * 若用户自建了数据后端，可继续设置 VITE_REGISTRY_API_URL 覆盖默认行为。
 */

export type DataSource = 'smithery';
export type ResourceType = 'mcp' | 'skills';

// Smithery 配置 Schema（与 components/ConfigForm 的 ConfigSchema 结构对齐）
export interface McpConfigSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: string[];
}
export interface McpConfigSchema {
  type: string;
  properties: Record<string, McpConfigSchemaProperty>;
  required: string[];
}

// Base server list item - minimal fields for UI rendering
export interface ServerListItem {
  id: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  source?: string;
  repository?: { url: string; source?: string; subfolder?: string };
  categories?: string[];
  /** 分类友好展示名（与 categories 一一对应，slug → 中文名）；卡片优先展示它 */
  categoryNames?: string[];
  tags?: string[];
  lastCommitAt?: string;
  updatedAt?: string;
  version?: string;
  author?: string;
  stars?: number;
  downloads?: number;
  /** ModelScope 等平台源的浏览量（view_count），详情/列表展示用 */
  viewCount?: number | null;
  verified?: boolean;
  extra?: Record<string, unknown>;
  isHosted?: boolean;
  [key: string]: unknown;
}

// Smithery 连接信息（来自 registry.smithery.ai 的 connections[]）
export interface SmitheryConnection {
  runtime: 'node' | 'python' | string;
  configSchema?: McpConfigSchema;
  type?: string;
  deploymentUrl?: string;
  url?: string;
}

export interface SmitheryCapability {
  name: string;
  description?: string;
}

export interface SmitheryLink {
  registry?: string;
  homepage?: string;
}

// Base server detail - minimal fields for detail page
export interface ServerDetail {
  id: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  source?: 'smithery';
  qualifiedName?: string;
  connection?: SmitheryConnection;
  capabilities?: SmitheryCapability[];
  links?: SmitheryLink;
  verified?: boolean;
  createdAt?: string;
  homepage?: string;
  downloads?: number;
  stars?: number;
  forks?: number;
  lastCommitAt?: string;
  defaultBranch?: string;
  license?: string;
  author?: string;
  version?: string;
  readme?: string;
  topics?: string[];
  websiteUrl?: string;
  repository?: { url: string; source?: string; subfolder?: string };
  [key: string]: unknown;
}

// 专用详情类型（供 Detail.tsx 的渲染与安装分支按 source 收窄使用）
export interface SmitheryDetail extends ServerDetail {
  source: 'smithery';
  qualifiedName: string;
  connection?: SmitheryConnection;
  capabilities?: SmitheryCapability[];
  links?: SmitheryLink;
  verified?: boolean;
  createdAt?: string;
  homepage?: string;
}

// Skill list item
export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  /** 来源平台显式标注语言的描述变体（如 { zh: '…' }），按界面语言择优展示 */
  descriptions?: Record<string, string>;
  author: string;
  authorUrl: string;
  /** 下载直链（非 GitHub 源，如 ModelScope 的 /skills/<owner>/<slug>/archive/zip/master；为空则走 authorUrl/sourceUrl） */
  downloadUrl?: string;
  category: string;
  categoryId: string;
  stars: number;
  forks: number;
  /** ModelScope 等平台源的浏览量（view_count） */
  viewCount?: number | null;
  /** ModelScope 等平台源的下载量（downloads） */
  downloads?: number | null;
  updatedAt: string;
  repository: {
    url: string;
    branch: string;
    skillPath: string;
  };
  /** 平台直连源透传的额外元数据（图标、作者、下载量等） */
  extra?: Record<string, unknown>;
}

// Skill detail
export interface SkillDetail extends SkillListItem {
  skillMd: {
    content: string;
    lines: number;
    size: string;
    rawUrl: string;
  };
  files: Array<{
    name: string;
    path: string;
    size: string;
    rawUrl: string;
  }>;
  metadata: {
    allowedTools?: string;
    [key: string]: unknown;
  };
  stats: {
    totalFiles: number;
    totalSize: string;
    license: string;
  };
}

// Type guards
export function isSmitheryListItem(item: ServerListItem): boolean {
  return item.source === 'smithery';
}

export function isSmitheryDetail(detail: ServerDetail): detail is SmitheryDetail {
  return detail.source === 'smithery';
}

// ---------------------------------------------------------------------------
// 内存缓存（5 分钟）
// ---------------------------------------------------------------------------
const CACHE_TTL = 5 * 60 * 1000;
const cache: Record<string, { ts: number; data: unknown }> = {};

function getCached<T>(key: string): T | null {
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data as T;
  return null;
}
function setCache(key: string, data: unknown): void {
  cache[key] = { ts: Date.now(), data };
}

function clearCached(key: string): void {
  delete cache[key];
}

/**
 * Register a callback for data updates (no-op, polling handled by react-query)
 */
export function onDataUpdate(_key: string, _callback: (data: unknown) => void): () => void {
  return () => {};
}

export async function clearCache(source?: DataSource): Promise<void> {
  if (!source) {
    Object.keys(cache).forEach(k => delete cache[k]);
  } else {
    clearCached(`servers:${source}`);
  }
}

// ---------------------------------------------------------------------------
// 网络请求辅助
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 12_000;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  // 自带超时，避免慢网络无限挂起拖垮启动
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`Request failed ${res.status}: ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Smithery (公开 registry API)
// ---------------------------------------------------------------------------
const SMITHERY_API = 'https://registry.smithery.ai/servers';

/**
 * smithery 官方分类 → 官方语义搜索词（取自 smithery.ai/servers 切换分类时实际下发的 ?q= 值；
 * "All" 不带 q，所以不在表内，由前端默认空 category 表示全量）。
 * smithery 无分类字段，分类本质是该语义词的语义搜索召回子集。
 */
export const SMITHERY_CATEGORY_QUERIES: Record<string, string> = {
    'web-search': 'search the web for information',
    'browser-automation': 'automate and control web browsers',
    'academic-research': 'research papers citations and scholarly',
    finance: 'financial data stocks and trading',
    reasoning: 'thinking reasoning and problem solving',
    'dev-tools': 'software development and coding tools',
};

/** smithery 官方分类 ID 列表（不含 All） */
export const SMITHERY_CATEGORY_IDS = Object.keys(SMITHERY_CATEGORY_QUERIES);

interface SmitheryServer {
  qualifiedName: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  homepage?: string;
  useCount?: number;
  verified?: boolean;
  categories?: string[];
}

interface SmitheryResponse {
  servers: SmitheryServer[];
  pagination: { currentPage: number; pageSize: number; totalPages: number; totalCount: number };
}

async function fetchSmitheryServers(signal?: AbortSignal): Promise<ServerListItem[]> {
  // 先取第一页以拿到 totalPages，再拉全部（限制最多 50 页避免过慢）
  const first = await getJson<SmitheryResponse>(`${SMITHERY_API}?page=1`, signal);
  const pages = Math.min(first.pagination.totalPages, 50);
  const all: SmitheryServer[] = [...first.servers];
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      getJson<SmitheryResponse>(`${SMITHERY_API}?page=${i + 2}`, signal).then(r => r.servers).catch(() => [])
    )
  );
  rest.forEach(arr => all.push(...arr));

  return all.map(s => ({
    id: `smithery-${s.qualifiedName}`,
    displayName: s.displayName || s.qualifiedName,
    description: s.description || '',
    iconUrl: s.iconUrl,
    source: 'smithery',
    repository: s.homepage ? { url: s.homepage } : undefined,
    homepage: s.homepage,
    downloads: s.useCount ?? 0,
    verified: s.verified,
  } as ServerListItem));
}

/**
 * Smithery 单页查询（服务端分页），供商店按需按页拉取，避免进入即全量加载。
 * 返回当前页条目与上游真实总数（pagination.totalCount / totalPages）。
 * 关键词可选透传（q），由服务端过滤；若上游不识别则该参数被忽略，前端再做一次客户端兜底过滤。
 */
export interface SmitheryPageResult {
  items: ServerListItem[];
  total: number;
  totalPages: number;
}

export async function fetchSmitheryServersPaged(
  page: number,
  pageSize: number,
  query = '',
  category = '',
  signal?: AbortSignal,
): Promise<SmitheryPageResult> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20;
  // 分类 → 官方语义搜索词，与用户输入合并成同一 q（All/未知分类不带词 → 全量）。
  // smithery 无分类字段，分类即语义词语义搜索召回子集。
  const categoryQuery = category ? (SMITHERY_CATEGORY_QUERIES[category] ?? '') : '';
  const effectiveQuery = [query.trim(), categoryQuery].filter(Boolean).join(' ');
  const qs = [`page=${safePage}`, `pageSize=${safeSize}`];
  if (effectiveQuery) qs.push(`q=${encodeURIComponent(effectiveQuery)}`);
  const res = await getJson<SmitheryResponse>(`${SMITHERY_API}?${qs.join('&')}`, signal);
  const items = (res.servers || []).map(s => ({
    id: `smithery-${s.qualifiedName}`,
    displayName: s.displayName || s.qualifiedName,
    description: s.description || '',
    iconUrl: s.iconUrl,
    source: 'smithery',
    categories: s.categories || [],
    repository: s.homepage ? { url: s.homepage } : undefined,
    homepage: s.homepage,
    downloads: s.useCount ?? 0,
    verified: s.verified,
  } as ServerListItem));
  const total = res.pagination?.totalCount ?? items.length;
  const totalPages = res.pagination?.totalPages ?? Math.ceil(items.length / safeSize);
  return {items, total, totalPages};
}

// ---------------------------------------------------------------------------
// Skills 分类推断（被 search.ts / useSkillsData / 测试共享）
// ---------------------------------------------------------------------------
// 根据名称推断 Skill 分类，使 Store 的分类筛选真正可用
// （目录名本身不含分类信息，这里用关键词做轻量映射，兜底 productivity）
export function inferSkillCategoryId(name: string): string {
  const n = name.toLowerCase();
  const rules: [string, string[]][] = [
    ['coding', ['git', 'github', 'gitlab', 'code', 'vscode', 'ide', 'slack', 'jira', 'linear', 'notion', 'sentry']],
    ['testing', ['test', 'qa', 'playwright', 'cypress', 'fuzz']],
    ['devops', ['docker', 'k8s', 'kubernetes', 'aws', 'cloud', 'terraform', 'deploy', 'vercel', 'cloudflare', 'ci', 'pipeline', 'helm']],
    ['data-analytics', ['data', 'database', 'sql', 'postgres', 'postgre', 'mongo', 'bigquery', 'analytics', 'pandas', 'clickhouse']],
    ['security', ['security', 'auth', 'vault', 'firewall', 'waf', 'secret']],
    ['content-writing', ['content', 'blog', 'docs', 'writer', 'translate', 'speech', 'summary']],
    ['design', ['figma', 'design', 'ui', 'image', 'draw', 'paint']],
    ['productivity', ['calendar', 'todo', 'email', 'task', 'time', 'note', 'memory']],
  ];
  for (const [cat, keys] of rules) {
    if (keys.some(k => n.includes(k))) return cat;
  }
  return 'productivity';
}

// ---------------------------------------------------------------------------
// 公开 API（可被自建后端 VITE_REGISTRY_API_URL 覆盖）
// ---------------------------------------------------------------------------
export async function fetchServerList(
  source: DataSource,
  signal?: AbortSignal,
  noCache = false,
): Promise<ServerListItem[]> {
  const custom = import.meta.env.VITE_REGISTRY_API_URL as string | undefined;
  if (custom) {
    // 自建后端模式：直接代理
    return getJson<ServerListItem[]>(`${custom}/servers?source=${source}`, signal);
  }

  const diskKey = 'smithery-index';
  const api = getElectronAPI();

  // SWR：优先返回落盘缓存，首屏秒开；后台静默刷新（noCache 时跳过缓存，直走网络）。
  if (!noCache) {
    const cachedEntry = api ? await api.cache.get<ServerListItem[]>(diskKey) : null;
    if (cachedEntry?.data) {
      const cached = cachedEntry.data;
      // 后台 revalidate（不阻塞首屏）
      revalidateServerList(source, diskKey, signal).catch(() => {});
      return cached;
    }
  }

  // 无缓存（或 noCache 强制走网络）：走网络（已带 12s 超时）
  return revalidateServerList(source, diskKey, signal, noCache);
}

async function revalidateServerList(
  source: DataSource,
  diskKey: string,
  signal?: AbortSignal,
  noCache = false,
): Promise<ServerListItem[]> {
  try {
    const data = await fetchSmitheryServers(signal);
    const api = getElectronAPI();
    // noCache 模式下不回写磁盘/内存缓存，保证商店数据始终最新
    if (api && !noCache) await api.cache.set(diskKey, data);
    if (!noCache) setCache(`servers:${source}`, data);
    return data;
  } catch (err) {
    // 网络失败时降级到内存缓存，否则继续抛出（让 React Query 走 error 态）。
    // noCache 模式下不回退任何缓存（哪怕来自其它页面），保证商店数据始终最新。
    if (!noCache) {
      const mem = getCached<ServerListItem[]>(`servers:${source}`);
      if (mem) return mem;
    }
    throw err;
  }
}

export async function forceRefreshServerList(source: DataSource, signal?: AbortSignal): Promise<ServerListItem[]> {
  clearCached(`servers:${source}`);
  const diskKey = 'smithery-index';
  const api = getElectronAPI();
  if (api) await api.cache.delete(diskKey).catch(() => {});
  return revalidateServerList(source, diskKey, signal);
}

export async function fetchServerDetail(source: DataSource, id: string, signal?: AbortSignal): Promise<ServerDetail> {
  const custom = import.meta.env.VITE_REGISTRY_API_URL as string | undefined;
  if (custom) {
    // 自建后端模式：直接代理单条详情
    return getJson<ServerDetail>(`${custom}/servers/${id}?source=${source}`, signal);
  }
  return await fetchSmitheryServerDetail(id, signal);
}

// ---------------------------------------------------------------------------
// Smithery 详情（公开 registry API）
// ---------------------------------------------------------------------------
interface SmitheryDetailResponse {
  qualifiedName: string;
  displayName?: string;
  description?: string;
  iconUrl?: string | null;
  useCount?: number;
  verified?: boolean;
  createdAt?: string;
  remote?: boolean;
  homepage?: string;
  tools?: { name: string; description?: string }[];
  connections?: Array<{
    type: string;
    deploymentUrl?: string;
    url?: string;
    configSchema?: McpConfigSchema;
  }>;
}

async function fetchSmitheryServerDetail(id: string, signal?: AbortSignal): Promise<SmitheryDetail> {
  const qualifiedName = id.replace(/^smithery-/, '');
  const res = await getJson<SmitheryDetailResponse>(`${SMITHERY_API}/${encodeURIComponent(qualifiedName)}`, signal);
  const connection = res.connections && res.connections.length > 0 ? res.connections[0] : undefined;
  return {
    id,
    source: 'smithery',
    qualifiedName: res.qualifiedName || qualifiedName,
    displayName: res.displayName || qualifiedName,
    description: res.description || '',
    iconUrl: res.iconUrl ?? null,
    downloads: res.useCount ?? 0,
    verified: res.verified ?? false,
    createdAt: res.createdAt,
    homepage: res.homepage,
    connection: connection
      ? {
          runtime: 'node',
          type: connection.type,
          deploymentUrl: connection.deploymentUrl,
          url: connection.url,
          configSchema: connection.configSchema,
        }
      : { runtime: 'node' },
    capabilities: (res.tools || []).map(t => ({ name: t.name, description: t.description })),
    links: {
      registry: `https://smithery.ai/server/${qualifiedName}`,
      homepage: res.homepage,
    },
  };
}

export async function checkServerDetailExists(_source: DataSource, _id: string): Promise<boolean> {
  return false;
}

/**
 * Fetch README from GitHub repository
 */
export async function fetchReadmeFromGitHub(repository: {
  url: string;
  source?: string;
  subfolder?: string;
} | null): Promise<string | null> {
  if (!repository?.url) return null;

  const match = repository.url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2].replace(/\.git$/, '');
  const subfolder = repository.subfolder || '';
  const basePath = subfolder ? `${subfolder}/` : '';

  const branches = ['main', 'master'];
  const readmeFiles = ['README.md', 'readme.md', 'Readme.md'];

  for (const branch of branches) {
    for (const filename of readmeFiles) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${basePath}${filename}`;
      try {
        const response = await fetch(url, { headers: { 'Accept': 'text/plain' } });
        if (response.ok) {
          const content = await response.text();
          if (content.length > 100000) {
            return content.substring(0, 100000) + '\n\n... (truncated)';
          }
          return content;
        }
      } catch {
        // try next
      }
    }
  }

  return null;
}
