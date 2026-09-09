// 将各平台适配器内置的 data/ 目录拷贝进构建产物 dist/main/platforms/<name>/data。
// tsc 不会拷贝 .json 资源文件，若缺失会导致百炼/ClawHub 离线索引读不到（列表为空）。
import {cpSync, existsSync, mkdirSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcPlatforms = join(root, 'src', 'main', 'platforms');
const distPlatforms = join(root, 'dist', 'main', 'platforms');

if (!existsSync(srcPlatforms)) {
    console.error('[copy-platform-data] src/main/platforms 不存在');
    process.exit(1);
}

let copied = 0;
for (const entry of readdirSync(srcPlatforms, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dataSrc = join(srcPlatforms, entry.name, 'data');
    if (!existsSync(dataSrc)) continue;
    const dataDest = join(distPlatforms, entry.name, 'data');
    mkdirSync(dataDest, { recursive: true });
    cpSync(dataSrc, dataDest, { recursive: true });
    copied++;
    console.log(`[copy-platform-data] ${entry.name}/data -> dist/main/platforms/${entry.name}/data`);
}

if (copied === 0) {
    console.log('[copy-platform-data] 无内置 data 目录需拷贝');
}

// 额外拷贝平台层的「顶层」data 目录（如 npm 适配器的官方 Registry 快照 / 预缓存）：
// src/main/platforms/data -> dist/main/platforms/data
const topDataSrc = join(srcPlatforms, 'data');
if (existsSync(topDataSrc)) {
    const topDataDest = join(distPlatforms, 'data');
    mkdirSync(topDataDest, {recursive: true});
    cpSync(topDataSrc, topDataDest, {recursive: true});
    console.log('[copy-platform-data] platforms/data -> dist/main/platforms/data');
}
