/**
 * 本地 Skill 存储助手（目录遍历 / 名称校验 / 拷贝 / 字节统计）
 *
 * 原实现散落在 SkillsManager 的私有方法（sanitizeSkillName / assertSafeSkillName /
 * assertWithin / dirByteSize / findSkillRootDir / copyDir / findSkillMdInDir），
 * 现整体下沉为模块级纯函数，行为完全一致。SkillsManager 仅做薄转发。
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * 将 Skill 名称规范化为合法的目录名（去掉路径分隔符等非法字符，转为 kebab-case）
 */
export function sanitizeSkillName(name: string): string {
    return name
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_.-]/g, '')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

/**
 * 校验 Skill 名是单一路径片段，禁止路径穿越（../ 或绝对/分隔符），用于安装与卸载路径拼接（P0-3）。
 * 注意：保留原始命名（仅过滤非法段），不强制 kebab，避免破坏既有的已安装目录名。
 */
export function assertSafeSkillName(name: string): void {
    if (!name || typeof name !== 'string') {
        throw new Error('Skill 名称不能为空');
    }
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new Error(`非法的 Skill 名称（含路径分隔符或父目录引用）：${name}`);
    }
}

/** 断言 target 解析后落在 baseDir 之内（含其自身），否则抛错，防止写入/删除越界（P0-3） */
export function assertWithin(baseDir: string, target: string): void {
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
        throw new Error(`非法路径：目标越出允许目录 ${baseDir}`);
    }
}

/** 递归统计目录字节数（用于跨盘重命名时校验复制完整性，P1-7） */
export async function dirByteSize(dir: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            total += await dirByteSize(p);
        } else {
            try {
                const st = await fs.stat(p);
                total += st.size;
            } catch {
                /* 忽略无法访问的文件 */
            }
        }
    }
    return total;
}

/**
 * 递归定位 zip 解压目录中含 SKILL.md 的“skill 根目录”。
 * zip 通常带一层外壳目录（如 skills/<owner>/<slug>/SKILL.md），需找到真正的 skill 根，
 * 否则整体 cp 会把 SKILL.md 放到错误层级，客户端按 <skillDir>/SKILL.md 扫描会读不到。
 * 找不到 SKILL.md 时回退返回传入根目录。
 */
export async function findSkillRootDir(root: string): Promise<string> {
    const stack: string[] = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        let entries: import('fs').Dirent[] = [];
        try {
            entries = await fs.readdir(dir, {withFileTypes: true});
        } catch {
            continue;
        }
        // 该目录直接含 SKILL.md（大小写不敏感，兼容 skill.md / Skill.md 等变体）→ 即为 skill 根
        if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) {
            return dir;
        }
        // 否则把子目录压栈继续向下查找
        for (const e of entries) {
            if (e.isDirectory()) {
                stack.push(path.join(dir, e.name));
            }
        }
    }
    return root;
}

/** 递归拷贝目录（含 .source.json，保留更新元数据） */
export async function copyDir(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, {recursive: true});
    const entries = await fs.readdir(src, {withFileTypes: true});
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else if (entry.isFile()) {
            await fs.copyFile(srcPath, destPath);
        }
    }
}

/** 递归查找目录内的 SKILL.md，优先根目录的，其次任意子目录；返回其所在目录 */
export async function findSkillMdInDir(dir: string): Promise<{ dir: string } | null> {
    const rootEntry = path.join(dir, 'SKILL.md');
    try {
        await fs.access(rootEntry);
        return {dir};
    } catch {
        // 根目录无 SKILL.md，继续递归
    }
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop()!;
        let entries: string[];
        try {
            entries = await fs.readdir(cur);
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(cur, e);
            let st: import('fs').Stats;
            try {
                st = await fs.stat(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                if (e.toLowerCase() === 'node_modules' || e.startsWith('.')) continue;
                stack.push(full);
            } else if (e.toLowerCase() === 'skill.md') {
                return {dir: cur};
            }
        }
    }
    return null;
}
