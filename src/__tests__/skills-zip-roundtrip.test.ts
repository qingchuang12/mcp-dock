/**
 * Skill zip 导出 ↔ 导入闭环测试（plan-3.0 后续增强）
 *
 * 验证：用本项目的 zip-writer 导出的 zip，能被 archive.extractZipEntries（技能导入通道）
 * 正确解开并解析出 SKILL.md——确保「导出 zip → 拖入创建弹窗 → 解析」整条链路可用。
 * 顺带覆盖 importFromZipBuffer 的 frontmatter 解析与多 skill 归档取最浅 SKILL.md。
 */

import {describe, expect, it} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {buildZip, type ZipEntry} from '../main/zip-writer';
import {extractZipEntries} from '../main/archive';
import {SkillsManager} from '../main/skills-manager';

function entry(zipPath: string, content: string): ZipEntry {
    return {zipPath, data: Buffer.from(content, 'utf8'), mtime: new Date()};
}

describe('zip 导出 ↔ 导入闭环', () => {
    it('导出的 zip 能被 archive 解开，SKILL.md 内容一致（含 UTF-8 中文）', () => {
        const skillMd = '---\nname: demo\n---\n# 中文说明\n正文内容。\n';
        const buf = buildZip([
            entry('demo/SKILL.md', skillMd),
            entry('demo/references/a.md', '引用'),
            entry('demo/scripts/run.mjs', 'console.log(1)'),
        ]);
        const entries = extractZipEntries(buf);
        expect(entries.get('demo/SKILL.md')?.toString('utf8')).toBe(skillMd);
        expect(entries.get('demo/references/a.md')?.toString('utf8')).toBe('引用');
        expect(entries.get('demo/scripts/run.mjs')?.toString('utf8')).toBe('console.log(1)');
    });

    it('importFromZipBuffer 正确解析 frontmatter（由 zip-writer 产物驱动）', async () => {
        const skillMd = '---\nname: 演示技能\ndescription: 一个测试技能\n---\n# 正文\n';
        const buf = buildZip([entry('cn-skill/SKILL.md', skillMd)]);
        const manager = new SkillsManager();
        const res = await manager.importFromZipBuffer(buf);
        expect(res.success).toBe(true);
        expect(res.name).toBe('演示技能');
        expect(res.description).toBe('一个测试技能');
        expect(res.body).toContain('# 正文');
    });

    it('多 skill 归档取最浅深度 SKILL.md（排除深层同名文件干扰）', async () => {
        const buf = buildZip([
            entry('root/SKILL.md', 'root 版'),
            entry('root/sub-a/SKILL.md', 'sub 版'),
            entry('root/sub-a/scripts/x.mjs', 'console.log(2)'),
        ]);
        const manager = new SkillsManager();
        const res = await manager.importFromZipBuffer(buf);
        expect(res.success).toBe(true);
        expect(res.body).toContain('root 版');
        // files 以 SKILL.md 所在目录（root/）为 skill 根，路径相对该目录
        const paths = (res.files || []).map(f => f.path).sort();
        expect(paths).toEqual(['sub-a/scripts/x.mjs']);
    });

    it('zip 解析出的 files 直接落盘无上层嵌套（杜绝 skills/<name>/<name>/），内容正确', async () => {
        const buf = buildZip([
            entry('nest-demo/SKILL.md', '---\nname: nest-demo\n---\n# zip 导入\n'),
            entry('nest-demo/scripts/run.mjs', 'console.log(9)'),
            entry('nest-demo/references/guide.md', '引用'),
        ]);
        const parsed = await new SkillsManager().importFromZipBuffer(buf);
        expect(parsed.success).toBe(true);

        const tmpHome = path.join(os.tmpdir(), `mcp-dock-skill-nest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const oldHome = process.env.HOME;
        const oldProfile = process.env.USERPROFILE;
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;
        try {
            const res = await new SkillsManager().createCustomSkill({
                name: parsed.name || 'nest-demo',
                description: parsed.description || '',
                body: parsed.body || '',
                files: parsed.files,
            }, ['cursor']);
            expect(res.success, JSON.stringify(res)).toBe(true);
            const base = path.join(tmpHome, '.cursor', 'skills', 'nest-demo');
            // 正确落盘：skills/nest-demo/scripts/run.mjs（无 nest-demo/ 嵌套）
            expect(await fs.readFile(path.join(base, 'scripts', 'run.mjs'), 'utf-8')).toBe('console.log(9)');
            expect(await fs.readFile(path.join(base, 'references', 'guide.md'), 'utf-8')).toBe('引用');
            await expect(fs.access(path.join(base, 'nest-demo'))).rejects.toThrow();
        } finally {
            process.env.HOME = oldHome;
            process.env.USERPROFILE = oldProfile;
            await fs.rm(tmpHome, {recursive: true, force: true}).catch(() => {});
        }
    });

    it('无效压缩包 → 报错', async () => {
        const manager = new SkillsManager();
        const res = await manager.importFromZipBuffer(Buffer.from('not a zip'));
        expect(res.success).toBe(false);
        expect(res.error).toBeTruthy();
    });

    it('importFromZipBuffer 返回完整附属文件（scripts/、references/），跳过 SKILL.md 与 .source.json', async () => {
        const buf = buildZip([
            entry('demo/SKILL.md', '# 正题\n'),
            entry('demo/scripts/run.mjs', 'console.log(1)'),
            entry('demo/references/指南.md', '参考'),
            entry('demo/.source.json', '{"id":"origin"}'),
            entry('demo/icon.svg', '<svg/>'),
        ]);
        const res = await new SkillsManager().importFromZipBuffer(buf);
        expect(res.success).toBe(true);
        const paths = (res.files || []).map(f => f.path).sort();
        // files.path 相对 SKILL.md 所在目录（skill 根），剥离顶层包裹目录 demo/
        expect(paths).toEqual(['icon.svg', 'references/指南.md', 'scripts/run.mjs']);
        const run = res.files!.find(f => f.path === 'scripts/run.mjs')!;
        expect(Buffer.from(run.data).toString('utf8')).toBe('console.log(1)');
    });

    it('穿越路径 / 超限压缩包被拒绝', async () => {
        const manager = new SkillsManager();
        const evil = buildZip([
            entry('demo/SKILL.md', '# x\n'),
            entry('demo/../escape.txt', 'pwn'),
        ]);
        const res = await manager.importFromZipBuffer(evil);
        expect(res.success).toBe(false);
        expect(res.error).toContain('非法路径');
    });

    it('createCustomSkill 落盘时写入 SKILL.md（编辑后）+ 附属文件，且不写 .source.json', async () => {
        // 用临时 HOME/USERPROFILE 隔离（os.homedir：POSIX 读 HOME，Windows 读 USERPROFILE），
        // 避免污染真实客户端目录；skill 名沿用 ASCII 约束（sanitizeSkillName 与手写创建一致）
        const tmpHome = path.join(os.tmpdir(), `mcp-dock-skill-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const oldHome = process.env.HOME;
        const oldProfile = process.env.USERPROFILE;
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;
        try {
            const manager = new SkillsManager() as any;
            const res = await manager.createCustomSkill({
                name: 'attachments-demo',
                description: '由 zip 导入',
                body: '# 编辑后的正文\n',
                files: [
                    {path: 'scripts/run.mjs', data: Buffer.from('console.log(42)')},
                    {path: 'references/a.md', data: Buffer.from('引用内容')},
                ],
            }, ['cursor']);
            expect(res.success, JSON.stringify(res)).toBe(true);

            const base = path.join(tmpHome, '.cursor', 'skills', 'attachments-demo');
            const skillMd = await fs.readFile(path.join(base, 'SKILL.md'), 'utf-8');
            expect(skillMd).toContain('编辑后的正文');
            expect(await fs.readFile(path.join(base, 'scripts', 'run.mjs'), 'utf-8')).toBe('console.log(42)');
            expect(await fs.readFile(path.join(base, 'references', 'a.md'), 'utf-8')).toBe('引用内容');
            // .source.json 不写入（本地导入 = 自定义语义）
            await expect(fs.access(path.join(base, '.source.json'))).rejects.toThrow();
        } finally {
            process.env.HOME = oldHome;
            process.env.USERPROFILE = oldProfile;
            await fs.rm(tmpHome, {recursive: true, force: true}).catch(() => {});
        }
    });
});

describe('createCustomSkill 穿越路径防护', () => {
    it('files 内含 ../ 路径 → 落盘失败且不残留半成品目录', async () => {
        const tmpHome = path.join(os.tmpdir(), `mcp-dock-skill-evil-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const oldHome = process.env.HOME;
        const oldProfile = process.env.USERPROFILE;
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;
        try {
            const manager = new SkillsManager() as any;
            const res = await manager.createCustomSkill({
                name: 'evil',
                description: '',
                body: '# x\n',
                files: [{path: '../escape.txt', data: Buffer.from('pwn')}],
            }, ['cursor']);
            expect(res.success).toBe(false);
            // 全量预检：SKILL.md 也未被写入（无半成品残留）
            await expect(
                fs.access(path.join(tmpHome, '.cursor', 'skills', 'evil', 'SKILL.md'))
            ).rejects.toThrow();
        } finally {
            process.env.HOME = oldHome;
            process.env.USERPROFILE = oldProfile;
            await fs.rm(tmpHome, {recursive: true, force: true}).catch(() => {});
        }
    });
});

describe('目录导入附属文件（文件夹导入 skill）', () => {
    it('importFromFile 目录分支返回完整附属文件（含空文件），不含 SKILL.md / .source.json', async () => {
        const srcDir = path.join(os.tmpdir(), `mcp-dock-src-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await fs.mkdir(path.join(srcDir, 'scripts'), {recursive: true});
        await fs.mkdir(path.join(srcDir, 'references'), {recursive: true});
        await fs.writeFile(path.join(srcDir, 'SKILL.md'), '---\nname: dir-demo\n---\n# 正文\n', 'utf-8');
        await fs.writeFile(path.join(srcDir, 'scripts', 'run.mjs'), 'console.log(1)', 'utf-8');
        await fs.writeFile(path.join(srcDir, 'references', 'a.md'), '引用', 'utf-8');
        await fs.writeFile(path.join(srcDir, '.gitkeep'), '', 'utf-8'); // 空文件（合法，不应整批拒绝）
        await fs.writeFile(path.join(srcDir, '.source.json'), '{"id":"origin"}', 'utf-8');
        try {
            const res = await new SkillsManager().importFromFile(srcDir);
            expect(res.success).toBe(true);
            expect(res.name).toBe('dir-demo');
            const paths = (res.files || []).map(f => f.path).sort();
            expect(paths).toEqual(['.gitkeep', 'references/a.md', 'scripts/run.mjs']);
            const run = res.files!.find(f => f.path === 'scripts/run.mjs')!;
            expect(Buffer.from(run.data).toString('utf8')).toBe('console.log(1)');
            const empty = res.files!.find(f => f.path === '.gitkeep')!;
            expect(empty.data.byteLength).toBe(0);
        } finally {
            await fs.rm(srcDir, {recursive: true, force: true}).catch(() => {});
        }
    });

    it('createCustomSkill 允许空内容附件落盘（.gitkeep 场景）', async () => {
        const tmpHome = path.join(os.tmpdir(), `mcp-dock-skill-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const oldHome = process.env.HOME;
        const oldProfile = process.env.USERPROFILE;
        process.env.HOME = tmpHome;
        process.env.USERPROFILE = tmpHome;
        try {
            const res = await new SkillsManager().createCustomSkill({
                name: 'empty-demo',
                description: '',
                body: '# 正文\n',
                files: [{path: '.gitkeep', data: new Uint8Array(0)}],
            }, ['cursor']);
            expect(res.success, JSON.stringify(res)).toBe(true);
            const st = await fs.stat(path.join(tmpHome, '.cursor', 'skills', 'empty-demo', '.gitkeep'));
            expect(st.size).toBe(0);
        } finally {
            process.env.HOME = oldHome;
            process.env.USERPROFILE = oldProfile;
            await fs.rm(tmpHome, {recursive: true, force: true}).catch(() => {});
        }
    });
});