/**
 * resolveZipSkill 解压环节测试（此前该文件零覆盖）
 *
 * 覆盖：平台 zip 直链 → 下载 → 解包 → 定位 SKILL.md → 组装可安装 Skill。
 * 解压改用项目自带的 extractZipToDir（纯 Node），因此测试**不依赖任何外部进程**
 * （不 shell tar / PowerShell / unzip），也**不依赖真实网络**（fetch 用 mock 注入）。
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {buildZip, type ZipEntry} from '../main/zip-writer';
import {resolveZipSkill} from '../main/resolvers/install-zip';

function entry(zipPath: string, content: string): ZipEntry {
    return {zipPath, data: Buffer.from(content, 'utf8'), mtime: new Date()};
}

/** mock 一次 zip 下载响应（不含 body 流，走 arrayBuffer 分支） */
function stubZipDownload(buf: Buffer): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {get: () => null},
        arrayBuffer: async () => buf,
    }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('resolveZipSkill（zip 直链解析）', () => {
    it('解包并读取 SKILL.md，组装出可安装 Skill（根目录带外壳目录）', async () => {
        stubZipDownload(buildZip([
            entry('demo/SKILL.md', '---\nname: demo\ndescription: 演示\n---\n# demo\n'),
            entry('demo/scripts/run.mjs', 'console.log(1)'),
        ]));

        const res = await resolveZipSkill({} as any, 'https://cdn.example.com/demo.zip', 'modelscope');

        expect(res.success, JSON.stringify(res)).toBe(true);
        expect(res.platform).toBe('modelscope');
        expect(res.resolvedVia).toBe('zip');
        expect(res.skills).toHaveLength(1);
        const skill = res.skills[0];
        expect(skill.name).toBe('demo');
        expect(skill.skillMdContent).toContain('# demo');
        // 来源信息如实透出（不臆造，供安装通道使用）
        expect(skill.downloadUrl).toBe('https://cdn.example.com/demo.zip');
        // zip 通道没有 Git 语义：不臆造分支（否则会被当成真实分支写进 .source.json）
        expect(skill.repository.branch).toBe('');
    });

    it('zip-slip 防护：穿越条目未逃逸出临时目录', async () => {
        // 唯一性 canary，避免与其它并发测试/历史残留串扰
        const canary = `ESCAPED_ZIPSLIP_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`;
        // '../../<canary>' 若未被拦截，会逃出 extractDir（<tmp>/mcp-dock-ms-zip/<token>）落到 os.tmpdir() 根
        stubZipDownload(buildZip([
            entry('demo/SKILL.md', '---\nname: demo\n---\n# demo\n'),
            entry(`../../${canary}`, 'pwn'),
        ]));

        const res = await resolveZipSkill({} as any, 'https://cdn.example.com/slip.zip', 'modelscope');

        expect(res.success, JSON.stringify(res)).toBe(true); // 合法内容仍解析成功
        await expect(fs.access(path.join(os.tmpdir(), canary))).rejects.toThrow(); // 未逃逸
    });

    it('无效 zip → 失败，且错误信息不再出现 tar / PowerShell 字样', async () => {
        stubZipDownload(Buffer.from('not a zip file'));

        const res = await resolveZipSkill({} as any, 'https://cdn.example.com/bad.zip', 'modelscope');

        expect(res.success).toBe(false);
        expect(res.error).toContain('解压 Skill 压缩包失败');
        expect(res.error).not.toMatch(/tar|PowerShell|Expand-Archive/i);
    });

    it('压缩包内无可解压文件（只有穿越条目）→ 明确失败', async () => {
        stubZipDownload(buildZip([entry('../evil.txt', 'pwn')]));

        const res = await resolveZipSkill({} as any, 'https://cdn.example.com/evil.zip', 'modelscope');

        expect(res.success).toBe(false);
        expect(res.error).toContain('没有可解压的文件');
    });

    it('下载失败（非 2xx）→ 如实报 HTTP 状态', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false, status: 403}));

        const res = await resolveZipSkill({} as any, 'https://cdn.example.com/denied.zip', 'modelscope');
        expect(res.success).toBe(false);
        expect(res.error).toContain('403');
    });

    it('并发隔离：只清理自己的 extractDir，不删除同级其它调用的目录（F1 回归）', async () => {
        // 确定性写法：先手工造一个「同级其它调用留下的目录」，调用结束后断言它仍在。
        // 修复前 finally 的 `rm -rf tmpRoot` 会连根删掉它 → 本断言红；修复后保留 → 绿。
        const tmpRoot = path.join(os.tmpdir(), 'mcp-dock-ms-zip');
        const otherDir = path.join(tmpRoot, `other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await fs.mkdir(otherDir, {recursive: true});
        await fs.writeFile(path.join(otherDir, 'keepme.txt'), 'keep', 'utf-8');

        try {
            stubZipDownload(buildZip([entry('demo/SKILL.md', '---\nname: demo\n---\n# demo\n')]));
            const res = await resolveZipSkill({} as any, 'https://cdn.example.com/iso.zip', 'modelscope');
            expect(res.success, JSON.stringify(res)).toBe(true);

            // 同级目录未被殃及
            expect(await fs.readFile(path.join(otherDir, 'keepme.txt'), 'utf-8')).toBe('keep');
        } finally {
            await fs.rm(otherDir, {recursive: true, force: true}).catch(() => {});
        }
    });
});
