/**
 * Skill 导出为 zip 包（plan-3.0 后续增强）
 *
 * 用户反馈：我的库-skills「导出」此前只导出 JSON 元数据清单（name/path/source），
 * 无法把 skill 内容（SKILL.md、references/、scripts/ 等）带走复用。
 * 现改为导出标准 zip 包：每个 skill 一个目录（{skillName}/...），可直接解压安装到其他机器。
 *
 * 打包依赖 zip-writer（纯 Node zlib 实现，零第三方依赖——pnpm 布局下 node_modules 被
 * 进程占用无法装 yazl，且该取向与既有「解压走系统工具」一致）。
 */

import fs from 'fs/promises';
import path from 'path';
import {buildZip, type ZipEntry} from './zip-writer';
import type {InstalledSkill} from './skills-manager';

export interface SkillsExportResult {
    ok: boolean;
    error?: string;
    /** 下载建议文件名（含 .zip） */
    fileName?: string;
    /** zip 二进制（renderer 侧为 Uint8Array） */
    data?: Buffer;
}

/**
 * 递归收集目录内所有文件（保留相对路径），zip 内路径 = `${skillName}/${relPath}`。
 * 目录条目省略（zip 规范允许无目录条目，解压工具会自动建目录）。
 */
async function collectDirFiles(absDir: string, skillName: string): Promise<ZipEntry[]> {
    const entries: ZipEntry[] = [];
    const walk = async (dir: string, rel = ''): Promise<void> => {
        const list = await fs.readdir(dir, {withFileTypes: true});
        for (const item of list) {
            const abs = path.join(dir, item.name);
            const relPath = rel ? `${rel}/${item.name}` : item.name;
            if (item.isDirectory()) {
                await walk(abs, relPath);
            } else if (item.isFile()) {
                const [data, stat] = await Promise.all([fs.readFile(abs), fs.stat(abs)]);
                entries.push({
                    zipPath: `${skillName}/${relPath}`,
                    data,
                    mtime: stat.mtime,
                });
            }
        }
    };
    await walk(absDir);
    return entries;
}

function timestampName(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 导出选中 skill 为 zip 包。
 *
 * @param names 选中的 skill 名称（全部时由调用方传全部列表）
 * @param getAllInstalled 注入 skillsManager.getAllInstalledSkills()——
 *        其 byClient 值含 { name, path }（path = skill 目录绝对路径，含自定义客户端的 skill）
 */
export async function exportSkillsToZip(
    names: string[],
    getAllInstalled: () => Promise<{ byClient: Record<string, InstalledSkill[]> }>,
): Promise<SkillsExportResult> {
    if (names.length === 0) {
        return {ok: false, error: '没有可导出的 Skill'};
    }

    // name -> 目录（每个 skill 取首个命中客户端；同名多客户端内容一致时取任一即可）
    const dirs = new Map<string, string>();
    const {byClient} = await getAllInstalled();
    for (const list of Object.values(byClient)) {
        for (const s of list) {
            if (names.includes(s.name) && s.path && !dirs.has(s.name)) {
                dirs.set(s.name, s.path);
            }
        }
    }

    const missing = names.filter(n => !dirs.has(n));
    if (missing.length > 0) {
        return {ok: false, error: `未找到以下 Skill 的安装目录：${missing.join('、')}`};
    }

    try {
        const zipEntries: ZipEntry[] = [];
        for (const [name, dir] of dirs) {
            zipEntries.push(...await collectDirFiles(dir, name));
        }
        const data = buildZip(zipEntries);
        const fileName = dirs.size === 1
            ? `${[...dirs.keys()][0]}.zip`
            : `skills-export-${timestampName()}.zip`;
        return {ok: true, fileName, data};
    } catch (e: any) {
        return {ok: false, error: `导出失败：${e?.message || e}`};
    }
}