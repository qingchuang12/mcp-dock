import {getElectronAPI} from '../lib/electron';

/**
 * Registry API - 社区版增强
 *
 * 社区版原本的 fetch 全部硬编码返回空数组（需自建后端）。
 * 本版本在不依赖自建后端的前提下，接入以下**公开、无需密钥**的数据源，
 * 让 Official / Smithery / Skills 列表立即有真实数据：
 *   - Official MCP : GitHub 公共仓库 modelcontextprotocol/servers（src 下各 reference server）
 *   - Smithery     : 公开 registry API registry.smithery.ai/servers
 *   - Skills       : GitHub 公共 skills 索引（modelcontextprotocol/servers 的 src 目录 + README）
 *
 * 若用户自建了数据后端，可继续设置 VITE_REGISTRY_API_URL 覆盖默认行为。
 */

export type DataSource = 'official' | 'smithery';
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

// Official 配置项（环境变量 / 参数定义，供 OfficialConfigForm 渲染）
export interface PackageEnvVar {
  name: string;
  description?: string;
  required?: boolean;
  isRequired?: boolean;
  default?: string;
  isSecret?: boolean;
  choices?: string[];
  type?: string;
}

export interface PackageArg {
  name: string;
  description?: string;
  required?: boolean;
  isRequired?: boolean;
  default?: string;
  type?: string;
}

// Official 数据源配置表单用类型（与 OfficialConfigForm 配合使用）
export interface OfficialPackage {
  id: string;
  name: string;
  description?: string;
  version?: string;
  command?: string;
  args?: string[];
  env?: { name: string; description?: string; required?: boolean }[];
  registryType: 'npm' | 'pypi' | 'oci' | 'mcpb';
  identifier: string;
  runtimeHint?: 'node' | 'python' | 'docker';
  environmentVariables?: PackageEnvVar[];
  packageArguments?: PackageArg[];
}

export interface OfficialRemoteHeader {
  name: string;
  description?: string;
  required?: boolean;
  isRequired?: boolean;
  default?: string;
  isSecret?: boolean;
}

export interface OfficialRemote {
  id: string;
  name: string;
  url: string;
  description?: string;
  type?: string;
  headers?: OfficialRemoteHeader[];
}

// Base server list item - minimal fields for UI rendering
export interface ServerListItem {
  id: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
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
  source?: 'official' | 'smithery';
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
  packages?: OfficialPackage[];
  remotes?: OfficialRemote[];
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

export interface OfficialDetail extends ServerDetail {
  source: 'official';
  packages?: OfficialPackage[];
  remotes?: OfficialRemote[];
  topics?: string[];
  websiteUrl?: string;
  repository?: { url: string; source?: string; subfolder?: string };
  license?: string;
  version?: string;
  author?: string;
  readme?: string;
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
  updatedAt: string;
  repository: {
    url: string;
    branch: string;
    skillPath: string;
  };
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

export function isOfficialListItem(item: ServerListItem): boolean {
  return item.source === 'official';
}

export function isSmitheryDetail(detail: ServerDetail): detail is SmitheryDetail {
  return detail.source === 'smithery';
}

export function isOfficialDetail(detail: ServerDetail): detail is OfficialDetail {
  return detail.source === 'official';
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
// Official MCP (GitHub modelcontextprotocol/servers)
// ---------------------------------------------------------------------------
const OFFICIAL_REPO = 'modelcontextprotocol/servers';
const OFFICIAL_API = `https://api.github.com/repos/${OFFICIAL_REPO}`;

interface GithubContentEntry {
  name: string;
  type: string;
  path: string;
  html_url: string;
}

async function fetchOfficialServers(signal?: AbortSignal): Promise<ServerListItem[]> {
  // 列出 src 下的所有目录（每个目录是一个 reference server）
  // 注意：直接使用目录名作为展示与描述，不再逐个抓取 README 首行，
  // 以免目录数 N 触发 N 次 raw.githubusercontent 请求拖慢启动。
  const entries = await getJson<GithubContentEntry[]>(`${OFFICIAL_API}/contents/src`, signal);
  const dirs = entries.filter(e => e.type === 'dir');
  return dirs.map((dir): ServerListItem => ({
    id: `official-${dir.name}`,
    displayName: dir.name,
    description: `Official MCP server: ${dir.name}`,
    iconUrl: null,
    source: 'official',
    repository: dir.html_url,
    homepage: dir.html_url,
  }));
}

// ---------------------------------------------------------------------------
// Smithery (公开 registry API)
// ---------------------------------------------------------------------------
const SMITHERY_API = 'https://registry.smithery.ai/servers';

interface SmitheryServer {
  qualifiedName: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  homepage?: string;
  useCount?: number;
  verified?: boolean;
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
    repository: s.homepage || `https://smithery.ai/server/${s.qualifiedName}`,
    homepage: s.homepage,
    downloads: s.useCount ?? 0,
    verified: s.verified,
  } as ServerListItem));
}

// ---------------------------------------------------------------------------
// Skills (GitHub 索引：anthropics/skills 的 skills/ 目录)
// ---------------------------------------------------------------------------
// 注意：此处必须指向真正含 SKILL.md 的仓库。
// 曾错误地用 modelcontextprotocol/servers 的 src/ 目录当技能源，
// 但那些是 MCP server（全仓库 0 个 SKILL.md），详情页解析必然
// 返回 “No SKILL.md found” → 每一条都提示“加载 Skill 失败”。
const SKILLS_REPO = 'anthropics/skills';
const SKILLS_API = `https://api.github.com/repos/${SKILLS_REPO}`;
const SKILLS_DIR = 'skills';
const SKILLS_BRANCH = 'main';

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

async function fetchGithubSkills(signal?: AbortSignal): Promise<SkillListItem[]> {
  const entries = await getJson<GithubContentEntry[]>(
    `${SKILLS_API}/contents/${SKILLS_DIR}`,
    signal
  );
  const dirs = entries.filter(e => e.type === 'dir');
  const skills: SkillListItem[] = dirs.map(dir => {
    const categoryId = inferSkillCategoryId(dir.name);
    return {
      id: `skill-${dir.name}`,
      name: dir.name,
      description: `Anthropic official skill: ${dir.name}`,
      author: 'anthropics',
      authorUrl: `https://github.com/${SKILLS_REPO}`,
      category: categoryId,
      categoryId,
      stars: 0,
      forks: 0,
      updatedAt: new Date().toISOString().slice(0, 10),
      repository: {
        // html_url 形如 https://github.com/anthropics/skills/tree/main/skills/<name>，
        // 正是 parseGitHubUrl 支持的 /tree/<branch>/<subPath> 形态，详情页可直接解析。
        url: dir.html_url,
        branch: SKILLS_BRANCH,
        skillPath: dir.path,
      },
    };
  });
  return skills;
}

// ---------------------------------------------------------------------------
// 公开 API（可被自建后端 VITE_REGISTRY_API_URL 覆盖）
// ---------------------------------------------------------------------------
export async function fetchServerList(source: DataSource, signal?: AbortSignal): Promise<ServerListItem[]> {
  const custom = import.meta.env.VITE_REGISTRY_API_URL as string | undefined;
  if (custom) {
    // 自建后端模式：直接代理
    return getJson<ServerListItem[]>(`${custom}/servers?source=${source}`, signal);
  }

  const diskKey = source === 'official' ? 'official-index' : 'smithery-index';
  const api = getElectronAPI();

  // SWR：优先返回落盘缓存，首屏秒开；后台静默刷新。
  const cachedEntry = api ? await api.cache.get<ServerListItem[]>(diskKey) : null;
  if (cachedEntry?.data) {
    const cached = cachedEntry.data;
    // 后台 revalidate（不阻塞首屏）
    revalidateServerList(source, diskKey, signal).catch(() => {});
    return cached;
  }

  // 无缓存：走网络（已带 12s 超时）
  return revalidateServerList(source, diskKey, signal);
}

async function revalidateServerList(
  source: DataSource,
  diskKey: string,
  signal?: AbortSignal,
): Promise<ServerListItem[]> {
  try {
    const data = source === 'official'
      ? await fetchOfficialServers(signal)
      : await fetchSmitheryServers(signal);
    const api = getElectronAPI();
    if (api) await api.cache.set(diskKey, data);
    setCache(`servers:${source}`, data);
    return data;
  } catch (err) {
    // 网络失败时降级到内存缓存，否则继续抛出（让 React Query 走 error 态）
    const mem = getCached<ServerListItem[]>(`servers:${source}`);
    if (mem) return mem;
    throw err;
  }
}

export async function forceRefreshServerList(source: DataSource, signal?: AbortSignal): Promise<ServerListItem[]> {
  clearCached(`servers:${source}`);
  const diskKey = source === 'official' ? 'official-index' : 'smithery-index';
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
  return source === 'official'
    ? await fetchOfficialServerDetail(id, signal)
    : await fetchSmitheryServerDetail(id, signal);
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

// ---------------------------------------------------------------------------
// Official 详情（GitHub modelcontextprotocol/servers 的 src/<name>）
// ---------------------------------------------------------------------------
async function fetchOfficialServerDetail(id: string, signal?: AbortSignal): Promise<OfficialDetail> {
  const name = id.replace(/^official-/, '');
  const basePath = `src/${name}`;
  const repository: { url: string; source: string; subfolder: string } = {
    url: `https://github.com/${OFFICIAL_REPO}/tree/main/${basePath}`,
    source: OFFICIAL_REPO,
    subfolder: basePath,
  };

  const packages: OfficialPackage[] = [];
  const remotes: OfficialRemote[] = [];

  // 1) 尝试 Node 包：src/<name>/package.json
  const pkgUrl = `https://raw.githubusercontent.com/${OFFICIAL_REPO}/main/${basePath}/package.json`;
  let npmLicense: string | undefined;
  let npmVersion: string | undefined;
  try {
    const pkg = await getJson<{ name: string; version?: string; license?: unknown; bin?: unknown }>(pkgUrl, signal);
    packages.push({
      id: name,
      name,
      registryType: 'npm',
      identifier: pkg.name,
      version: pkg.version,
      runtimeHint: 'node',
      description: `${pkg.name} (npm)`,
    });
    if (pkg.license != null) npmLicense = String(pkg.license);
    if (pkg.version) npmVersion = pkg.version;
  } catch {
    // 2) 尝试 Python 包：src/<name>/pyproject.toml
    const tomlUrl = `https://raw.githubusercontent.com/${OFFICIAL_REPO}/main/${basePath}/pyproject.toml`;
    try {
      const res = await fetch(tomlUrl, { headers: { 'Accept': 'text/plain' }, signal });
      if (res.ok) {
        const toml = await res.text();
        const m = toml.match(/\[project\][^[]*?name\s*=\s*["']([^"']+)["']/s)
          || toml.match(/name\s*=\s*["']([^"']+)["']/);
        const v = toml.match(/version\s*=\s*["']([^"']+)["']/);
        packages.push({
          id: name,
          name,
          registryType: 'pypi',
          identifier: m ? m[1] : name,
          version: v ? v[1] : undefined,
          runtimeHint: 'python',
          description: `${m ? m[1] : name} (PyPI)`,
        });
      }
    } catch {
      // 无包可解析，降级为仅展示
    }
  }

  // 3) 尝试 remote 类型：src/<name>/mcp.json 含 transport.url
  const mcpJsonUrl = `https://raw.githubusercontent.com/${OFFICIAL_REPO}/main/${basePath}/mcp.json`;
  try {
    const mcpJson = await getJson<{ servers?: Record<string, { name?: string; transport?: { type?: string; url?: string }; url?: string }> }>(mcpJsonUrl, signal);
    if (mcpJson.servers) {
      for (const [key, srv] of Object.entries(mcpJson.servers)) {
        const url = srv.transport?.url || srv.url;
        if (url) {
          remotes.push({
            id: key,
            name: srv.name || key,
            url,
            description: `${key} (remote)`,
          });
        }
      }
    }
  } catch {
    // 无 remote 配置
  }

  return {
    id,
    source: 'official',
    displayName: name,
    description: `${name} (Official MCP server)`,
    iconUrl: null,
    repository,
    author: 'modelcontextprotocol',
    license: npmLicense,
    version: npmVersion,
    packages,
    remotes,
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

export async function fetchSkillsList(signal?: AbortSignal): Promise<SkillListItem[]> {
  const custom = import.meta.env.VITE_REGISTRY_API_URL as string | undefined;
  if (custom) {
    return getJson<SkillListItem[]>(`${custom}/skills`, signal);
  }

  const diskKey = 'skills-index';
  const api = getElectronAPI();

  // SWR：优先返回落盘缓存，首屏秒开；后台静默刷新。
  const cachedEntry = api ? await api.cache.get<SkillListItem[]>(diskKey) : null;
  if (cachedEntry?.data) {
    const cached = cachedEntry.data;
    revalidateSkillsList(diskKey, signal).catch(() => {});
    return cached;
  }

  return revalidateSkillsList(diskKey, signal);
}

async function revalidateSkillsList(
  diskKey: string,
  signal?: AbortSignal,
): Promise<SkillListItem[]> {
  try {
    const data = await fetchGithubSkills(signal);
    const api = getElectronAPI();
    if (api) await api.cache.set(diskKey, data);
    setCache('skills:github', data);
    return data;
  } catch (err) {
    const mem = getCached<SkillListItem[]>('skills:github');
    if (mem) return mem;
    throw err;
  }
}

export async function forceRefreshSkillsList(signal?: AbortSignal): Promise<SkillListItem[]> {
  clearCached('skills:github');
  const diskKey = 'skills-index';
  const api = getElectronAPI();
  if (api) await api.cache.delete(diskKey).catch(() => {});
  return revalidateSkillsList(diskKey, signal);
}

export async function clearSkillsCache(): Promise<void> {
  clearCached('skills:github');
  const api = getElectronAPI();
  if (api) await api.cache.delete('skills-index').catch(() => {});
}
