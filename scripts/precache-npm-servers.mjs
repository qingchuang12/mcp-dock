/**
 * 构建期预缓存热门 MCP server npm 包元数据。
 *
 * 对一份精选清单（常见 MCP server 包）拉取 npm Registry 的包详情，落盘到
 * src/main/platforms/data/precache-npm-servers.json（version / license / bin / engines / repository）。
 * npm 适配器在 live 拉取失败时回退到该预缓存，保证离线也能拿到安装信息（Phase 4 轻量方案）。
 *
 * 容错：单个包失败跳过；全部失败也写出空 servers 对象，适配器按空缓存优雅降级。
 * 注意：本脚本需联网，不挂到默认 build 链，由发布前手动跑或 CI 缓存。
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'platforms', 'data', 'precache-npm-servers.json');

// 精选热门 MCP server 包（覆盖官方 server-*、社区常用、各厂商官方 SDK）
const PACKAGES = [
    '@modelcontextprotocol/server-filesystem',
    '@modelcontextprotocol/server-github',
    '@modelcontextprotocol/server-gitlab',
    '@modelcontextprotocol/server-google-drive',
    '@modelcontextprotocol/server-memory',
    '@modelcontextprotocol/server-postgres',
    '@modelcontextprotocol/server-sqlite',
    '@modelcontextprotocol/server-slack',
    '@modelcontextprotocol/server-puppeteer',
    '@modelcontextprotocol/server-sequentialthinking',
    '@modelcontextprotocol/server-everything',
    '@modelcontextprotocol/server-fetch',
    '@modelcontextprotocol/server-time',
    '@modelcontextprotocol/server-brave-search',
    '@modelcontextprotocol/server-kubernetes',
    '@modelcontextprotocol/server-docker',
    '@modelcontextprotocol/server-sentry',
    '@modelcontextprotocol/server-notion',
    '@modelcontextprotocol/server-obsidian',
    'mcp-server-qdrant',
    'mcp-server-sqlite',
    'gdrive-mcp-server',
    'context7-mcp',
    'exa-mcp-server',
    'playwright-mcp',
];

async function fetchPkg(name) {
    const res = await fetch(`${REGISTRY}/${name}`, {headers: {'Accept': 'application/json'}});
    if (!res.ok) return null;
    const meta = await res.json();
    const latest = meta['dist-tags']?.latest;
    const ver = latest ? meta.versions?.[latest] : null;
    if (!ver) return null;
    const bin = ver.bin
        ? (typeof ver.bin === 'string' ? ver.bin : Object.values(ver.bin)[0])
        : undefined;
    return {
        name: meta.name,
        version: latest,
        description: ver.description || meta.description || '',
        license: ver.license || meta.license || null,
        bin: bin || null,
        engines: ver.engines || null,
        repository: meta.repository?.url || null,
        publisher: meta.maintainers?.[0]?.name || null,
    };
}

async function main() {
    const servers = {};
    let ok = 0;
    for (const name of PACKAGES) {
        try {
            const p = await fetchPkg(name);
            if (p) {
                servers[name] = p;
                ok++;
            } else {
                console.warn(`[precache-npm-servers] empty: ${name}`);
            }
        } catch (e) {
            console.warn(`[precache-npm-servers] skip ${name}: ${e && e.message ? e.message : e}`);
        }
    }
    const out = {generatedAt: new Date().toISOString(), source: REGISTRY, count: ok, servers};
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`[precache-npm-servers] wrote ${ok}/${PACKAGES.length} servers -> ${OUT}`);
}

main().catch(e => {
    console.error('[precache-npm-servers] failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
});
