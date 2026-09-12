/**
 * installSkillFromZip 修复验证（任务 B）
 *
 * 覆盖：
 *   B1 不再臆造 branch='master'（非 GitHub 源留空）
 *   B2 files 写入「实际装入的文件清单」而非恒空
 *   B3 rawBaseUrl 不再持久化会过期的预签名直链
 *   B4 每次安装使用独立临时子目录，并发安装互不干扰
 *
 * 约束：**绝不安装到真实用户目录**——getSkillsPath 被重定向到临时目录；
 * 下载用 mock 的 zip（由本项目的 zip-writer 生成），不依赖真实网络。
 *
 * 解压改用项目自带的 extractZipEntries（纯 Node），测试**不依赖任何外部进程**
 * （不 shell tar / PowerShell / unzip），从根上消除并行下的 flaky。
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {buildZip, type ZipEntry} from '../main/zip-writer';
import {SkillsManager} from '../main/skills-manager';

vi.mock('../main/config-manager', () => ({
    SKILL_SUPPORTED_CLIENTS: ['cursor', 'claude-code'],
}));

let manager: SkillsManager;
let testDir: string;

function entry(zipPath: string, content: string): ZipEntry {
    return {zipPath, data: Buffer.from(content, 'utf8'), mtime: new Date()};
}

/** 构造一个带顶层外壳目录的 skill zip（模拟平台压缩包常见结构） */
function demoZip(): Buffer {
    return buildZip([
        entry('demo/SKILL.md', '---\nname: demo\ndescription: d\n---\n# demo\n'),
        entry('demo/ref/a.md', '引用'),
        entry('demo/scripts/run.mjs', 'console.log(1)'),
    ]);
}

beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `mcp-dock-zip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, {recursive: true});
    manager = new SkillsManager();
    // 关键：把安装根目录重定向到临时目录，避免污染真实客户端目录
    (manager as any).getSkillsPath = () => testDir;
});

afterEach(async () => {
    await fs.rm(testDir, {recursive: true, force: true}).catch(() => {});
    vi.unstubAllGlobals();
});

describe('installSkillFromZip（B1-B4）', () => {
    it('写入实际文件清单、非 GitHub 源不臆造 master、不持久化预签名直链', async () => {
        const buf = demoZip();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => buf,
        }));

        const res = await manager.installSkillFromZip(
            'https://cdn.example.com/archive.zip?sign=EXPIRES_IN_1H',
            'demo',
            ['cursor'],
            {repositoryUrl: 'https://platform.example.com/skills/demo'}
        );
        expect(res.success, JSON.stringify(res)).toBe(true);

        const meta = JSON.parse(await fs.readFile(path.join(testDir, 'demo', '.source.json'), 'utf-8'));
        // B2：实际装入清单（相对 skill 根，/ 分隔），不含 .source.json
        expect([...meta.files].sort()).toEqual(['SKILL.md', 'ref/a.md', 'scripts/run.mjs']);
        // B3：不再把预签名直链写进 rawBaseUrl
        expect(meta.source.rawBaseUrl).toBe('');
        expect(JSON.stringify(meta)).not.toContain('sign=EXPIRES_IN_1H');
        // B1：非 GitHub 源不伪造 'master'
        expect(meta.source.branch).toBe('');
        // 可复现来源地址被记录
        expect(meta.source.repositoryUrl).toBe('https://platform.example.com/skills/demo');

        // 内容确实落盘
        expect(await fs.readFile(path.join(testDir, 'demo', 'ref', 'a.md'), 'utf-8')).toBe('引用');
        expect(await fs.readFile(path.join(testDir, 'demo', 'scripts', 'run.mjs'), 'utf-8')).toBe('console.log(1)');
    });

    it('并发安装使用独立临时目录，互不干扰（旧实现共用 tmpRoot 会互删）', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => demoZip(),
        })));

        const [a, b] = await Promise.all([
            manager.installSkillFromZip('https://x/1', 'skill-a', ['cursor'], {repositoryUrl: 'https://p/a'}),
            manager.installSkillFromZip('https://x/2', 'skill-b', ['cursor'], {repositoryUrl: 'https://p/b'}),
        ]);
        expect(a.success, JSON.stringify(a)).toBe(true);
        expect(b.success, JSON.stringify(b)).toBe(true);
        expect(await fs.readFile(path.join(testDir, 'skill-a', 'SKILL.md'), 'utf-8')).toContain('# demo');
        expect(await fs.readFile(path.join(testDir, 'skill-b', 'SKILL.md'), 'utf-8')).toContain('# demo');
    });

    it('下载失败 → 返回失败且不残留半成品目录', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0)}));

        const res = await manager.installSkillFromZip('https://x/fail', 'demo', ['cursor']);
        expect(res.success).toBe(false);
        expect(res.error).toContain('403');
        const exists = await fs.access(path.join(testDir, 'demo')).then(() => true).catch(() => false);
        expect(exists).toBe(false);
    });

    it('zip-slip 防护：含 ../ 穿越条目被拒绝，extractDir 之外不写出任何文件', async () => {
        // '../../ESCAPED.txt' 若未被拦截，会逃出 extractDir 落到 installRoot（os.tmpdir()/mcp-dock-ms-install，
        // finally 只清理本次 workDir，故该文件若被写出会残留、可被断言发现）。
        const buf = buildZip([
            entry('demo/SKILL.md', '---\nname: demo\n---\n# demo\n'),
            entry('../../ESCAPED.txt', 'pwn'),
            entry('demo/ref/a.md', '引用'),
        ]);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => buf,
        }));

        const res = await manager.installSkillFromZip('https://x/slip', 'demo', ['cursor'], {repositoryUrl: 'https://p/demo'});

        // 合法内容仍安装成功；非法条目被静默拒绝
        expect(res.success, JSON.stringify(res)).toBe(true);
        expect(await fs.readFile(path.join(testDir, 'demo', 'SKILL.md'), 'utf-8')).toContain('# demo');
        // extractDir 之外（installRoot 根）没有 ESCAPED.txt 被写出
        const escaped = path.join(os.tmpdir(), 'mcp-dock-ms-install', 'ESCAPED.txt');
        await expect(fs.access(escaped)).rejects.toThrow();
        // 已安装目录内也不含有穿越条目落下的文件
        await expect(fs.access(path.join(testDir, 'demo', 'ESCAPED.txt'))).rejects.toThrow();
    });

    it('压缩包内全部条目被跳过（只有穿越条目）→ 明确失败', async () => {
        const buf = buildZip([entry('../evil.txt', 'pwn')]);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => buf,
        }));

        const res = await manager.installSkillFromZip('https://x/evil', 'evil', ['cursor']);
        expect(res.success).toBe(false);
        expect(res.error).toContain('没有可解压的文件');
    });
});
