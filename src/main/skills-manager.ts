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
import {SKILL_SUPPORTED_CLIENTS, SkillClientType} from './config-manager';
import {resolveSkillsPath} from './client-paths';
import {extractZipEntries, extractZipToDir} from './archive';
import {
    fetchWithTimeout as githubFetchWithTimeout,
    findSkillDirsEx,
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

/** 附属文件列表项（skill 目录内相对路径） */
export interface SkillFileItem {
    /** 相对 skill 目录的路径，/ 分隔 */
    path: string;
    size: number;
    /** protected = SKILL.md（正文区编辑，面板内禁止改删）；file = 普通附属文件 */
    kind: 'protected' | 'file';
}

/** 附属文件读取结果（编辑模式「附属文件」面板用） */
export type ReadSkillFileResult =
    | { success: true; mode: 'editable'; content: string }
    | { success: true; mode: 'readonly'; reason: 'binary' | 'too_large' }
    | { success: false; error: string };

/** 单文件在线编辑上限：超过返回只读，避免大文件拖垮编辑 UI */
const SKILL_FILE_READ_LIMIT = 512 * 1024;

/** 规范化 skill 附属文件相对路径：/ 分隔、去 ./，拒绝空/尾斜杠/绝对路径/.. 段 */
function normalizeSkillRelPath(relPath: string): string {
    const rel = (relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel || rel.endsWith('/') || rel.startsWith('/') || rel.split('/').some(s => s === '' || s === '..')) {
        throw new Error(`非法附件路径：${relPath}`);
    }
    return rel;
}

/**
 * 递归收集目录内所有文件相对 root 的路径（/ 分隔），供 zip 安装时把「实际装入的文件清单」
 * 写入 .source.json。旧实现写死 files: []，导致「我的库」详情页看不到任何附属文件。
 * 默认跳过 .source.json（它是后写的元数据，不属于技能内容）。
 */
async function collectRelativeFiles(root: string, skip: string[] = ['.source.json']): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        let entries: import('fs').Dirent[];
        try {
            entries = await fs.readdir(dir, {withFileTypes: true});
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(full);
            } else if (e.isFile()) {
                const rel = path.relative(root, full).split(path.sep).join('/');
                if (!skip.includes(rel)) out.push(rel);
            }
        }
    }
    return out.sort();
}

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
     * 全量技能客户端：内置 SKILL_SUPPORTED_CLIENTS + 用户手动添加且声明支持 Skills 的自定义客户端。
     * 自定义客户端此前不参与扫描，导致其装的技能在「我的库」不可见（与设置页/安装入口口径不一致）。
     * 注意：键类型为 SkillClientType 联合 + custom:<slug> 字符串，故 byClient 等结构用 Record<string, ...>。
     */
    private getSkillClientIds(): SkillClientType[] {
        const custom = (this.settings.customClients || [])
            .filter(c => c.supportsSkills && c.skillsPath)
            .map(c => c.id as SkillClientType);
        return [...SKILL_SUPPORTED_CLIENTS, ...custom];
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
     * 按物理 Skills 目录对客户端去重（P0-2）。
     * 多个客户端 id 可能解析到同一物理目录（如 trae-cn 与 trae-solo-cn 共用 ~/.trae-cn/skills），
     * 写入/重命名若按“两个客户端”各做一次会导致第二次 ENOENT 或误报重名。
     * 保留首次出现的客户端，归属展示不变，仅保证每物理目录只操作一次。
     */
    private dedupeClientsByPath(clients: SkillClientType[]): SkillClientType[] {
        const seen = new Set<string>();
        const result: SkillClientType[] = [];
        for (const client of clients) {
            const dir = this.getSkillsPath(client);
            if (!dir) continue;
            const key = this.normalizeDirKey(dir);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(client);
        }
        return result;
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

        for (const client of this.getSkillClientIds()) {
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

        // 空文件清单必然写出「只有 .source.json」的空壳目录，客户端扫描不到 SKILL.md，
        // 等价于没装上。此前该场景被判为成功（假成功），必须前置拦截。
        // 注：不能依赖下方 `files.length > 0 && downloadedCount === 0` —— files 为空时该判据恒为 false。
        if (!sourceInfo.files || sourceInfo.files.length === 0) {
            return {
                success: false,
                error: '该 Skill 没有可下载的文件（文件清单为空），无法安装。',
            };
        }

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

                // 文件清单已在入口保证非空，故此处 downloadedCount === 0 即全部下载失败
                if (downloadedCount === 0) {
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

    // ==================== 附属文件（编辑模式） ====================

    /**
     * 列出 skill 目录内的附属文件（编辑模式「附属文件」面板用）。
     * 规则：
     *  - 递归收集全部文件，目录条目不下发；
     *  - 排除 `.source.json`（来源元数据，既有约定隐藏，不随导入/编辑）；
     *  - `SKILL.md` 标记受保护（正文区域编辑，面板内禁止改删）。
     */
    async listSkillFiles(skillName: string, client: SkillClientType): Promise<SkillFileItem[] | null> {
        await this.loadSettings();
        const skillPath = path.join(this.getSkillsPath(client), skillName);
        const items: SkillFileItem[] = [];
        try {
            await this.walkSkillDir(skillPath, '', items);
        } catch {
            return null; // 目录不存在或不可读
        }
        // SKILL.md 置顶，其余按路径字典序（目录自然的斜杠排序）
        items.sort((a, b) => {
            if (a.path === 'SKILL.md') return -1;
            if (b.path === 'SKILL.md') return 1;
            return a.path.localeCompare(b.path);
        });
        return items;
    }

    /** 递归收集 skill 目录下全部文件（相对路径，/ 分隔） */
    private async walkSkillDir(dir: string, rel: string, out: SkillFileItem[]): Promise<void> {
        const entries = await fs.readdir(dir, {withFileTypes: true});
        for (const entry of entries) {
            if (entry.name === '.source.json') continue;
            const r = rel ? `${rel}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.walkSkillDir(abs, r, out);
            } else {
                let size = 0;
                try {
                    size = (await fs.stat(abs)).size;
                } catch { /* 无法访问的文件按 0 字节展示 */ }
                out.push({path: r, size, kind: r === 'SKILL.md' ? 'protected' : 'file'});
            }
        }
    }

    /** 递归收集目录内的附属文件（不含 SKILL.md 与 .source.json；path 相对 skill 根，供文件夹导入落盘） */
    private async collectSkillDirFiles(skillRoot: string): Promise<Array<{ path: string; data: Uint8Array }>> {
        const files: Array<{ path: string; data: Uint8Array }> = [];
        const walk = async (dir: string, rel: string): Promise<void> => {
            const entries = await fs.readdir(dir, {withFileTypes: true});
            for (const entry of entries) {
                if (entry.name === '.source.json') continue; // 本地导入 = 自定义语义，跳过来源元数据
                const r = rel ? `${rel}/${entry.name}` : entry.name;
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(abs, r);
                } else {
                    if (r === 'SKILL.md') continue;
                    files.push({path: r, data: await fs.readFile(abs)});
                }
            }
        };
        await walk(skillRoot, '');
        return files;
    }

    /**
     * 读取 skill 附属文件内容（编辑模式「附属文件」面板用）。
     * 规则：
     *  - 路径规范化 + `assertWithin` 双保险，拒绝穿越；
     *  - `SKILL.md` / `.source.json` 受保护，拒绝读取（SKILL.md 走正文编辑）；
     *  - 二进制（含 NUL 或严格 UTF-8 解码失败）与 >512KB 文件返回只读，不回灌内容。
     */
    async readSkillFile(skillName: string, client: SkillClientType, relPath: string): Promise<ReadSkillFileResult> {
        await this.loadSettings();
        let rel: string;
        try {
            rel = normalizeSkillRelPath(relPath);
        } catch (error) {
            return {success: false, error: (error as Error).message};
        }
        if (rel === 'SKILL.md' || rel.endsWith('.source.json')) {
            return {success: false, error: `受保护文件，请在对应区域编辑：${rel}`};
        }
        const skillPath = path.join(this.getSkillsPath(client), skillName);
        const abs = path.join(skillPath, rel);
        assertWithin(skillPath, abs);

        let stat;
        try {
            stat = await fs.stat(abs);
        } catch {
            return {success: false, error: `文件不存在：${rel}`};
        }
        if (stat.size > SKILL_FILE_READ_LIMIT) {
            return {success: true, mode: 'readonly', reason: 'too_large'};
        }
        const buf = await fs.readFile(abs);
        if (buf.includes(0)) { // 含 NUL 字节 → 二进制
            return {success: true, mode: 'readonly', reason: 'binary'};
        }
        try {
            // 严格 UTF-8 解码：失败即二进制（Buffer.toString 不抛错，无法兜底编码合法性）
            const text = new TextDecoder('utf-8', {fatal: true}).decode(buf);
            return {success: true, mode: 'editable', content: text};
        } catch {
            return {success: true, mode: 'readonly', reason: 'binary'};
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
        /** 目录导入收集的附属文件（不含 SKILL.md 与 .source.json），创建时随 input.files 一并落盘 */
        files?: Array<{ path: string; data: Uint8Array }>;
        error?: string;
    }> {
        try {
            const stat = await fs.stat(filePath);
            let skillMdText: string | undefined;
            let fallbackName: string | undefined;
            let dirFiles: Array<{ path: string; data: Uint8Array }> | undefined;

            if (stat.isDirectory()) {
                // 目录：递归查找首个 SKILL.md（优先根目录，其次子目录），并收集其所在目录的全部附属文件
                const found = await findSkillMdInDir(filePath);
                if (!found) {
                    return {success: false, error: '所选目录内未找到 SKILL.md'};
                }
                skillMdText = await fs.readFile(path.join(found.dir, 'SKILL.md'), 'utf-8');
                fallbackName = found.dir === filePath ? path.basename(filePath) : path.basename(found.dir);
                dirFiles = await this.collectSkillDirFiles(found.dir);
            } else if (filePath.toLowerCase().endsWith('.md')) {
                // 单文件 .md：整份作为 SKILL.md
                skillMdText = await fs.readFile(filePath, 'utf-8');
                fallbackName = path.basename(filePath, '.md');
            } else {
                // .zip / .skill：解包后读取 SKILL.md
                return this.importFromZipBuffer(await fs.readFile(filePath));
            }

            const parsed = parseSkillMd(skillMdText!, fallbackName);
            if (!parsed.success) return parsed;
            return {...parsed, files: dirFiles};
        } catch (error) {
            return {success: false, error: (error as Error).message || '无法解析文件'};
        }
    }

    /**
     * 从 ZIP/.skill 二进制（内存）解析 Skill：解包 → 取最浅深度的 SKILL.md → 解析 frontmatter，
     * 并返回完整附属文件（scripts/、references/ 等），供创建时一并落盘。
     * 供「创建 Skill → 拖入 / 选择 zip」使用——renderer 端 File 直接读成 ArrayBuffer 传入，
     * 不依赖 Electron 已弃用的 File.path（沙箱/新版本下 path 可能为 undefined，导致拖拽报错）。
     * 安全：解压总量与条目数上限（防 zip 炸弹）；路径规范化为「/」并拒绝 .. 段/绝对路径（防穿越）。
     */
    async importFromZipBuffer(buffer: Buffer | Uint8Array): Promise<{
        success: boolean;
        name?: string;
        description?: string;
        body?: string;
        /** zip 内附属文件（不含 SKILL.md 与 .source.json；path 为 skill 目录内相对路径） */
        files?: Array<{ path: string; data: Uint8Array }>;
        error?: string;
    }> {
        const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 解压总量上限 100MB
        const MAX_ENTRIES = 2000;                   // 条目数上限，防 zip 炸弹
        try {
            const entries = extractZipEntries(Buffer.from(buffer));

            // 取最浅深度 SKILL.md
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

            // 以 SKILL.md 所在目录为 skill 根（如 'camp-info/'；根目录 SKILL.md → ''）。
            // files.path 相对该目录：剥离顶层包裹目录，避免落盘时在 skills/<name>/ 下再套一层。
            const skillMdKeyNorm = skillMdKey.replace(/\\/g, '/');
            const skillDir = skillMdKeyNorm.split('/').slice(0, -1).join('/');
            const prefix = skillDir ? `${skillDir}/` : '';

            const files: Array<{ path: string; data: Uint8Array }> = [];
            let totalBytes = 0;
            for (const [key, data] of entries) {
                if (key === skillMdKey) continue;
                const norm = key.replace(/\\/g, '/').replace(/^\.\//, '');
                if (!norm || norm.endsWith('/')) continue; // 目录条目
                if (norm.startsWith('/') || norm.split('/').some(s => s === '..')) {
                    return {success: false, error: `压缩包内存在非法路径：${key}`};
                }
                if (norm.split('/').pop() === '.source.json') continue; // 本地导入 = 自定义语义，跳过来源元数据
                // 仅收取 SKILL.md 所在目录（skill 根）内的文件；多 skill 归档中其他 skill 的文件不并入
                if (prefix && !norm.startsWith(prefix)) continue;
                const rel = prefix ? norm.slice(prefix.length) : norm;
                if (!rel || rel.split('/').some(s => s === '' || s === '..')) {
                    return {success: false, error: `压缩包内存在非法路径：${key}`};
                }
                if (/SKILL\.md$/i.test(rel)) continue; // 深层 SKILL.md（其他 skill 入口）不作为附件
                totalBytes += data.length;
                if (totalBytes > MAX_TOTAL_BYTES || entries.size > MAX_ENTRIES) {
                    return {success: false, error: '压缩包内容过大，已拒绝解析（上限 100MB / 2000 个文件）'};
                }
                files.push({path: rel, data});
            }

            const skillMdText = entries.get(skillMdKey)!.toString('utf-8');
            const parts = skillMdKey.split(/[\\/]/);
            parts.pop();
            const fallbackName = parts[parts.length - 1] || undefined;
            const parsed = parseSkillMd(skillMdText, fallbackName);
            if (!parsed.success) return parsed;
            return {...parsed, files};
        } catch (error) {
            return {success: false, error: (error as Error).message || '无法解析压缩包'};
        }
    }

    /**
     * 创建自定义 Skill：在目标客户端的 skills/<name>/ 下写入 SKILL.md（不依赖网络，无 .source.json）。
     * zip 导入时 input.files 携带附属文件（scripts/、references/ 等），一并落盘；
     * 每条路径再次经 assertWithin 校验，防止 zip 内的穿越路径逃出 skill 目录。
     */
    async createCustomSkill(
        input: { name: string; description: string; body: string; files?: Array<{ path: string; data: Uint8Array }> },
        clients: SkillClientType[]
    ): Promise<{ success: boolean; error?: string; skillName?: string; results?: Array<{ client: SkillClientType; ok: boolean; error?: string }> }> {
        const skillName = sanitizeSkillName(input.name);
        if (!skillName) {
            return {success: false, error: 'Skill 名称无效（仅允许字母、数字、点、中划线、下划线）'};
        }

        const content = buildSkillMd(skillName, input.description, input.body);
        // P0-2：按物理目录去重，避免共享目录客户端（trae-cn/trae-solo-cn）重复写入
        const targets = this.dedupeClientsByPath(clients);
        if (targets.length === 0) {
            return {success: false, error: '未选择有效的目标客户端'};
        }

        const results: Array<{ client: SkillClientType; ok: boolean; error?: string }> = [];

        // 附件路径全量预检：任一非法（穿越/绝对路径）立即拒绝，避免「SKILL.md 先写、附件失败」的半成品残留
        for (const f of input.files || []) {
            const rel = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
            if (!rel || rel.split('/').some(s => s === '..') || rel.startsWith('/')) {
                return {success: false, error: `非法附件路径：${f.path}`};
            }
            // 对每个目标客户端校验落盘位置仍在 skill 目录内（路径真实拼接后校验）
            for (const client of targets) {
                const skillPath = path.join(this.getSkillsPath(client), skillName);
                assertWithin(skillPath, path.join(skillPath, rel));
            }
        }

        // P0-1：全量预检（重名冲突），全部通过后再落盘，避免写了一半再报冲突
        for (const client of targets) {
            const skillPath = path.join(this.getSkillsPath(client), skillName);
            try {
                await fs.access(path.join(skillPath, 'SKILL.md'));
                results.push({client, ok: false, error: `Skill "${skillName}" 已存在于 ${client}`});
            } catch { /* 不存在，可创建 */ 
                results.push({client, ok: true});
            }
        }
        if (results.some(r => !r.ok)) {
            return {
                success: false,
                error: results.filter(r => !r.ok).map(r => r.error).join('；'),
                skillName,
                results,
            };
        }

        // 执行落盘，逐客户端记录结果
        for (let i = 0; i < targets.length; i++) {
            const client = targets[i];
            try {
                const skillPath = path.join(this.getSkillsPath(client), skillName);
                await this.ensureSkillsDir(client);
                await fs.mkdir(skillPath, {recursive: true});
                await fs.writeFile(path.join(skillPath, 'SKILL.md'), content, 'utf-8');

                // zip 导入的附属文件：逐条写入（双重防护：解析层已滤除非法路径，此处再 assertWithin）
                for (const f of input.files || []) {
                    const rel = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
                    if (!rel || rel.split('/').some(s => s === '..') || rel.startsWith('/')) {
                        throw new Error(`非法文件路径：${f.path}`);
                    }
                    const dest = path.join(skillPath, rel);
                    assertWithin(skillPath, dest);
                    await fs.mkdir(path.dirname(dest), {recursive: true});
                    await fs.writeFile(dest, Buffer.from(f.data));
                }

                results[i] = {client, ok: true};
                console.log(`[SkillsManager] Created custom skill ${skillName} to ${client}${input.files?.length ? ` (${input.files.length} 个附属文件)` : ''}`);
            } catch (error) {
                results[i] = {client, ok: false, error: (error as Error).message};
            }
        }

        const okCount = results.filter(r => r.ok).length;
        if (okCount === 0) {
            return {success: false, error: results.map(r => r.error).join('；'), skillName, results};
        }
        if (okCount < targets.length) {
            const failed = results.filter(r => !r.ok).map(r => `${r.client}: ${r.error}`).join('；');
            return {success: false, error: `部分客户端保存失败（${okCount}/${targets.length}）：${failed}`, skillName, results};
        }
        return {success: true, skillName, results};
    }

    /**
     * 更新自定义 Skill：改写 SKILL.md frontmatter 与正文；若改名则移动整个目录
     */
    async updateCustomSkill(
        originalName: string,
        input: {
            name: string;
            description: string;
            body: string;
            /** 新建 / 覆盖的附属文件（编辑面板提交；路径为 skill 目录内相对路径） */
            files?: Array<{ path: string; data: Uint8Array }>;
            /** 删除的附属文件（编辑面板提交；相对路径列表） */
            removedFiles?: string[];
        },
        clients: SkillClientType[]
    ): Promise<{ success: boolean; error?: string; skillName?: string; results?: Array<{ client: SkillClientType; ok: boolean; error?: string }> }> {
        const newName = sanitizeSkillName(input.name) || originalName;
        const nameChanged = newName !== originalName;
        const content = buildSkillMd(newName, input.description, input.body);
        // P0-2：按物理目录去重，避免共享目录客户端重复 rename 导致 ENOENT
        const targets = this.dedupeClientsByPath(clients);
        if (targets.length === 0) {
            return {success: false, error: '未选择有效的目标客户端'};
        }

        // 附属文件变更预检：路径规范化 + 受保护拦截；任一非法整体拒绝（避免半成品残留，同 createCustomSkill）
        const filesNorm: Array<{ rel: string; data: Uint8Array }> = [];
        try {
            for (const f of input.files || []) {
                const rel = normalizeSkillRelPath(f.path);
                if (rel === 'SKILL.md' || rel.endsWith('.source.json')) {
                    return {success: false, error: `受保护文件不可修改：${f.path}`};
                }
                filesNorm.push({rel, data: f.data});
            }
        } catch (error) {
            return {success: false, error: (error as Error).message};
        }
        const removedNorm: string[] = [];
        try {
            for (const p of input.removedFiles || []) {
                const rel = normalizeSkillRelPath(p);
                if (rel === 'SKILL.md' || rel.endsWith('.source.json')) {
                    return {success: false, error: `受保护文件不可删除：${p}`};
                }
                // 与「新建/覆盖」同一路径时以写入为准，剔除删除（防御 UI 同时提交同路径）
                if (filesNorm.some(f => f.rel === rel)) continue;
                removedNorm.push(rel);
            }
        } catch (error) {
            return {success: false, error: (error as Error).message};
        }
        const filesActive = filesNorm.length > 0;
        const removedActive = removedNorm.length > 0;
        if (filesActive || removedActive) {
            for (const client of targets) {
                const skillPath = path.join(this.getSkillsPath(client), newName);
                for (const f of filesNorm) {
                    assertWithin(skillPath, path.join(skillPath, f.rel));
                }
                for (const rel of removedNorm) {
                    assertWithin(skillPath, path.join(skillPath, rel));
                }
            }
        }

        const results: Array<{ client: SkillClientType; ok: boolean; error?: string }> = [];

        // P0-1：全量预检（源存在 / 目标重名冲突），全部通过后再落盘
        for (const client of targets) {
            const base = this.getSkillsPath(client);
            const oldPath = path.join(base, originalName);
            const newPath = path.join(base, newName);
            try {
                await fs.access(oldPath);
            } catch {
                results.push({client, ok: false, error: `Skill "${originalName}" 在 ${client} 中不存在`});
                continue;
            }
            if (nameChanged) {
                try {
                    await fs.access(newPath);
                    if (path.resolve(newPath) !== path.resolve(oldPath)) {
                        results.push({client, ok: false, error: `Skill "${newName}" 已存在，无法重命名`});
                        continue;
                    }
                } catch { /* 目标不存在，可移动 */ }
            }
            results.push({client, ok: true});
        }
        if (results.some(r => !r.ok)) {
            return {
                success: false,
                error: results.filter(r => !r.ok).map(r => r.error).join('；'),
                skillName: newName,
                results,
            };
        }

        // 执行落盘，逐客户端记录结果
        for (let i = 0; i < targets.length; i++) {
            const client = targets[i];
            try {
                const base = this.getSkillsPath(client);
                const oldPath = path.join(base, originalName);
                const newPath = path.join(base, newName);

                await this.ensureSkillsDir(client);

                if (nameChanged) {
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

                // 附属文件：先删后写（删除列表已剔除同名写入项，顺序安全；逐条 assertWithin 双保险）
                for (const rel of removedNorm) {
                    const abs = path.join(newPath, rel);
                    assertWithin(newPath, abs);
                    try {
                        const st = await fs.stat(abs);
                        if (st.isFile()) {
                            await fs.rm(abs, {force: true});
                        }
                    } catch { /* 目标不存在，忽略（多客户端文件差异） */ }
                }
                for (const f of filesNorm) {
                    const dest = path.join(newPath, f.rel);
                    assertWithin(newPath, dest);
                    await fs.mkdir(path.dirname(dest), {recursive: true});
                    await fs.writeFile(dest, Buffer.from(f.data));
                }

                // 用户接管：正文变化或改名都视为脱离线上源，删除来源标记转为手动安装，
                // 不再参与「全部更新 / 单个更新」从线上源覆盖；无修改则保留来源标记。
                if (bodyChanged || nameChanged) {
                    await fs.rm(path.join(newPath, '.source.json'), {force: true});
                }
                results[i] = {client, ok: true};
                console.log(`[SkillsManager] Updated custom skill ${originalName} -> ${newName} on ${client}`);
            } catch (error) {
                results[i] = {client, ok: false, error: (error as Error).message};
            }
        }

        const okCount = results.filter(r => r.ok).length;
        if (okCount === 0) {
            return {success: false, error: results.map(r => r.error).join('；'), skillName: newName, results};
        }
        if (okCount < targets.length) {
            const failed = results.filter(r => !r.ok).map(r => `${r.client}: ${r.error}`).join('；');
            return {success: false, error: `部分客户端保存失败（${okCount}/${targets.length}）：${failed}`, skillName: newName, results};
        }
        return {success: true, skillName: newName, results};
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

            // zip 直链通道安装的 skill 不持久化 rawBaseUrl（预签名直链会过期），
            // 无法按文件回源更新；此处如实说明来源限制，避免退化成 '/SKILL.md' 后误报成「网络问题」。
            if (!source.source.rawBaseUrl) {
                return {updated: false, error: '该技能经平台压缩包通道安装，未记录可回源地址，无法增量更新。请从来源重新安装。'};
            }

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

        for (const client of this.getSkillClientIds()) {
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

            const discovery = await findSkillDirsEx(owner, repo, branch, searchPath);

            // 枚举因网络/限流失败时，绝不能谎报「仓库里没有 SKILL.md」（仓库明明有，只是没请求到）
            if (discovery.enumerationFailed) {
                return {
                    success: false,
                    skills: [],
                    error: discovery.error || 'GitHub 接口请求失败（网络异常或限流），请稍后重试。',
                };
            }

            const skillDirs = discovery.dirs;
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
        // 非 GitHub 源的 zip 下载直链（如 ModelScope）→ 走 zip 解压安装通道。
        // 传入可复现的来源地址（skill.repository.url，通常是平台技能页/仓库地址），
        // 避免安装后用会过期的预签名直链作唯一溯源信息。
        if (skill.downloadUrl) {
            return this.installSkillFromZip(skill.downloadUrl, skill.name, clients, {
                repositoryUrl: skill.repository?.url,
            });
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
    async installSkillFromZip(
        downloadUrl: string,
        skillName: string,
        clients: SkillClientType[],
        /**
         * 可选来源标识：平台源（如虾评）应传平台侧 id、详情页/接口地址与分支，
         * 否则 .source.json 只能记录会过期的临时直链，无法溯源与更新。
         */
        source?: { id?: string; repositoryUrl?: string; branch?: string }
    ): Promise<SkillInstallResult> {
        const name = skillName.split('/').pop() || skillName;
        // 每次安装使用独立工作子目录（父目录固定、子目录用随机 token 区分）。
        // 旧实现所有安装共用同一 tmpRoot 且 finally 无条件 rm -rf，并发/重试时先结束的一次
        // 会删掉另一次仍在使用的解压文件，导致安装失败或内容残缺——必须隔离。
        const installRoot = path.join(os.tmpdir(), 'mcp-dock-ms-install');
        const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const workDir = path.join(installRoot, token);
        const extractDir = path.join(workDir, 'extract');

        try {
            await fs.mkdir(workDir, {recursive: true});

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

            // 2) 解压：改用项目自带的纯 Node 解包器 extractZipEntries（archive.ts）——零第三方依赖、跨平台。
            //    不再 shell out 到外部 `tar` / `powershell Expand-Archive`：
            //    ① 依赖 PATH 中的 tar（本机 /usr/bin/tar 1.35 根本读不了 ZIP，白跑一次再回退，慢且偶发失败）；
            //    ② 无 PowerShell 的平台（Linux）会必然解压失败，是产品缺陷；
            //    ③ 外部进程在并行安装时受资源争用，是测试 flaky 的根因。
            await fs.mkdir(extractDir, {recursive: true});
            const writtenCount = await extractZipToDir(buf, extractDir);
            if (writtenCount === 0) {
                return {
                    success: false,
                    error: '压缩包内没有可解压的文件。',
                };
            }

            // 3) 定位真正的 skill 根目录：zip 常带顶层外壳目录（如 skills/<owner>/<slug>/SKILL.md
            //    或单 <slug>/SKILL.md），需递归找到含 SKILL.md 的目录，否则整体 cp 会把 SKILL.md
            //    放到 skillPath/skills/.../SKILL.md，客户端按 <skillDir>/SKILL.md 扫描会读不到。
            const skillRoot = await findSkillRootDir(extractDir);

            // 3.1) 记录「实际装入的文件清单」（相对 skillRoot，/ 分隔）。
            //      旧实现写死 files: []，导致「我的库」详情页看不到任何附属文件、也无法据此校验完整性。
            const installedFiles = await collectRelativeFiles(skillRoot);

            // 3.2) 解析可复现的来源信息：分支不再臆造 'master'，预签名直链不再持久化为 rawBaseUrl。
            //      仅当来源可解析为 GitHub 仓库时才去取真实默认分支（其它平台无 Git 语义，留空）。
            const repoUrl = source?.repositoryUrl ?? '';
            let branch = source?.branch ?? '';
            if (!branch && repoUrl && /github\.com/i.test(repoUrl)) {
                const parsedRepo = githubParseGitHubUrl(repoUrl);
                if (parsedRepo) {
                    branch = parsedRepo.branch || await getDefaultBranch(parsedRepo.owner, parsedRepo.repo);
                }
            }

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
                        id: source?.id || name,
                        installedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        source: {
                            // 记录可复现的平台来源页/接口地址（虾评=平台侧 skill 页）；无则留空，
                            // 绝不落回会过期的预签名直链。
                            repositoryUrl: repoUrl,
                            branch,
                            skillPath: '',
                            // 预签名 zip 直链会过期（实测 sign 参数约 1 小时后失效），不能作为持久化
                            // rawBaseUrl；zip 通道的文件清单已固化在 files 字段，更新需重新解析来源，故留空。
                            rawBaseUrl: '',
                        },
                        files: installedFiles,
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
            // 只删本次安装自己的子目录，避免并发安装互删
            await fs.rm(workDir, {recursive: true, force: true}).catch(() => {
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
        byClient: Record<string, InstalledSkill[]>;
    }> {
        await this.loadSettings();
        const skills: Record<string, { name: string; clients: SkillClientType[] }> = {};
        // 由全量技能客户端（内置 + 自定义 supportsSkills）派生，键集合与扫描范围始终一致
        const byClient = Object.fromEntries(
            this.getSkillClientIds().map(c => [c, [] as InstalledSkill[]])
        ) as Record<string, InstalledSkill[]>;

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
            // 目标与源同一物理目录时跳过（如 trae-cn / trae-solo-cn 共用目录），避免自删源数据
            if (path.resolve(targetPath) === path.resolve(sourcePath)) continue;
            // P2-6：先拷到同目录临时名，再删旧目标 + 原子重命名，避免先删后拷中途失败丢失目标数据
            const tmpPath = path.join(targetSkillsPath, `.${skillName}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            try {
                await this.ensureSkillsDir(client);
                await copyDir(sourcePath, tmpPath);
                await fs.rm(targetPath, {recursive: true, force: true});
                await fs.rename(tmpPath, targetPath);
                success.push(client);
            } catch (err) {
                await fs.rm(tmpPath, {recursive: true, force: true}).catch(() => {});
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
