/**
 * 归档（ZIP / .skill）解包工具
 * 纯 Node 实现，无外部依赖（仅 zlib）。
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

/**
 * 极简 ZIP 解包：读取中央目录，支持 Store(0) 与 Deflate(8)。返回 条目路径 -> 文件内容
 * 原实现位于 skills-manager.ts，现下沉为独立模块，行为完全一致。
 */
export function extractZipEntries(buffer: Buffer): Map<string, Buffer> {
    const entries = new Map<string, Buffer>();
    // 定位 EOCD（End of Central Directory）
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP / .skill 文件');
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    const total = buffer.readUInt16LE(eocd + 10);
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
        if (buffer.readUInt32LE(p) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(p + 10);
        const compSize = buffer.readUInt32LE(p + 20);
        const nameLen = buffer.readUInt16LE(p + 28);
        const extraLen = buffer.readUInt16LE(p + 30);
        const commentLen = buffer.readUInt16LE(p + 32);
        const localOffset = buffer.readUInt32LE(p + 42);
        const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
        const lNameLen = buffer.readUInt16LE(localOffset + 26);
        const lExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const compData = buffer.subarray(dataStart, dataStart + compSize);
        let content: Buffer;
        if (method === 0) content = Buffer.from(compData);
        else if (method === 8) content = zlib.inflateRawSync(compData);
        else {
            p += 46 + nameLen + extraLen + commentLen;
            continue;
        }
        entries.set(name, content);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * 把 zip 缓冲解包落地到 destDir（纯 Node，使用本模块的 extractZipEntries，不 shell out 外部进程）。
 *
 * 为什么不用外部 tar / PowerShell：本项目架构取向是「零第三方依赖、跨平台」；shell out 既依赖
 * PATH 中的 tar（GNU tar 读不了 ZIP）、又依赖 Windows 独有的 PowerShell，且在并行调用时进程争用会偶发失败。
 *
 * 安全（防 zip-slip）：条目路径以 `/` 开头、含 `..` 段、或 path.resolve 后越出 destDir 的一律**拒绝该条目**（不写出）；
 * 目录条目（以 `/` 结尾）与空路径条目跳过。返回实际写出的文件数（0 表示压缩包内没有可用文件）。
 */
export async function extractZipToDir(buffer: Buffer, destDir: string): Promise<number> {
    const entries = extractZipEntries(buffer);
    const resolvedDest = path.resolve(destDir);
    let written = 0;
    for (const [rawName, data] of entries) {
        const norm = rawName.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!norm || norm.endsWith('/')) continue; // 空路径 / 目录条目 → 跳过
        // 防穿越：绝对路径、含 .. 段一律拒绝该条目（不写出，避免 zip-slip 逃逸到 destDir 之外）
        if (norm.startsWith('/') || norm.split('/').some(s => s === '..')) continue;
        const target = path.resolve(destDir, ...norm.split('/'));
        if (target !== resolvedDest && !target.startsWith(resolvedDest + path.sep)) continue;
        await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.writeFile(target, data);
        written++;
    }
    return written;
}
