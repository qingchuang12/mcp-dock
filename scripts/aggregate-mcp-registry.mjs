/**
 * 构建期聚合官方 MCP Registry 快照。
 *
 * 拉取 https://registry.modelcontextprotocol.io/v0.1/servers（仅元数据索引，不托管包），
 * 抽取每个 server 的 name / description / repository / remotes / categories / packages，
 * 落盘到 src/main/platforms/data/mcp-registry-snapshot.json。
 *
 * npm 适配器在运行期读取该快照，按「仓库地址归一化」匹配 npm 包，给命中者打
 * 「已收录于官方 Registry」徽章并回填真实子分类（官方 Registry 没有可靠的 verified 字段，
 * 也不含 npm 包名，故以 repository.url 为多键匹配的唯一可行键）。
 *
 * 容错：网络/解析失败仅置 exitCode=1 并打印告警，不中断后续构建。
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'platforms', 'data', 'mcp-registry-snapshot.json');

/** 从 server 的 _meta（形如 <namespace>/publisher-provided: { categories: [] }）抽取分类。 */
function extractCategories(server) {
    const meta = server._meta || {};
    for (const value of Object.values(meta)) {
        if (value && Array.isArray(value.categories)) return value.categories;
    }
    return [];
}

/** 拉取单页（带 cursor）。 */
async function fetchPage(cursor) {
    const url = cursor ? `${REGISTRY_URL}?limit=100&cursor=${encodeURIComponent(cursor)}` : `${REGISTRY_URL}?limit=100`;
    const res = await fetch(url, {headers: {'Accept': 'application/json'}});
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    return res.json();
}

function mapServer(s) {
    const sv = s.server || s;
    return {
        name: sv.name || null,
        description: sv.description || '',
        repository: sv.repository?.url || null,
        remotes: Array.isArray(sv.remotes) ? sv.remotes.map(r => r.url).filter(Boolean) : [],
        categories: extractCategories(sv),
        packages: Array.isArray(sv.packages)
            ? sv.packages.map(p => ({registryType: p.registryType, version: p.version}))
            : [],
        version: sv.version || null,
    };
}

async function main() {
    const servers = [];
    let cursor = null;
    const MAX_PAGES = 50; // 安全上限（约 5000 条），避免异常分页导致死循环
    for (let page = 0; page < MAX_PAGES; page++) {
        const json = await fetchPage(cursor);
        const batch = Array.isArray(json?.servers) ? json.servers : [];
        for (const s of batch) servers.push(mapServer(s));
        const next = json?.metadata?.nextCursor;
        if (!next) break;
        cursor = next;
    }

    const out = {
        generatedAt: new Date().toISOString(),
        source: REGISTRY_URL,
        count: servers.length,
        servers,
    };

    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`[aggregate-mcp-registry] wrote ${out.servers.length} servers -> ${OUT}`);
}

main().catch(e => {
    console.error('[aggregate-mcp-registry] failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
});
