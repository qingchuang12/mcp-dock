/**
 * Skills 管理器
 * 负责管理 Cursor, Claude Code, Gemini CLI, Codex CLI 的 Skills
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import {execFile} from 'child_process';
import {SKILL_SUPPORTED_CLIENTS, SkillClientType} from './config-manager';
import {CLOUD_ROOT_DIR} from '../shared/cloud-sync-constants';

// GitHub 仓库中发现的 Skill 信息
export interface DiscoveredSkill {
    name: string;
    path: string;
    skillMdUrl: string;
    skillMdContent: string;
    files: Array<{ name: string; path: string; rawUrl: string }>;
    repository: {
        url: string;
        branch: string;
        owner: string;
        repo: string;
    };
    /** 非 GitHub 源的 zip 下载直链（如 ModelScope 的 /skills/<owner>/<slug>/archive/zip/master）；存在时安装走 zip 解压通道 */
    downloadUrl?: string;
}

// Import 解析结果
export interface ImportParseResult {
    success: boolean;
    skills: DiscoveredSkill[];
    error?: string;
}

// Skills 来源元数据
export interface SkillSourceMeta {
    id: string;
    installedAt: string;
    updatedAt: string;
    source: {
        repositoryUrl: string;
        branch: string;
        skillPath: string;
        rawBaseUrl: string;
    };
    files: string[];
}

// 已安装的 Skill 信息
export interface InstalledSkill {
    name: string;
    path: string;
    source: SkillSourceMeta | null;
    hasUpdate?: boolean;
}

// Skills 安装结果
export interface SkillInstallResult {
    success: boolean;
    error?: string;
}

// 单个 Skill 同步到其他客户端的结果
export interface SkillSyncResult {
    success: SkillClientType[];
    failed: SkillClientType[];
    errors: Record<string, string>;
}

// 批量同步多个 Skill 的结果
export interface SkillBatchSyncResult {
    synced: number;
    failed: number;
    details: Array<{
        name: string;
        success: SkillClientType[];
        failed: SkillClientType[];
    }>;
}

// 用户设置
interface SkillsSettings {
    customSkillsPaths?: Partial<Record<SkillClientType, string>>;
}

export class SkillsManager {
    private defaultSkillsPaths: Record<SkillClientType, string>;
    private settingsPath: string;
    private settings: SkillsSettings = {};

    constructor() {
        const home = os.homedir();

        this.settingsPath = path.join(home, '.ai-tools', 'settings.json');

        // Skills 目录路径（跨平台一致）
        this.defaultSkillsPaths = {
            cursor: path.join(home, '.cursor', 'skills'),
            'claude-code': path.join(home, '.claude', 'skills'),
            'gemini-cli': path.join(home, '.gemini', 'skills'),
            'codex-cli': path.join(home, '.codex', 'skills'),
            opencode: path.join(home, '.config', 'opencode', 'skills'),
            'agent-skills': path.join(home, '.agents', 'skills'),
            codebuddy: path.join(home, '.codebuddy', 'skills'),
            workbuddy: path.join(home, '.workbuddy', 'skills'),
            qoder: path.join(home, '.qoder', 'skills'),
            marscode: path.join(home, '.marscode', 'skills'),
            cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'skills'),
        };

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
            };
        } catch {
            this.settings = {};
        }
    }

    /**
     * 获取 Skills 目录路径
     */
    getSkillsPath(client: SkillClientType): string {
        return this.settings.customSkillsPaths?.[client] || this.defaultSkillsPaths[client];
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
        const skillsPath = this.getSkillsPath(client);
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
        clients: SkillClientType[]
    ): Promise<SkillInstallResult> {
        await this.loadSettings();
        const skillName = skillId.split('/').pop() || skillId;

        for (const client of clients) {
            try {
                await this.ensureSkillsDir(client);
                const skillPath = path.join(this.getSkillsPath(client), skillName);

                if (!sourceInfo.files || sourceInfo.files.length === 0) {
                    // 文件清单为空：不写入空壳目录，直接返回失败（对齐 installFromDiscovered 的做法）
                    return {
                        success: false,
                        error: 'No installable files found for this Skill (empty file list). Installation aborted.',
                    };
                }

                await fs.mkdir(skillPath, {recursive: true});

                let downloadedCount = 0;
                const failedFiles: string[] = [];

                for (const file of sourceInfo.files) {
                    const fileUrl = `${sourceInfo.source.rawBaseUrl}/${file}`;
                    const filePath = path.join(skillPath, file);

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
        for (const client of clients) {
            try {
                const skillPath = path.join(this.getSkillsPath(client), skillName);
                await fs.rm(skillPath, {recursive: true, force: true});
                console.log(`[SkillsManager] Uninstalled skill ${skillName} from ${client}`);
            } catch (error) {
                console.error(`[SkillsManager] Failed to uninstall skill from ${client}:`, error);
            }
        }

        // 若目标含云端存储：暂存区目录已删除。远端推送统一由渲染层
        // confirmUninstall → pushCloudAsync 在后台异步完成（不阻塞卸载，且避免双重推送）。
    }

    /**
     * 将 Skill 名称规范化为合法的目录名（去掉路径分隔符等非法字符，转为 kebab-case）
     */
    private sanitizeSkillName(name: string): string {
        return name
            .trim()
            .replace(/\s+/g, '-')
            .replace(/[^a-zA-Z0-9_.-]/g, '')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();
    }

    /**
     * 生成 SKILL.md 内容（YAML frontmatter + 正文），符合 Anthropic Skill 规范
     */
    private buildSkillMd(name: string, description: string, body: string): string {
        const desc = (description || '').trim();
        const frontmatter =
            `---\nname: ${name}\n` +
            `description: ${desc}\n---\n\n`;
        return frontmatter + (body || '').trim() + '\n';
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
     * 从本地 .zip / .skill 文件解析 Skill（解包 ZIP，读取 SKILL.md 的 frontmatter + 正文）。
     * 用于「我的库」中通过上传/拖拽文件快速创建 Skill。.skill 本质是 ZIP 归档。
     */
    async importFromFile(filePath: string): Promise<{
        success: boolean;
        name?: string;
        description?: string;
        body?: string;
        error?: string;
    }> {
        try {
            const buffer = await fs.readFile(filePath);
            const entries = this.extractZipEntries(buffer);
            // 选取 SKILL.md：优先路径层级最浅（根目录）的那个
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
            const text = entries.get(skillMdKey)!.toString('utf-8');
            const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
            let name: string | undefined;
            let description = '';
            let body = text.trim();
            if (match) {
                const fm: Record<string, string> = {};
                match[1].split('\n').forEach(line => {
                    const idx = line.indexOf(':');
                    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                });
                name = fm.name || undefined;
                description = fm.description || '';
                body = match[2].trim();
            }
            // 名称兜底：取 SKILL.md 所在目录名
            if (!name) {
                const parts = skillMdKey.split(/[\\/]/);
                parts.pop();
                name = parts[parts.length - 1] || undefined;
            }
            return {success: true, name, description, body};
        } catch (error) {
            return {success: false, error: (error as Error).message || '无法解析文件'};
        }
    }

    /** 极简 ZIP 解包：读取中央目录，支持 Store(0) 与 Deflate(8)。返回 条目路径 -> 文件内容 */
    private extractZipEntries(buffer: Buffer): Map<string, Buffer> {
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
     * 创建自定义 Skill：在目标客户端的 skills/<name>/ 下写入 SKILL.md（不依赖网络，无 .source.json）
     */
    async createCustomSkill(
        input: { name: string; description: string; body: string },
        clients: SkillClientType[]
    ): Promise<{ success: boolean; error?: string; skillName?: string }> {
        const skillName = this.sanitizeSkillName(input.name);
        if (!skillName) {
            return {success: false, error: 'Skill 名称无效（仅允许字母、数字、点、中划线、下划线）'};
        }

        const content = this.buildSkillMd(skillName, input.description, input.body);

        for (const client of clients) {
            try {
                const skillPath = path.join(this.getSkillsPath(client), skillName);
                // 目录已存在且含 SKILL.md 视为重名冲突（仅对创建场景）
                try {
                    await fs.access(path.join(skillPath, 'SKILL.md'));
                    return {success: false, error: `Skill "${skillName}" 已存在于 ${client}`};
                } catch { /* 不存在，继续 */
                }

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
    ): Promise<{ success: boolean; error?: string }> {
        const newName = this.sanitizeSkillName(input.name) || originalName;
        const content = this.buildSkillMd(newName, input.description, input.body);

        for (const client of clients) {
            try {
                const base = this.getSkillsPath(client);
                const oldPath = path.join(base, originalName);
                const newPath = path.join(base, newName);

                await fs.access(oldPath);
                await this.ensureSkillsDir(client);

                if (newName !== originalName) {
                    // 目标目录已存在且不是自身（大小写归一后冲突）则报错，避免覆盖
                    if (newName !== originalName.toLowerCase() || newPath !== oldPath) {
                        try {
                            await fs.access(path.join(newPath, 'SKILL.md'));
                            if (newPath !== oldPath) {
                                return {success: false, error: `Skill "${newName}" 已存在，无法重命名`};
                            }
                        } catch { /* 目标不存在，可移动 */
                        }
                    }
                    await fs.mkdir(newPath, {recursive: true});
                    await fs.cp(oldPath, newPath, {recursive: true});
                    await fs.rm(oldPath, {recursive: true, force: true});
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

        return {success: true};
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
     * 解析 GitHub URL，提取仓库信息
     */
    private parseGitHubUrl(url: string): { owner: string; repo: string; branch?: string; subPath?: string } | null {
        // 清理空白字符（包括不可见的 Unicode 空格）和尾部斜杠
        const cleaned = url.trim().replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/\/+$/, '');

        // owner/repo 简写
        const shortMatch = cleaned.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
        if (shortMatch) {
            return {owner: shortMatch[1], repo: shortMatch[2]};
        }

        // GitHub URL: /tree/branch/path
        const treeMatch = cleaned.match(
            /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/tree\/([^\/]+)(?:\/(.+))?$/
        );
        if (treeMatch) {
            return {
                owner: treeMatch[1],
                repo: treeMatch[2],
                branch: treeMatch[3],
                subPath: treeMatch[4] || undefined,
            };
        }

        // GitHub URL: 基础格式（可能带 /blob/、/issues 等尾部，只提取 owner/repo）
        const baseMatch = cleaned.match(
            /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/
        );
        if (baseMatch) {
            return {
                owner: baseMatch[1],
                repo: baseMatch[2].replace(/\.git$/, ''),
            };
        }

        // raw.githubusercontent.com URL
        const rawMatch = cleaned.match(
            /^https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/
        );
        if (rawMatch) {
            const filePath = rawMatch[4];
            const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : undefined;
            return {
                owner: rawMatch[1],
                repo: rawMatch[2],
                branch: rawMatch[3],
                subPath: dir,
            };
        }

        return null;
    }

    private static readonly GITHUB_HEADERS = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'MCP-Dock',
    };

    private static readonly REQUEST_TIMEOUT_MS = 15000;

    /**
     * 带超时的 fetch 封装
     */
    private async fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SkillsManager.REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {...options, signal: controller.signal});
            return res;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * GitHub API 请求封装（含错误处理）
     */
    private async githubFetch(url: string): Promise<any> {
        const res = await this.fetchWithTimeout(url, {headers: SkillsManager.GITHUB_HEADERS});
        if (res.status === 403) {
            const body: any = await res.json().catch(() => ({}));
            if (body.message?.includes('rate limit')) {
                throw new Error('GitHub API rate limit exceeded. Please try again later or use a more specific URL (e.g. with /tree/main/skills)');
            }
            throw new Error('GitHub API access denied (403). The repository may be private');
        }
        if (res.status === 404) {
            throw new Error('Repository not found. Please check the URL');
        }
        if (!res.ok) {
            throw new Error(`GitHub API error: ${res.status}`);
        }
        return res.json();
    }

    /**
     * 通过 GitHub API 获取仓库默认分支，API 不可用时 fallback 到 HTML 解析
     */
    private async getDefaultBranch(owner: string, repo: string): Promise<string> {
        try {
            const data = await this.githubFetch(`https://api.github.com/repos/${owner}/${repo}`);
            return data.default_branch || 'main';
        } catch {
            try {
                const res = await this.fetchWithTimeout(`https://github.com/${owner}/${repo}`, {
                    headers: {'User-Agent': 'MCP-Dock'},
                    redirect: 'follow',
                });
                if (res.ok) {
                    const html = await res.text();
                    const match = html.match(/default-branch="([^"]+)"/);
                    if (match) return match[1];
                }
            } catch { /* ignore */
            }
            return 'main';
        }
    }

    /**
     * 使用 Contents API 列出目录内容
     */
    private async listDirContents(
        owner: string, repo: string, branch: string, dirPath: string
    ): Promise<any[]> {
        const apiPath = dirPath ? `contents/${dirPath}` : 'contents';
        const data = await this.githubFetch(
            `https://api.github.com/repos/${owner}/${repo}/${apiPath}?ref=${branch}`
        );
        return Array.isArray(data) ? data : [];
    }

    /**
     * 通过 GitHub HTML 页面解析目录中的子目录名（不消耗 API 配额）
     */
    private async listSubdirsViaHtml(
        owner: string, repo: string, branch: string, dirPath: string
    ): Promise<string[]> {
        const pageUrl = `https://github.com/${owner}/${repo}/tree/${branch}/${dirPath}`;
        const res = await this.fetchWithTimeout(pageUrl, {
            headers: {'User-Agent': 'MCP-Dock'},
        });
        if (!res.ok) return [];
        const html = await res.text();

        const prefix = `/${owner}/${repo}/tree/${branch}/${dirPath}/`;
        const regex = new RegExp(`href="${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^"/]+)"`, 'g');
        const dirs = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = regex.exec(html)) !== null) {
            dirs.add(m[1]);
        }
        return [...dirs];
    }

    /**
     * 扫描目录下的子目录，找出包含 SKILL.md 的（HEAD 到 raw.githubusercontent.com 不消耗 API 配额）
     */
    private async probeSkillMdInSubdirs(
        owner: string, repo: string, branch: string, parentPath: string, subdirNames: string[]
    ): Promise<string[]> {
        const BATCH_SIZE = 10;
        const found: string[] = [];

        for (let i = 0; i < subdirNames.length; i += BATCH_SIZE) {
            const batch = subdirNames.slice(i, i + BATCH_SIZE);
            const checks = batch.map(async (name) => {
                const fullPath = parentPath ? `${parentPath}/${name}` : name;
                const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fullPath}/SKILL.md`;
                try {
                    const res = await this.fetchWithTimeout(rawUrl, {method: 'HEAD'});
                    return res.ok ? fullPath : null;
                } catch {
                    return null;
                }
            });
            const results = await Promise.all(checks);
            for (const r of results) {
                if (r) found.push(r);
            }
        }

        return found;
    }

    /**
     * 通过 Contents API 扫描目录，找出包含 SKILL.md 的子目录
     * 如果 API 不可用，fallback 到 HTML 页面解析
     */
    private async findSkillDirsViaContents(
        owner: string, repo: string, branch: string, dirPath: string
    ): Promise<string[]> {
        let subdirNames: string[] = [];
        let hasDirectSkillMd = false;

        try {
            const items = await this.listDirContents(owner, repo, branch, dirPath);
            hasDirectSkillMd = items.some((f: any) => f.type === 'file' && f.name === 'SKILL.md');
            if (hasDirectSkillMd) return [dirPath];
            subdirNames = items.filter((f: any) => f.type === 'dir').map((f: any) => f.name as string);
        } catch {
            subdirNames = await this.listSubdirsViaHtml(owner, repo, branch, dirPath);
        }

        if (subdirNames.length === 0) {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dirPath}/SKILL.md`;
            try {
                const res = await this.fetchWithTimeout(rawUrl, {method: 'HEAD'});
                if (res.ok) return [dirPath];
            } catch { /* ignore */
            }
            return [];
        }

        return this.probeSkillMdInSubdirs(owner, repo, branch, dirPath, subdirNames);
    }

    /**
     * 使用 GitHub Search API 查找 SKILL.md 文件
     */
    private async searchSkillFiles(owner: string, repo: string, dirPath: string): Promise<string[]> {
        const pathQualifier = dirPath ? `+path:${dirPath}` : '';
        const query = encodeURIComponent(`filename:SKILL.md repo:${owner}/${repo}${pathQualifier}`);
        const url = `https://api.github.com/search/code?q=${query}&per_page=100`;

        const data = await this.githubFetch(url);
        const skillDirs = new Set<string>();
        for (const item of (data.items || []) as any[]) {
            const p: string = item.path;
            if (p.endsWith('/SKILL.md') || p === 'SKILL.md') {
                const dir = p.lastIndexOf('/') >= 0 ? p.substring(0, p.lastIndexOf('/')) : '';
                if (!dirPath || dir === dirPath || dir.startsWith(dirPath + '/')) {
                    skillDirs.add(dir);
                }
            }
        }
        return [...skillDirs];
    }

    /**
     * 使用 Git Trees API 递归扫描（仅适用于中小仓库）
     */
    private async findSkillDirsViaTree(owner: string, repo: string, branch: string, dirPath: string): Promise<string[]> {
        const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
        const data = await this.githubFetch(url);

        if (data.truncated) return [];

        const skillDirs = new Set<string>();
        const prefix = dirPath ? `${dirPath}/` : '';

        for (const item of (data.tree || []) as any[]) {
            if (item.type !== 'blob') continue;
            const p: string = item.path;
            if (dirPath && !p.startsWith(prefix)) continue;
            if (p.endsWith('/SKILL.md') || p === 'SKILL.md') {
                const dir = p.lastIndexOf('/') >= 0 ? p.substring(0, p.lastIndexOf('/')) : '';
                skillDirs.add(dir);
            }
        }

        return [...skillDirs];
    }

    /**
     * 查找 SKILL.md 所在目录（多策略自动降级）
     *
     * 场景覆盖：
     *   - 小仓库根目录有 SKILL.md
     *   - 仓库 skills/ 下有多个子目录各含 SKILL.md
     *   - 大仓库（tree API truncated）需要 Contents API 或 Search API
     *   - 用户指定了具体子路径
     */
    private async findSkillDirs(owner: string, repo: string, branch: string, dirPath: string): Promise<string[]> {
        // 策略 1: 如果指定了子路径，用 Contents API（含 HTML fallback）扫描该目录及其子目录
        if (dirPath) {
            try {
                const dirs = await this.findSkillDirsViaContents(owner, repo, branch, dirPath);
                if (dirs.length > 0) return dirs;
            } catch { /* continue */
            }
        }

        // 策略 2: 尝试 Git Trees API（中小仓库，一次请求拿到全部文件树）
        try {
            const dirs = await this.findSkillDirsViaTree(owner, repo, branch, dirPath);
            if (dirs.length > 0) return dirs;
        } catch { /* fallback */
        }

        // 策略 3: Search API（大仓库 fallback）
        try {
            const dirs = await this.searchSkillFiles(owner, repo, dirPath);
            if (dirs.length > 0) return dirs;
        } catch { /* continue */
        }

        // 策略 4: 未指定子路径时，探测常见 skills 目录结构（含 HTML fallback）
        if (!dirPath) {
            const commonParents = ['skills', '.cursor/skills', '.agents/skills', '.claude/skills'];
            for (const parent of commonParents) {
                try {
                    const dirs = await this.findSkillDirsViaContents(owner, repo, branch, parent);
                    if (dirs.length > 0) return dirs;
                } catch { /* continue */
                }
            }

            // 最后检查根目录 SKILL.md
            try {
                const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/SKILL.md`;
                const res = await this.fetchWithTimeout(rawUrl, {method: 'HEAD'});
                if (res.ok) return [''];
            } catch { /* ignore */
            }
        }

        return [];
    }

    /**
     * 递归获取指定目录下的所有文件（含子目录），用于完整安装一个 Skill。
     * installSkill 会按 file 的相对路径重建子目录，因此这里把 name 设为完整相对路径。
     */
    private async listDirFiles(
        owner: string, repo: string, branch: string, dirPath: string
    ): Promise<Array<{ name: string; path: string; rawUrl: string }>> {
        const baseRaw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;

        // 策略 1: 通过 GitHub Contents API 递归遍历（一次请求拿一层，自动下钻子目录）
        const walk = async (
            apiPath: string,
            relPrefix: string
        ): Promise<Array<{ name: string; path: string; rawUrl: string }>> => {
            let items: any[] = [];
            try {
                items = await this.githubFetch(
                    `https://api.github.com/repos/${owner}/${repo}/${apiPath}?ref=${branch}`
                );
            } catch {
                return [];
            }
            if (!Array.isArray(items)) return [];

            const out: Array<{ name: string; path: string; rawUrl: string }> = [];
            for (const f of items) {
                const rel = relPrefix ? `${relPrefix}/${f.name}` : f.name;
                if (f.type === 'file') {
                    out.push({name: rel, path: rel, rawUrl: `${baseRaw}/${rel}`});
                } else if (f.type === 'dir') {
                    out.push(...(await walk(`${apiPath}/${f.name}`, rel)));
                }
            }
            return out;
        };

        // relPrefix 从空开始：返回「相对 dirPath 的子路径」（如 LICENSE.txt、templates/a.js），
        // 与 installFromDiscovered 里已含 skill.path 的 rawBaseUrl 拼接，避免双重前缀导致 404。
        const files = await walk(dirPath ? `contents/${dirPath}` : 'contents', '');
        if (files.length > 0) return files;

        // 策略 2: HTML 页面解析文件名（不消耗 API 配额，作为兜底）
        try {
            const pageUrl = `https://github.com/${owner}/${repo}/tree/${branch}/${dirPath}`;
            const res = await this.fetchWithTimeout(pageUrl, {
                headers: {'User-Agent': 'MCP-Dock'},
            });
            if (res.ok) {
                const html = await res.text();
                const prefix = `/${owner}/${repo}/blob/${branch}/${dirPath}/`;
                const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`href="${escapedPrefix}([^"/]+)"`, 'g');
                const fileNames = new Set<string>();
                let m: RegExpExecArray | null;
                while ((m = regex.exec(html)) !== null) {
                    fileNames.add(m[1]);
                }
                if (fileNames.size > 0) {
                    return [...fileNames].map(name => ({
                        name,
                        path: dirPath ? `${dirPath}/${name}` : name,
                        rawUrl: `${baseRaw}/${dirPath ? `${dirPath}/` : ''}${name}`,
                    }));
                }
            }
        } catch { /* fallback */
        }

        return [];
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
            const branch = parsed.branch || await this.getDefaultBranch(owner, repo);
            const searchPath = parsed.subPath || '';

            const skillDirs = await this.findSkillDirs(owner, repo, branch, searchPath);

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
                    } catch { /* ignore */
                    }

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
     * 当 GitHub Contents API 限流 / 网络失败时，绕开 API 直接通过 raw.githubusercontent.com 探测并补全文件清单。
     * 思路：
     *  1) 优先确认 SKILL.md 在 raw 上可达；
     *  2) 解析 SKILL.md 正文中引用的本地相对路径（references/、scripts/、assets/ 等），逐个 raw HEAD 探测，存在的纳入清单。
     * 不消耗 api.github.com 配额，规避 403 rate limit。
     */
    private async resolveFilesViaRaw(
        owner: string,
        repo: string,
        branch: string,
        skillPath: string
    ): Promise<string[]> {
        const baseRaw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
        const prefix = skillPath ? `${skillPath}/` : '';

        const existsOnRaw = async (rel: string): Promise<boolean> => {
            try {
                const res = await this.fetchWithTimeout(`${baseRaw}/${prefix}${rel}`, {method: 'HEAD'});
                return res.ok;
            } catch {
                return false;
            }
        };

        const files: string[] = [];
        const seen = new Set<string>();
        const push = (rel: string) => {
            if (rel && !seen.has(rel)) {
                seen.add(rel);
                files.push(rel);
            }
        };

        // 1) SKILL.md 必须存在
        const skillMdRel = 'SKILL.md';
        if (await existsOnRaw(skillMdRel)) {
            push(skillMdRel);
        } else {
            return []; // raw 上连 SKILL.md 都拿不到，直接放弃
        }

        // 2) 下载 SKILL.md 正文，解析本地相对路径引用
        let mdText = '';
        try {
            const mdRes = await this.fetchWithTimeout(`${baseRaw}/${prefix}${skillMdRel}`);
            if (mdRes.ok) mdText = await mdRes.text();
        } catch { /* ignore */
        }

        if (mdText) {
            // 匹配形如 `references/foo.md`、`scripts/run.py`、`assets/img.png` 的本地相对引用
            const refRe = /(?:\[[^\]]*\]\(\s*|\b(?:include|reference|source)\s*[=:]\s*)(?:\.\/)?([\w./-]+\.(?:md|markdown|txt|json|ya?ml|py|js|ts|sh|bash|png|jpg|jpeg|gif|svg|csv|html|css))(?:\s*\)|\s*$)/gi;
            const candidates = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = refRe.exec(mdText)) !== null) {
                const rel = m[1].replace(/^\.\//, '');
                if (!rel.includes('://') && !rel.startsWith('/')) candidates.add(rel);
            }

            for (const rel of candidates) {
                if (await existsOnRaw(rel)) push(rel);
            }

            // 3) 常见子目录探测：references/、scripts/、assets/、templates/
            for (const dir of ['references', 'scripts', 'assets', 'templates']) {
                // 目录无法直接 HEAD，尝试探测几个常见文件名；若 SKILL.md 提到该目录则更激进
                const probeNames =
                    dir === 'references'
                        ? ['references/reference.md', 'references/README.md']
                        : dir === 'scripts'
                            ? ['scripts/main.py', 'scripts/run.py', 'scripts/main.js']
                            : dir === 'assets'
                                ? ['assets/icon.png', 'assets/cover.png']
                                : ['templates/template.md', 'templates/index.html'];
                for (const p of probeNames) {
                    if (await existsOnRaw(p)) push(p);
                }
            }
        }

        return files;
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
                const rawFiles = await this.resolveFilesViaRaw(owner, repo, branch, skill.path || '');
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

        return this.installSkill(skillId, sourceInfo, clients);
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
            const skillRoot = await this.findSkillRootDir(extractDir);

            // 4) 写入各客户端
            for (const client of clients) {
                try {
                    await this.ensureSkillsDir(client);
                    const skillPath = path.join(this.getSkillsPath(client), name);
                    await fs.rm(skillPath, {recursive: true, force: true});
                    await fs.cp(skillRoot, skillPath, {recursive: true});

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
     * 递归定位 zip 解压目录中含 SKILL.md 的“skill 根目录”。
     * zip 通常带一层外壳目录（如 skills/<owner>/<slug>/SKILL.md），需找到真正的 skill 根，
     * 否则整体 cp 会把 SKILL.md 放到错误层级，客户端按 <skillDir>/SKILL.md 扫描会读不到。
     * 找不到 SKILL.md 时回退返回传入根目录。
     */
    private async findSkillRootDir(root: string): Promise<string> {
        const stack: string[] = [root];
        let firstHit: string | null = null;
        while (stack.length) {
            const dir = stack.pop()!;
            let entries: import('fs').Dirent[] = [];
            try {
                entries = await fs.readdir(dir, {withFileTypes: true});
            } catch {
                continue;
            }
            // 该目录直接含 SKILL.md → 即为 skill 根
            if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
                return dir;
            }
            // 否则把子目录压栈，并记录最浅的候选（含 SKILL.md 的更深目录）
            for (const e of entries) {
                if (e.isDirectory()) {
                    const child = path.join(dir, e.name);
                    stack.push(child);
                    if (!firstHit && entries.some((x) => x.isFile() && x.name === 'SKILL.md')) {
                        firstHit = dir;
                    }
                }
            }
        }
        return root;
    }

    /**
     * 获取所有客户端的已安装 Skills
     */
    async getAllInstalledSkills(): Promise<{
        skills: Record<string, { name: string; clients: SkillClientType[] }>;
        byClient: Record<SkillClientType, InstalledSkill[]>;
    }> {
        const skills: Record<string, { name: string; clients: SkillClientType[] }> = {};
        const byClient: Record<SkillClientType, InstalledSkill[]> = {
            cursor: [],
            'claude-code': [],
            'gemini-cli': [],
            'codex-cli': [],
            opencode: [],
            'agent-skills': [],
            codebuddy: [],
            workbuddy: [],
            qoder: [],
            marscode: [],
            cloud: [],
        };

        for (const client of SKILL_SUPPORTED_CLIENTS) {
            const clientSkills = await this.getInstalledSkills(client);
            byClient[client] = clientSkills;

            for (const skill of clientSkills) {
                if (skills[skill.name]) {
                    skills[skill.name].clients.push(client);
                } else {
                    skills[skill.name] = {name: skill.name, clients: [client]};
                }
            }
        }

        return {skills, byClient};
    }

    /**
     * 获取本地已安装 Skill 的详情（用于详情页 fallback）
     */
    async getLocalSkillDetail(skillId: string): Promise<{
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

        for (const client of SKILL_SUPPORTED_CLIENTS) {
            const skillPath = path.join(this.getSkillsPath(client), skillName);
            try {
                await fs.access(skillPath);
            } catch {
                continue;
            }

            foundClients.push(client);

            if (!bestSource) {
                const sourcePath = path.join(skillPath, '.source.json');
                try {
                    const content = await fs.readFile(sourcePath, 'utf-8');
                    bestSource = JSON.parse(content);
                } catch { /* no source */
                }
            }

            if (!skillMdContent) {
                try {
                    skillMdContent = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
                } catch { /* no SKILL.md */
                }
            }

            if (fileList.length === 0) {
                try {
                    const entries = await fs.readdir(skillPath);
                    fileList = entries.filter(e => e !== '.source.json');
                } catch { /* ignore */
                }
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
     * 递归拷贝目录（含 .source.json，保留更新元数据）
     */
    private async copyDir(src: string, dest: string): Promise<void> {
        await fs.mkdir(dest, {recursive: true});
        const entries = await fs.readdir(src, {withFileTypes: true});
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                await this.copyDir(srcPath, destPath);
            } else if (entry.isFile()) {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }

    /**
     * 将一个已安装的 Skill 从源客户端同步（拷贝）到目标客户端
     */
    async syncSkillToClients(
        skillName: string,
        sourceClient: SkillClientType,
        targetClients: SkillClientType[]
    ): Promise<SkillSyncResult> {
        const sourcePath = path.join(this.getSkillsPath(sourceClient), skillName);
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
            const targetPath = path.join(this.getSkillsPath(client), skillName);
            try {
                await this.ensureSkillsDir(client);
                await fs.rm(targetPath, {recursive: true, force: true});
                await this.copyDir(sourcePath, targetPath);
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
}
