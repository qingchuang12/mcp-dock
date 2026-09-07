/**
 * 零依赖 zip 写入器（纯 Node zlib 实现）
 *
 * 背景：pnpm 布局下 node_modules 被进程占用，无法安装 yazl 等 zip 依赖（ENOTDIR /
 * ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR）；同时为保持「零第三方依赖、跨平台」的
 * 既有取向（解压走系统 tar / Expand-Archive），此处用 Node 内置 zlib.deflateRawSync +
 * 手写 CRC32 生成标准 zip 容器（Local File Header + Central Directory + EOCD，
 * 与解压路径天然互操作）。
 *
 * 支持：UTF-8 文件名（GP bit 11）、deflate 压缩、目录递归打包。
 */

import zlib from 'zlib';

// ==================== CRC32（表驱动） ====================

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf: Buffer, seed = 0): number {
    let crc = (seed ^ 0xffffffff) >>> 0;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ==================== DOS 时间戳 ====================

/** JS Date → zip DOS 时间/日期（本地时间语义，与常见打包工具一致） */
function dosDateTime(d: Date): { time: number; date: number } {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    // DOS 年份从 1980 起算；早于 1980 的钳到 1980
    const year = Math.max(d.getFullYear(), 1980);
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return {time: time & 0xffff, date: date & 0xffff};
}

// ==================== 打包 ====================

export interface ZipEntry {
    /** zip 内路径（正斜杠，含文件名；目录结尾加 /） */
    zipPath: string;
    /** 文件内容（目录条目为 null） */
    data: Buffer | null;
    /** 文件 mtime */
    mtime: Date;
}

/** 把任意条目序列化为 zip Buffer；entries 顺序即写入顺序 */
export function buildZip(entries: ZipEntry[]): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.zipPath, 'utf8');
        const isDir = entry.data === null;
        const data = entry.data ?? Buffer.alloc(0);
        const {time, date} = dosDateTime(entry.mtime);
        const crc = isDir ? 0 : crc32(data);
        const deflated = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(data);
        const compSize = deflated.length;
        const uncompSize = data.length;

        // ---- Local File Header ----
        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);   // signature
        lfh.writeUInt16LE(20, 4);           // version needed
        lfh.writeUInt16LE(0x0800, 6);       // flags: UTF-8 文件名
        lfh.writeUInt16LE(8, 8);            // method: deflate
        lfh.writeUInt16LE(time, 10);
        lfh.writeUInt16LE(date, 12);
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(compSize, 18);
        lfh.writeUInt32LE(uncompSize, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);           // extra len
        chunks.push(lfh, nameBuf, deflated);
        const localLen = 30 + nameBuf.length + compSize;

        // ---- Central Directory ----
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);    // signature
        cd.writeUInt16LE(20, 4);            // version made by
        cd.writeUInt16LE(20, 6);            // version needed
        cd.writeUInt16LE(0x0800, 8);        // flags
        cd.writeUInt16LE(8, 10);            // method
        cd.writeUInt16LE(time, 12);
        cd.writeUInt16LE(date, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(compSize, 20);
        cd.writeUInt32LE(uncompSize, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);            // extra len
        cd.writeUInt16LE(0, 32);            // comment len
        cd.writeUInt16LE(0, 34);            // disk start
        cd.writeUInt16LE(0, 36);            // internal attrs
        cd.writeUInt32LE(0, 38);            // external attrs
        cd.writeUInt32LE(offset, 42);       // local header offset
        central.push(cd, nameBuf);
        offset += localLen;
    }

    // ---- End Of Central Directory ----
    const centralSize = central.reduce((s, b) => s + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);               // disk num
    eocd.writeUInt16LE(0, 6);               // cd start disk
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);              // comment len

    return Buffer.concat([...chunks, ...central, eocd]);
}