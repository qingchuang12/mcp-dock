/**
 * 归档（ZIP / .skill）解包工具
 * 纯 Node 实现，无外部依赖（仅 zlib）。
 */

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
