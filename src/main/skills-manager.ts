/**
 * Skills 管理器（编排门面）
 * 负责管理 Cursor, Claude Code, Gemini CLI, Codex CLI 的 Skills
 *
 * 本文件为「编排门面」：类型、本地存储/CRUD、云冲突检测、SKILL.md 解析均已下沉到
 * `./skills/*` 子模块（github / archive 之前已抽离），此处仅保留 SkillsManager 类并委托，
 * 对外 API 完全不变（含 `export * from './github'` 与 `extractZipEntries` 透出）。
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {execFile} from 'child_process';
import {SKILL_SUPPORTED_CLIENTS, SkillClientType} from './config-manager';
import {resolveSkillsPath} from './client-paths';
import {extractZipEntries} from './archive';
import {
    fetchWithTimeout as githubFetchWithTimeout,
    findSkillDirs,
    getDefaultBranch,
    githubParseGitHubUrl,
    listDirFiles as githubListDirFiles,
    resolveFilesViaRaw,
} from './github';

import {
    DiscoveredSkill,
    ImportParseResult,
    InstalledSkill,
    SkillBatchSyncResult,
    SkillCloudConflict,
    SkillInstallResult,
    SkillSourceMeta,
    SkillsSettings,
    SkillSyncResult,
} from './skills/types';
import {
    assertSafeSkillName,
    assertWithin,
    copyDir,
    dirByteSize,
    findSkillMdInDir,
    findSkillRootDir,
    sanitizeSkillName,
} from './skills/local-store';
import {buildSkillMd, parseSkillMd} from './skills/html-parse';
import {detectCloudConflicts} from './skills/conflict';

export {extractZipEntries} from './archive';
export * from './github';
export * from './skills/types';

export class SkillsManager {
    private settingsPath: string;
    private settings: SkillsSettings = {};

    constructor() {
        const home = os.homedir();

        this.settingsPath = path.join(home, '.ai-tools', 'settings.json');

        this.loadSettings();
    }

    /**
     * 加载用户设置
     */
    private async loadSettings(): Promise<void> {
        try {
            const content = await fs.readFile(this.settingsPath, 'utf-8');
            const allSettings = JSON.parse(content);
            this.settings = {
                customSkillsPaths: allSettings.customSkillsPaths,
                customClients: allSettings.customClients,
            };
        } catch {
            this.settings = {};
        }
    }

    /**
     * 获取 Skills 目录路径
     */
    getSkillsPath(client: SkillClientType): string {
        return resolveSkillsPath(client, {
            customClients: this.settings.customClients,
            customSkillsPaths: this.settings.customSkillsPaths,
        });
    }

    /**
     * 确保 Skills 目录存在
     */
    private async ensureSkillsDir(client: SkillClientType): Promise<void> {
        const skillsPath = this.getSkillsPath(client);
        await fs.mkdir(skillsPath, {recursive: true});
    }

    /**
     * 获取已安装的 Skills 列表
     */
    async getInstalledSkills(client: SkillClientType): Promise<InstalledSkill[]> {
        await this.loadSettings();
        return this.scanSkillsDir(this.getSkillsPath(client));
    }

    /**
     * 扫描单个 Skills 目录（物理目录级，不含客户端归属逻辑）
     */
    private async scanSkillsDir(skillsPath: string): Promise<InstalledSkill[]> {
        const skills: InstalledSkill[] = [];

        try {
            const entries = await fs.readdir(skillsPath, {withFileTypes: true});

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const skillPath = path.join(skillsPath, entry.name);
                    const sourcePath = path.join(skillPath, '.source.json');

                    let source: SkillSourceMeta | null = null;

                    try {
                        const sourceContent = await fs.readFile(sourcePath, 'utf-8');
                        source = JSON.parse(sourceContent);
                    } catch {
                        // .source.json 不存在，说明是手动安装的
                    }

                    // 检查是否有 SKILL.md
                    const skillMdPath = path.join(skillPath, 'SKILL.md');
                    try {
                        await fs.access(skillMdPath);
                        skills.push({
                            name: entry.name,
                            path: skillPath,
                            source,
                        });
                    } catch {
                        // 没有 SKILL.md，不是有效的 Skill
                    }
                }
            }
        } catch {
            // 目录不存在或无法读取
        }

        return skills;
    }

    /**
     * 目录键规范化：Windows 大小写不敏感且分隔符可混用，统一 resolve + 小写后比较，
     * 避免同一物理目录因写法差异被拆成两组。
     */
    private normalizeDirKey(dir: string): string {
        const resolved = path.resolve(dir);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    /**
     * 共享目录归属分组：多个客户端 id 可能解析到同一物理 Skills 目录
     * （如 trae-cn 与 trae-solo-cn 共用 ~/.trae-cn/skills，由产品 dataFolderName 决定）。
     * 同一物理目录只扫描一次；归属（owners）取组内「已安装」的客户端——
     * 只装其中一个时技能不会重复计入未安装的那个，两个都装了则都归属（技能确实同时生效）。
     * installedClients 缺省（未注入安装态）或组内无已安装客户端时回退为全部成员，保持历史行为。
     */
    private resolveScanGroups(installedClients?: SkillClientType[]): { clients: SkillClientType[]; owners: SkillClientType[] }[] {
        const groups = new Map<string, SkillClientType[]>();

        for (const client of SKILL_SUPPORTED_CLIENTS) {
            const dir = this.getSkillsPath(client);
            if (!dir) continue;
            const key = this.normalizeDirKey(dir);
            const members = groups.get(key);
            if (members) {
                members.push(client);
            } else {
                groups.set(key, [client]);
            }
        }

        return Array.from(groups.values(), clients => {
            const owners = installedClients
                ? clients.filter(c => installedClients.includes(c))
                : clients;
            return {clients, owners: owners.length > 0 ? owners : clients};
        });
    }

    /**
     * 安装 Skill
     */
    private async fetchWithRetry(
        url: string,
        maxRetries = 3,
        delayMs = 1000
    ): Promise<Response> {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const res = await this.fetchWithTimeout(url, {
                    headers: {'User-Agent': 'MCP-Dock'},
                });
                return res;
            } catch (err) {
                lastError = err as Error;
                if (attempt < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
                }
            }
        }
        throw lastError;
    }

    async installSkill(
        skillId: string,
        sourceInfo: SkillSourceMeta,
        clients: SkillClientType[],
        /** 远程安装时校验安装目录必须含 SKILL.md，避免写出空壳“假成功”；本地创建/保存不校验 */
        verifySkillMd = false
    ): Promise<SkillInstallResult> {
        await this.loadSettings();
        const skillName = skillId.split('/').pop() || skillId;
        assertSafeSkillName(skillName);

        for (const client of clients) {
            try {
                await this.ensureSkillsDir(client);
                const skillPath = path.join(this.getSkillsPath(client), skillName);
                assertWithin(this.getSkillsPath(client), skillPath);

                await fs.mkdir(skillPath, {recursive: true});

                let downloadedCount = 0;
                const failedFiles: string[] = [];

                for (const file of sourceInfo.files) {
                    const fileUrl = `${sourceInfo.source.rawBaseUrl}/${file}`;
                    const filePath = path.join(skillPath, file);
                    // 远端清单可能含 ../ 恶意路径，写入前校验仍落在 skill 目录内（P0-3）
                    assertWithin(skillPath, filePath);

                    await fs.mkdir(path.dirname(filePath), {recursive: true});

                    try {
                        const response = await this.fetchWithRetry(fileUrl);
                        if (response.ok) {
                            const content = await response.text();
                            await fs.writeFile(filePath, content, 'utf-8');
                            downloadedCount++;
                        } else {
                            console.error(`[SkillsManager] HTTP ${response.status} for ${file}`);
                            failedFiles.push(file);
                        }
                    } catch (error) {
                        console.error(`[SkillsManager] Failed to download ${file} after retries:`, error);
                        failedFiles.push(file);
                    }
                }

                if (sourceInfo.files.length > 0 && downloadedCount === 0) {
                    await fs.rm(skillPath, {recursive: true, force: true});
                    return {
                        success: false,
                        error: `All ${sourceInfo.files.length} files failed to download (network issue). Please check your network and try again.`,
                    };
                }

                const sourceMeta: SkillSourceMeta = {
                    ...sourceInfo,
                    installedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                await fs.writeFile(
                    path.join(skillPath, '.source.json'),
                    JSON.stringify(sourceMeta, null, 2),
                    'utf-8'
                );

                console.log(
                    `[SkillsManager] Installed skill ${skillName} to ${client}` +
                    ` (${downloadedCount}/${sourceInfo.files.length} files` +
                    `${failedFiles.length > 0 ? `, failed: ${failedFiles.join(', ')}` : ''})`
                );

                // 远程安装校验：安装目录根必须含 SKILL.md（大小写不敏感），否则客户端按 <skillDir>/SKILL.md
                // 扫描读不到。此前 SKILL.md 下载失败但其它文件成功时 downloadedCount>0 不会触发删除，
                // 会写出“只有 .source.json、无 SKILL.md”的空壳目录却 return success（假成功）。
                // 本地创建/保存场景不校验（文件已由本地先行写入，installSkill 仅补写元数据）。
                if (verifySkillMd) {
                    let hasSkillMd = false;
                    try {
                        const ents = await fs.readdir(skillPath);
                        hasSkillMd = ents.some(e => e.toLowerCase() === 'skill.md');
                    } catch {
                        hasSkillMd = false;
                    }
                    if (!hasSkillMd) {
                        await fs.rm(skillPath, {recursive: true, force: true}).catch(() => {
                        });
                        return {
                            success: false,
                            error: `安装目录缺少 SKILL.md，技能无效（${skillName}）。`,
                        };
                    }
                }
            } catch (error) {
                console.error(`[SkillsManager] Failed to install skill to ${client}:`, error);
                return {success: false, error: (error as Error).message};
            }
        }

        return {success: true};
    }

    /**
     * 卸载 Skill
     */
    async uninstallSkill(skillName: string, clients: SkillClientType[]): Promise<void> {
        await this.loadSettings();
        assertSafeSkillName(skillName);
        for (const client of clients) {
            try {
                const skillsPath = this.getSkillsPath(client);
                const skillPath = path.join(skillsPath, skillName);
                // 防止 `../../..` 类输入删除目录外路径（P0-3）
                assertWithin(skillsPath, skillPath);
                await fs.rm(skillPath, {recursive: true, force: true});
                console.log(`[SkillsManager] Uninstalled skill ${skillName} from ${client}`);
            } catch (error) {
                console.error(`[SkillsManager] Failed to uninstall skill from ${client}:`, error);
            }
        }

        // 若目标含云端存储：暂存区目录已删除。远端推送统一由渲染层
        // confirmUninstall → pushCloudAsync 在后台异步完成（不阻塞卸载，且避免双重推送）。
    }

    /** 解析 SKILL.md 的 frontmatter 与正文（用于编辑回填） */
    async readSkillMd(skillName: string, client: SkillClientType): Promise<{
        name: string;
        description: string;
        body: string
    } | null> {
        await this.loadSettings();
        const skillPath = path.join(this.getSkillsPath(client), skillName);
        try {
            const content = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
            const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
            if (!match) {
                return {name: skillName, description: '', body: content};
            }
            const fm: Record<string, string> = {};
            match[1].split('\n').forEach(line => {
                const idx = line.indexOf(':');
                if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            });
            return {
                name: fm.name || skillName,
                description: fm.description || '',
                body: match[2].trim(),
            };
        } catch {
            return null;
        }
    }

    /**
     * 从本地文件或目录解析 Skill，用于「我的库」快速创建。
     * 支持三种来源：
     *   - .zip / .skill：解包后读取 SKILL.md（.skill 本质是 ZIP 归档）
     *   - .md：直接作为 SKILL.md 文本读取
     *   - 目录（已解压的 skill 文件夹）：递归查找 SKILL.md
     */
    async importFromFile(filePath: string): Promise<{
        success: boolean;
        name?: string;
        description?: string;
        body?: string;
        error?: string;
    }> {
        try {
            const stat = await fs.stat(filePath);
            let skillMdText: string | undefined;
            let fallbackName: string | undefined;

            if (stat.isDirectory()) {
                // 目录：递归查找首个 SKILL.md（优先根目录，其次子目录）
                const found = await findSkillMdInDir(filePath);
                if (!found) {
                    return {success: false, error: '所选目录内未找到 SKILL.md'};
                }
                skillMdText = await fs.readFile(path.join(found.dir, 'SKILL.md'), 'utf-8');
                fallbackName = found.dir === filePath ? path.basename(filePath) : path.basename(found.dir);
            } else if (filePath.toLowerCase().endsWith('.md')) {
                // 单文件 .md：整份作为 SKILL.md
                skillMdText = await fs.readFile(filePath, 'utf-8');
                fallbackName = path.basename(filePath, '.md');
            } else {
                // .zip / .skill：解包后读取 SKILL.md
                const buffer = await fs.readFile(filePath);
                const entries = extractZipEntries(buffer);
                let skillMdKey: string | undefined;
                let bestDepth = Infinity;
                for (const key of entries.keys()) {
                    if (/SKILL\.md$/i.test(key)) {
                        const depth = key.split(/[\\/]/).length;
                        if (depth < bestDepth) {
                            bestDepth = depth;
                            skillMdKey = key;
                        }
                    }
                }
                if (!skillMdKey) {
                    return {success: false, error: '压缩包内未找到 SKILL.md'};
                }
                skillMdText = entries.get(skillMdKey)!.toString('utf-8');
                const parts = skillMdKey.split(/[\\/]/);
                parts.pop();
                fallbackName = parts[parts.length - 1] || undefined;
            }

            return parseSkillMd(skillMdText!, fallbackName);
        } catch (error) {
            return {success: false, error: (error as Error).message || '无法解析文件'};
        }
    }

    /**
     * 创建自定义 Skill：在目标客户端的 skills/<name>/ 下写入 SKILL.md（不依赖网络，无 .source.json）
     */
    async createCustomSkill(
        input: { name: string; description: string; body: string },
        clients: SkillClientType[]
    ): Promise<{ success: boolean; error?: string; skillName?: string }> {
        const skillName = sanitizeSkillName(input.name);
        if (!skillName) {
            return {success: false, error: 'Skill 名称无效（仅允许字母、数字、点、中划线、下划线）'};
        }

        const content = buildSkillMd(skillName, input.description, input.body);

        for (const client of clients) {
            try {
                const skillPath = path.join(this.getSkillsPath(client), skillName);
                // 目录已存在且含 SKILL.md 视为重名冲突（仅对创建场景）
                try {
                    await fs.access(path.join(skillPath, 'SKILL.md'));
                    return {success: false, error: `Skill "${skillName}" 已存在于 ${client}`};
                } catch { /* 不存在，继续 */ }

                await this.ensureSkillsDir(client);
                await fs.mkdir(skillPath, {recursive: true});
                await fs.writeFile(path.join(skillPath, 'SKILL.md'), content, 'utf-8');
                console.log(`[SkillsManager] Created custom skill ${skillName} to ${client}`);
            } catch (error) {
                return {success: false, error: (error as Error).message};
            }
        }

        return {success: true, skillName};
    }

    /**
     * 更新自定义 Skill：改写 SKILL.md frontmatter 与正文；若改名则移动整个目录
     */
    async updateCustomSkill(
        originalName: string,
        input: { name: string; description: string; body: string },
        clients: SkillClientType[]
    ): Promise<{ success: boolean; error?: string; skillName?: string }> {
        const newName = sanitizeSkillName(input.name) || originalName;
        const content = buildSkillMd(newName, input.description, input.body);

        for (const client of clients) {
            try {
                const base = this.getSkillsPath(client);
                const oldPath = path.join(base, originalName);
                const newPath = path.join(base, newName);

                await fs.access(oldPath);
                await this.ensureSkillsDir(client);

                if (newName !== originalName) {
                    // 目标已存在且与源不是同一路径则报错，避免覆盖（P1-7 修正大小写冲突保护）
                    try {
                        await fs.access(newPath);
                        if (path.resolve(newPath) !== path.resolve(oldPath)) {
                            return {success: false, error: `Skill "${newName}" 已存在，无法重命名`};
                        }
                    } catch { /* 目标不存在，可移动 */ }

                    // 同盘优先 fs.rename（原子、可中断）；跨盘才 cp，且校验目标完整后再删源，
                    // 避免 cp 中途失败仍执行 rm 造成源数据丢失（P1-7）。
                    const sameVolume = path.parse(oldPath).root === path.parse(newPath).root;
                    if (sameVolume) {
                        await fs.rename(oldPath, newPath);
                    } else {
                        await fs.cp(oldPath, newPath, {recursive: true});
                        const srcSize = await dirByteSize(oldPath);
                        const dstSize = await dirByteSize(newPath);
                        if (srcSize !== dstSize) {
                            throw new Error('重命名复制校验失败：源与目标大小不一致，已保留源目录');
                        }
                        await fs.rm(oldPath, {recursive: true, force: true});
                    }
                }

                // 写文件前判断是否被修改：对比现有 SKILL.md 解析出的正文与用户编辑后的正文
                let bodyChanged = true;
                try {
                    const current = await this.readSkillMd(newName, client);
                    if (current && (current.body || '').trim() === (input.body || '').trim()) {
                        bodyChanged = false;
                    }
                } catch {
                    bodyChanged = true;
                }

                await fs.writeFile(path.join(newPath, 'SKILL.md'), content, 'utf-8');
                // 仅当正文有变化时才视为用户接管该 Skill：删除来源标记，转为手动安装，
                // 不再参与「全部更新 / 单个更新」从线上源覆盖；无修改则保留来源标记。
                if (bodyChanged) {
                    await fs.rm(path.join(newPath, '.source.json'), {force: true});
                }
                console.log(`[SkillsManager] Updated custom skill ${originalName} -> ${newName} on ${client}`);
            } catch (error) {
                return {success: false, error: (error as Error).message};
            }
        }

        return {success: true, skillName: newName};
    }

    /**
     * 更新单个 Skill
     */
    async updateSkill(skillName: string, client: SkillClientType): Promise<{ updated: boolean; error?: string }> {
        await this.loadSettings();
        const skillPath = path.join(this.getSkillsPath(client), skillName);
        const sourcePath = path.join(skillPath, '.source.json');

        try {
            // 读取来源信息
            const sourceContent = await fs.readFile(sourcePath, 'utf-8');
            const source: SkillSourceMeta = JSON.parse(sourceContent);

            let downloadedCount = 0;
            for (const file of source.files) {
                const fileUrl = `${source.source.rawBaseUrl}/${file}`;
                const filePath = path.join(skillPath, file);

                try {
                    const response = await this.fetchWithRetry(fileUrl);
                    if (response.ok) {
                        const content = await response.text();
                        await fs.writeFile(filePath, content, 'utf-8');
                        downloadedCount++;
                    }
                } catch (error) {
                    console.error(`[SkillsManager] Failed to update file ${file} after retries:`, error);
                }
            }

            if (source.files.length > 0 && downloadedCount === 0) {
                return {updated: false, error: 'All files failed to download. Please check your network.'};
            }

            // 更新时间戳
            source.updatedAt = new Date().toISOString();
            await fs.writeFile(sourcePath, JSON.stringify(source, null, 2), 'utf-8');

            return {updated: true};
        } catch (error) {
            return {updated: false, error: (error as Error).message};
        }
    }

    /**
     * 批量更新所有 Skills
     */
    async updateAllSkills(client: SkillClientType): Promise<{ updated: number; failed: number }> {
        const skills = await this.getInstalledSkills(client);
        let updated = 0;
        let failed = 0;

        for (const skill of skills) {
            if (skill.source) {
                const result = await this.updateSkill(skill.name, client);
                if (result.updated) {
                    updated++;
                } else {
                    failed++;
                }
            }
        }

        return {updated, failed};
    }

    /**
     * 检查 Skill 是否已安装（在任意支持的客户端）
     */
    async isSkillInstalled(skillId: string): Promise<boolean> {
        const skillName = skillId.split('/').pop() || skillId;

        for (const client of SKILL_SUPPORTED_CLIENTS) {
            const skills = await this.getInstalledSkills(client);
            if (skills.some(s => s.name === skillName)) {
                return true;
            }
        }

        return false;
    }

    /**
     * 解析 GitHub URL，提取仓库信息。
     * 实现已下沉到 ./github（githubParseGitHubUrl），此处保留薄转发层，
     * 以兼容 skills-manager.test.ts 通过 (manager as any).parseGitHubUrl 的反射调用。
     */
    private parseGitHubUrl(url: string): { owner: string; repo: string; branch?: string; subPath?: string } | null {
        return githubParseGitHubUrl(url);
    }

    /**
     * 带超时的 fetch 封装。
     * 实现已下沉到 ./github（fetchWithTimeout），此处保留薄转发层，
     * 以兼容 skills-manager.test.ts 通过 (manager as any).fetchWithTimeout 的 mock。
     */
    private async fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
        return githubFetchWithTimeout(url, options);
    }

    /**
     * 递归获取指定目录下的所有文件（含子目录），用于完整安装一个 Skill。
     * 实现已下沉到 ./github（listDirFiles），此处保留薄转发层，
     * 以兼容 skills-manager.test.ts 通过 (manager as any).listDirFiles 的 mock。
     */
    private async listDirFiles(
        owner: string, repo: string, branch: string, dirPath: string
    ): Promise<Array<{ name: string; path: string; rawUrl: string }>> {
        return githubListDirFiles(owner, repo, branch, dirPath);
    }

    /**
     * 从 GitHub URL 解析并发现 Skills
     */
    async parseImportUrl(url: string): Promise<ImportParseResult> {
        const parsed = this.parseGitHubUrl(url);
        if (!parsed) {
            return {
                success: false,
                skills: [],
                error: 'Invalid GitHub URL. Supported formats: https://github.com/owner/repo, owner/repo'
            };
        }

        const {owner, repo} = parsed;

        try {
            const branch = parsed.branch || await getDefaultBranch(owner, repo);
            const searchPath = parsed.subPath || '';

            const skillDirs = await findSkillDirs(owner, repo, branch, searchPath);

            if (skillDirs.length === 0) {
                return {success: false, skills: [], error: 'No SKILL.md found in this repository'};
            }

            const skills: DiscoveredSkill[] = [];
            const MD_BATCH = 5;

            for (let i = 0; i < skillDirs.length; i += MD_BATCH) {
                const batch = skillDirs.slice(i, i + MD_BATCH);
                const fetches = batch.map(async (dir) => {
                    const skillMdPath = dir ? `${dir}/SKILL.md` : 'SKILL.md';
                    const skillMdUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillMdPath}`;

                    let skillMdContent = '';
                    try {
                        const mdRes = await this.fetchWithTimeout(skillMdUrl);
                        if (mdRes.ok) skillMdContent = await mdRes.text();
                    } catch { /* ignore */ }

                    const skillName = dir ? dir.split('/').pop() || repo : repo;

                    // repository.url 必须带实际子路径 dir（如 .../tree/<branch>/skills/brand-guidelines），
                    // 否则列表项 sourceUrl 会变成仓库根，详情页 resolveSkill 解析整个仓库后盲取 skills[0]，
                    // 安装的是错误的 skill 子目录（下载地址不对）。
                    const repoUrl = dir
                        ? `https://github.com/${owner}/${repo}/tree/${branch}/${dir}`
                        : `https://github.com/${owner}/${repo}`;
                    return {
                        name: skillName,
                        path: dir,
                        skillMdUrl,
                        skillMdContent,
                        files: [],
                        repository: {url: repoUrl, branch, owner, repo},
                    } as DiscoveredSkill;
                });
                const results = await Promise.all(fetches);
                skills.push(...results);
            }

            return {success: true, skills};
        } catch (error) {
            const msg = (error as Error).message || 'Unknown error';
            if ((error as Error).name === 'AbortError' || msg.includes('abort')) {
                return {
                    success: false,
                    skills: [],
                    error: 'Request timed out. The repository may be too large. Try using a more specific URL (e.g. https://github.com/owner/repo/tree/main/skills)'
                };
            }
            return {success: false, skills: [], error: msg};
        }
    }

    /**
     * 从发现的 Skill 安装到指定客户端
     */
    async installFromDiscovered(
        skill: DiscoveredSkill,
        clients: SkillClientType[]
    ): Promise<SkillInstallResult> {
        // 非 GitHub 源的 zip 下载直链（如 ModelScope）→ 走 zip 解压安装通道
        if (skill.downloadUrl) {
            return this.installSkillFromZip(skill.downloadUrl, skill.name, clients);
        }

        const {owner, repo, branch} = skill.repository;
        const skillId = `${owner}/${skill.path ? `${repo}/${skill.name}` : repo}`;
        const rawBaseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}${skill.path ? `/${skill.path}` : ''}`;

        // 1) 解析阶段已带出的文件清单优先
        let fileNames: string[] = skill.files.map(f => f.name);
        // 2) 否则递归列举 skill 目录（含子目录），拿到全部文件
        if (fileNames.length === 0) {
            try {
                const files = await this.listDirFiles(owner, repo, branch, skill.path || '');
                fileNames = files.map(f => f.name);
            } catch {
                fileNames = [];
            }
        }
        // 3) 兜底（方案 B）：GitHub Contents API 限流 / 网络失败时，绕开 API 直接通过
        //    raw.githubusercontent.com 探测并补全文件清单，不消耗 api.github.com 配额。
        if (fileNames.length === 0) {
            try {
                const rawFiles = await resolveFilesViaRaw(owner, repo, branch, skill.path || '');
                fileNames = rawFiles;
            } catch {
                fileNames = [];
            }
        }
        // 文件名需为「相对 skill.path 的子路径」：listDirFiles 返回的是带 skill.path 前缀的全路径，
        // 而 rawBaseUrl 已含 skill.path，若直接拼接会变成 .../skill.path/skill.path/file → 404。
        // 统一去掉可能的前导 skill.path 前缀，保证 rawBaseUrl + '/' + file 命中正确 raw 地址。
        const pathPrefix = skill.path ? `${skill.path}/` : '';
        fileNames = fileNames.map(f => (pathPrefix && f.startsWith(pathPrefix) ? f.slice(pathPrefix.length) : f));
        // 4) 仍无文件则明确抛错，避免写入“空壳 .source.json”造成“安装成功但无内容”的假象
        if (fileNames.length === 0) {
            throw new Error(
                '无法获取该 Skill 的文件（GitHub 目录列举与 raw 直抓均失败，可能被限流或网络异常）。请稍后重试。'
            );
        }

        const sourceInfo: SkillSourceMeta = {
            id: skillId,
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: {
                repositoryUrl: skill.repository.url,
                branch,
                skillPath: skill.path,
                rawBaseUrl,
            },
            files: fileNames,
        };

        return this.installSkill(skillId, sourceInfo, clients, true);
    }

    /**
     * 从非 GitHub 源的 zip 下载直链（如 ModelScope 的 /skills/<owner>/<slug>/archive/zip/master）
     * 安装 Skill：下载 zip → 解压到客户端 skills 目录 → 写 .source.json。
     * 与 GitHub 通道解耦，不影响既有逻辑。
     */
    private async installSkillFromZip(
        downloadUrl: string,
        skillName: string,
        clients: SkillClientType[]
    ): Promise<SkillInstallResult> {
        const name = skillName.split('/').pop() || skillName;
        const tmpRoot = path.join(os.tmpdir(), 'mcp-dock-ms-install');
        const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const zipPath = path.join(tmpRoot, `${token}.zip`);
        const extractDir = path.join(tmpRoot, token);

        try {
            await fs.mkdir(tmpRoot, {recursive: true});

            // 1) 下载 zip
            const res = await fetch(downloadUrl, {
                headers: {'User-Agent': 'Mozilla/5.0'},
            });
            if (!res.ok) {
                return {
                    success: false,
                    error: `下载 Skill 压缩包失败：HTTP ${res.status}`,
                };
            }
            const buf = Buffer.from(await res.arrayBuffer());
            await fs.writeFile(zipPath, buf);

            // 2) 解压（优先系统 tar，回退 PowerShell Expand-Archive）
            await fs.mkdir(extractDir, {recursive: true});
            let extracted = false;
            try {
                await new Promise<void>((resolve, reject) =>
                    execFile('tar', ['-xf', zipPath, '-C', extractDir], {windowsHide: true}, (err) =>
                        err ? reject(err) : resolve()
                    )
                );
                extracted = true;
            } catch {
                try {
                    await new Promise<void>((resolve, reject) =>
                        execFile(
                            'powershell',
                            [
                                '-NoProfile',
                                '-Command',
                                `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}'`,
                            ],
                            {windowsHide: true},
                            (err) => (err ? reject(err) : resolve())
                        )
                    );
                    extracted = true;
                } catch {
                    extracted = false;
                }
            }
            if (!extracted) {
                return {
                    success: false,
                    error: '解压 Skill 压缩包失败：系统缺少 tar 或 PowerShell Expand-Archive 支持。',
                };
            }

            // 3) 定位真正的 skill 根目录：zip 常带顶层外壳目录（如 skills/<owner>/<slug>/SKILL.md
            //    或单 <slug>/SKILL.md），需递归找到含 SKILL.md 的目录，否则整体 cp 会把 SKILL.md
            //    放到 skillPath/skills/.../SKILL.md，客户端按 <skillDir>/SKILL.md 扫描会读不到。
            const skillRoot = await findSkillRootDir(extractDir);

            // 4) 写入各客户端
            for (const client of clients) {
                try {
                    await this.ensureSkillsDir(client);
                    const skillPath = path.join(this.getSkillsPath(client), name);
                    await fs.rm(skillPath, {recursive: true, force: true});
                    await fs.cp(skillRoot, skillPath, {recursive: true});

                    // 校验：安装目录根必须含 SKILL.md（大小写不敏感），否则客户端按 <skillDir>/SKILL.md
                    // 扫描读不到。此前 findSkillRootDir 大小写敏感、定位偏差会导致写出“只有 .source.json、
                    // 无 SKILL.md”的空壳目录却 return success（假成功）。这里显式兜底，避免“提示成功实际没装”。
                    let hasSkillMd = false;
                    try {
                        const ents = await fs.readdir(skillPath);
                        hasSkillMd = ents.some(e => e.toLowerCase() === 'skill.md');
                    } catch {
                        hasSkillMd = false;
                    }
                    if (!hasSkillMd) {
                        await fs.rm(skillPath, {recursive: true, force: true}).catch(() => {
                        });
                        return {
                            success: false,
                            error: '压缩包内未找到 SKILL.md，无法识别为有效 Skill，安装已中止。',
                        };
                    }

                    const sourceMeta: SkillSourceMeta = {
                        id: name,
                        installedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        source: {
                            repositoryUrl: downloadUrl,
                            branch: 'master',
                            skillPath: '',
                            rawBaseUrl: downloadUrl,
                        },
                        files: [],
                    };
                    await fs.writeFile(
                        path.join(skillPath, '.source.json'),
                        JSON.stringify(sourceMeta, null, 2),
                        'utf-8'
                    );
                    console.log(`[SkillsManager] Installed skill ${name} (zip) to ${client}`);
                } catch (error) {
                    return {success: false, error: (error as Error).message};
                }
            }

            return {success: true};
        } catch (error) {
            return {success: false, error: (error as Error).message};
        } finally {
            await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {
            });
        }
    }

    /**
     * 获取所有客户端的已安装 Skills
     * @param installedClients 已安装客户端集合（IPC 层由 ConfigManager 注入）。
     *   共享同一物理 Skills 目录的客户端只归属给其中已安装者，避免同一批技能重复计入多个客户端。
     */
    async getAllInstalledSkills(installedClients?: SkillClientType[]): Promise<{
        skills: Record<string, { name: string; clients: SkillClientType[] }>;
        byClient: Record<SkillClientType, InstalledSkill[]>;
    }> {
        await this.loadSettings();
        const skills: Record<string, { name: string; clients: SkillClientType[] }> = {};
        // 由 SKILL_SUPPORTED_CLIENTS 派生，键集合与 SKILL_SUPPORTED_CLIENTS 始终一致
        const byClient = Object.fromEntries(
            SKILL_SUPPORTED_CLIENTS.map(c => [c, [] as InstalledSkill[]])
        ) as Record<SkillClientType, InstalledSkill[]>;

        for (const group of this.resolveScanGroups(installedClients)) {
            // 同组共享同一物理目录：任取组内首个客户端的目录扫描一次
            const clientSkills = await this.scanSkillsDir(this.getSkillsPath(group.clients[0]));

            for (const client of group.owners) {
                byClient[client] = clientSkills;
            }

            for (const skill of clientSkills) {
                for (const client of group.owners) {
                    if (skills[skill.name]) {
                        skills[skill.name].clients.push(client);
                    } else {
                        skills[skill.name] = {name: skill.name, clients: [client]};
                    }
                }
            }
        }

        return {skills, byClient};
    }

    /**
     * 获取本地已安装 Skill 的详情（用于详情页 fallback）
     */
    async getLocalSkillDetail(skillId: string, installedClients?: SkillClientType[]): Promise<{
        found: boolean;
        name: string;
        skillMdContent: string;
        source: SkillSourceMeta | null;
        files: string[];
        clients: SkillClientType[];
    } | null> {
        await this.loadSettings();

        const skillName = skillId.split('/').pop() || skillId;
        const foundClients: SkillClientType[] = [];
        let bestSource: SkillSourceMeta | null = null;
        let skillMdContent = '';
        let fileList: string[] = [];

        for (const group of this.resolveScanGroups(installedClients)) {
            // 同组共享同一物理目录：按组内首个客户端的路径探测一次，命中归属给 owners
            const skillPath = path.join(this.getSkillsPath(group.clients[0]), skillName);
            try {
                await fs.access(skillPath);
            } catch {
                continue;
            }

            foundClients.push(...group.owners);

            if (!bestSource) {
                const sourcePath = path.join(skillPath, '.source.json');
                try {
                    const content = await fs.readFile(sourcePath, 'utf-8');
                    bestSource = JSON.parse(content);
                } catch { /* no source */ }
            }

            if (!skillMdContent) {
                try {
                    skillMdContent = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
                } catch { /* no SKILL.md */ }
            }

            if (fileList.length === 0) {
                try {
                    const entries = await fs.readdir(skillPath);
                    fileList = entries.filter(e => e !== '.source.json');
                } catch { /* ignore */ }
            }
        }

        if (foundClients.length === 0) return null;

        return {
            found: true,
            name: skillName,
            skillMdContent,
            source: bestSource,
            files: fileList,
            clients: foundClients,
        };
    }

    /**
     * 将一个已安装的 Skill 从源客户端同步（拷贝）到目标客户端
     */
    async syncSkillToClients(
        skillName: string,
        sourceClient: SkillClientType,
        targetClients: SkillClientType[]
    ): Promise<SkillSyncResult> {
        const sourceSkillsPath = this.getSkillsPath(sourceClient);
        if (!sourceSkillsPath) {
            return {
                success: [],
                failed: [...targetClients],
                errors: {[skillName]: `源客户端 "${sourceClient}" 未配置 Skills 路径`},
            };
        }
        const sourcePath = path.join(sourceSkillsPath, skillName);
        try {
            await fs.access(sourcePath);
        } catch {
            return {
                success: [],
                failed: [...targetClients],
                errors: {[skillName]: '源客户端未找到该 Skill'},
            };
        }

        const success: SkillClientType[] = [];
        const failed: SkillClientType[] = [];
        const errors: Record<string, string> = {};

        for (const client of targetClients) {
            if (client === sourceClient) continue;
            const targetSkillsPath = this.getSkillsPath(client);
            if (!targetSkillsPath) {
                failed.push(client);
                errors[client as string] = `目标客户端 "${client}" 未配置 Skills 路径`;
                continue;
            }
            const targetPath = path.join(targetSkillsPath, skillName);
            try {
                await this.ensureSkillsDir(client);
                await fs.rm(targetPath, {recursive: true, force: true});
                await copyDir(sourcePath, targetPath);
                success.push(client);
            } catch (err) {
                failed.push(client);
                errors[client] = (err as Error).message || '复制失败';
            }
        }

        return {success, failed, errors};
    }

    /**
     * 批量将多个已安装的 Skill 同步到目标客户端
     */
    async syncSkillsToClients(
        items: Array<{ name: string; sourceClient: SkillClientType }>,
        targetClients: SkillClientType[]
    ): Promise<SkillBatchSyncResult> {
        const details: SkillBatchSyncResult['details'] = [];
        let synced = 0;
        let failed = 0;

        for (const item of items) {
            const result = await this.syncSkillToClients(item.name, item.sourceClient, targetClients);
            details.push({name: item.name, success: result.success, failed: result.failed});
            synced += result.success.length;
            failed += result.failed.length;
        }

        return {synced, failed, details};
    }

    /**
     * 检查 Skill 同步到云端时的冲突
     * 对比本地 skill 与云端 skill 的修改时间（.source.json 的 updatedAt 或 SKILL.md 的 mtime）
     * 仅返回云端已存在同名 skill 的条目（即存在冲突的）
     * 实现已下沉到 ./skills/conflict（detectCloudConflicts），此处保留薄转发层。
     */
    async checkCloudSyncConflicts(
        items: Array<{ name: string; sourceClient: SkillClientType }>
    ): Promise<SkillCloudConflict[]> {
        return detectCloudConflicts(this.getSkillsPath('cloud'), items, (c) => this.getSkillsPath(c));
    }

    /**
     * 按用户确认结果同步 Skill 到云端
     * resolutions: { [skillName]: 'overwrite' | 'skip' }
     */
    async syncSkillsToCloudResolved(
        items: Array<{ name: string; sourceClient: SkillClientType }>,
        resolutions: Record<string, 'overwrite' | 'skip'>
    ): Promise<SkillBatchSyncResult> {
        const toSync = items.filter(item => resolutions[item.name] !== 'skip');
        const skipped = items.filter(item => resolutions[item.name] === 'skip');

        const result = await this.syncSkillsToClients(toSync, ['cloud']);

        // 添加跳过的 skill 到结果详情
        for (const item of skipped) {
            result.details.push({
                name: item.name,
                success: [],
                failed: [],
            });
        }

        return result;
    }
}
