/**
 * 平台 Skill 解析器 —— zip / skills.sh 安装通道。
 * 负责把「非 GitHub 源」的 skill（平台 zip 直链、skills.sh 详情页）解析为可安装 Skill。
 */

import {execFile} from 'child_process';
import os from 'os';
import path from 'path';
import {Dirent, promises as fsp} from 'fs';
import {DiscoveredSkill, SkillsManager} from '../skills-manager';
import {parseFrontmatter} from '../../shared/frontmatter';
import type {ResolvePlatformResult, SupportedPlatform} from './types';
import {UA} from './types';
import {CLAWHUB_DOWNLOAD_BASE} from './clawhub';
import {SKILLHUB_DOWNLOAD_BASE} from './skillhub';

/** 已知的平台 zip 下载直链形态（这些 URL 直接返回 application/zip，无需再抓 HTML） */
function isZipDownloadUrl(url: string): boolean {
    return (
        /modelscope\.cn\/skills\/.+\/archive\/zip/i.test(url) ||
        url.startsWith(CLAWHUB_DOWNLOAD_BASE) ||
        url.startsWith(SKILLHUB_DOWNLOAD_BASE)
    );
}

/** skills.sh 技能详情页：https://www.skills.sh/<owner>/<repo>/<skill...> */
const SKILLS_SH_URL_RE = /^https?:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)\/(.+?)\/?$/i;

/**
 * 把 skills.sh 详情页解析为可安装 Skill。
 *
 * skills.sh 本身是 Next.js SPA，页面里只能提取到仓库根链接（如 github.com/<owner>/<repo>），
 * 拿不到 skill 在仓库中的具体子目录；而同一仓库常含几十个 skill，装错目录等于装错技能。
 * 各仓库布局也不统一（实测 prisma/skills 在根、vercel-labs/skills 在 skills/、
 * mattpocock/skills 在 skills/productivity/ 这种二级目录）。
 *
 * 因此分两步：先用 raw.githubusercontent.com 逐个 HEAD 探测常见布局（命中即返回，
 * 不消耗 api.github.com 配额）；都不中再退回整仓解析，按名字挑出目标 skill
 * （覆盖任意深度的嵌套目录）。
 */
async function resolveSkillsShSkill(
    skillsManager: SkillsManager,
    url: string,
    platform: SupportedPlatform
): Promise<ResolvePlatformResult> {
    const m = url.match(SKILLS_SH_URL_RE);
    if (!m) {
        return {success: false, skills: [], platform, resolvedVia: 'unknown', error: `无法解析 skills.sh 链接：${url}`};
    }
    const [, owner, repo, rest] = m;
    const skillName = rest.split('/').filter(Boolean).pop() || rest;

    // raw 支持 HEAD 作为 ref（等价默认分支），省掉一次 getDefaultBranch 调用
    const candidates = [
        rest,
        skillName,
        `skills/${skillName}`,
        `.claude/skills/${skillName}`,
        `.agents/skills/${skillName}`,
        `.cursor/skills/${skillName}`,
    ];
    const tried = new Set<string>();
    for (const c of candidates) {
        const rel = c.replace(/^\/+|\/+$/g, '');
        if (!rel || tried.has(rel)) continue;
        tried.add(rel);
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${rel}/SKILL.md`;
        let hit = false;
        try {
            const res = await fetch(rawUrl, {method: 'HEAD', headers: {'User-Agent': UA}, redirect: 'follow'});
            hit = res.ok;
        } catch {
            // 网络抖动不影响后续候选
        }
        if (hit) {
            const gh = await skillsManager.parseImportUrl(`https://github.com/${owner}/${repo}/tree/HEAD/${rel}`);
            if (gh.success && gh.skills.length > 0) {
                return {...gh, platform, resolvedVia: 'github'};
            }
        }
    }

    // 兜底：整仓解析后按 skill 名精确匹配（覆盖 skills/<分类>/<skill> 这类嵌套布局）
    const all = await skillsManager.parseImportUrl(`https://github.com/${owner}/${repo}`);
    if (all.success && all.skills.length > 0) {
        const key = skillName.toLowerCase();
        const matched = all.skills.filter(
            s => s.name.toLowerCase() === key || s.path.split('/').pop()?.toLowerCase() === key
        );
        return {
            success: true,
            skills: matched.length > 0 ? matched : all.skills,
            platform,
            resolvedVia: 'github',
        };
    }

    return {
        success: false,
        skills: [],
        platform,
        resolvedVia: 'unknown',
        error: all.error || `未能在 github.com/${owner}/${repo} 中定位技能 ${skillName}`,
    };
}

/**
 * 从任意平台的 zip 下载直链解析 Skill：
 * 下载 zip → 解压到临时目录 → 读取其中的 SKILL.md 作为安装内容。
 * 该通道用于无 GitHub 源的 skill，覆盖 ModelScope / ClawHub / SkillHub 的压缩包直链。
 */
async function resolveZipSkill(
    _skillsManager: SkillsManager,
    zipUrl: string,
    platform: SupportedPlatform
): Promise<ResolvePlatformResult> {
    const tmpRoot = path.join(os.tmpdir(), 'mcp-dock-ms-zip');
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const zipPath = path.join(tmpRoot, `${token}.zip`);
    const extractDir = path.join(tmpRoot, token);
    try {
        await fsp.mkdir(tmpRoot, {recursive: true});
        // 1) 下载 zip：带超时与大小上限，避免恶意/超大包耗尽磁盘（P1-16）
        const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50MB
        const dlController = new AbortController();
        const dlTimeout = setTimeout(() => dlController.abort(), 60_000);
        let buf: Buffer;
        try {
            const res = await fetch(zipUrl, {headers: {'User-Agent': UA}, signal: dlController.signal});
            if (!res.ok) {
                return {
                    success: false,
                    skills: [],
                    platform,
                    resolvedVia: 'zip',
                    error: `下载 Skill 压缩包失败：HTTP ${res.status}（${zipUrl}）`,
                };
            }
            const contentLength = Number(res.headers.get('content-length') || '0');
            if (contentLength > MAX_ZIP_BYTES) {
                return {
                    success: false,
                    skills: [],
                    platform,
                    resolvedVia: 'zip',
                    error: `Skill 压缩包过大（约 ${Math.round(contentLength / 1024 / 1024)}MB），已拒绝下载`,
                };
            }
            const chunks: Buffer[] = [];
            let total = 0;
            const body = res.body as any;
            if (body) {
                for await (const chunk of body) {
                    const c = Buffer.from(chunk);
                    total += c.length;
                    if (total > MAX_ZIP_BYTES) {
                        return {
                            success: false,
                            skills: [],
                            platform,
                            resolvedVia: 'zip',
                            error: `Skill 压缩包超过大小上限（50MB），已中断下载`,
                        };
                    }
                    chunks.push(c);
                }
                buf = Buffer.concat(chunks);
            } else {
                buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > MAX_ZIP_BYTES) {
                    return {
                        success: false,
                        skills: [],
                        platform,
                        resolvedVia: 'zip',
                        error: `Skill 压缩包超过大小上限（50MB），已拒绝下载`,
                    };
                }
            }
        } finally {
            clearTimeout(dlTimeout);
        }
        await fsp.writeFile(zipPath, buf);
        // 2) 解压（优先系统 tar，回退 PowerShell Expand-Archive）
        await fsp.mkdir(extractDir, {recursive: true});
        let extracted = false;
        try {
            await execFileAsync('tar', ['-xf', zipPath, '-C', extractDir]);
            extracted = true;
        } catch {
            try {
                await execFileAsync('powershell', [
                    '-NoProfile',
                    '-Command',
                    `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}'`,
                ]);
                extracted = true;
            } catch (e) {
                extracted = false;
            }
        }
        if (!extracted) {
            return {
                success: false,
                skills: [],
                platform,
                resolvedVia: 'zip',
                error: '解压 Skill 压缩包失败：系统缺少 tar 或 PowerShell Expand-Archive 支持。',
            };
        }
        // 3) 定位 SKILL.md（zip 可能带顶层目录，递归查找）
        const skillMdPath = await findFileRecursive(extractDir, 'SKILL.md');
        if (!skillMdPath) {
            return {
                success: false,
                skills: [],
                platform,
                resolvedVia: 'zip',
                error: '压缩包内未找到 SKILL.md，无法识别为有效 Skill。',
            };
        }
        const skillMdContent = await fsp.readFile(skillMdPath, 'utf-8');
        const fm = parseFrontmatter(skillMdContent);
        const skillName = sanitizeSkillName(
            (fm?.name as string) || path.basename(path.dirname(skillMdPath)) || 'skill'
        );
        const skill: DiscoveredSkill = {
            name: skillName,
            path: '',
            skillMdUrl: zipUrl,
            skillMdContent,
            files: [],
            repository: {
                url: zipUrl,
                branch: 'master',
                owner: (platform === 'clawhub' || platform === 'skillhub') ? platform : 'modelscope',
                repo: skillName
            },
            downloadUrl: zipUrl,
        };
        return {success: true, skills: [skill], platform, resolvedVia: 'zip'};
    } catch (e) {
        return {
            success: false,
            skills: [],
            platform,
            resolvedVia: 'zip',
            error: `解析 Skill 压缩包失败：${(e as Error).message}`,
        };
    } finally {
        // 清理临时文件（解压内容已读入内存，本地临时产物可删）
        await fsp.rm(tmpRoot, {recursive: true, force: true}).catch(() => {
        });
    }
}

/** 递归查找首个匹配文件名的绝对路径 */
async function findFileRecursive(dir: string, fileName: string): Promise<string | null> {
    let entries: Dirent[];
    try {
        entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
        return null;
    }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            const found = await findFileRecursive(full, fileName);
            if (found) return found;
        } else if (ent.name.toLowerCase() === fileName.toLowerCase()) {
            return full;
        }
    }
    return null;
}

/** 将任意字符串规范化为安全的 skill 目录名（小写、仅保留字母数字与 -_） */
function sanitizeSkillName(raw: string): string {
    const cleaned = String(raw)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_\-./]+/g, '-')
        .replace(/^[.\-]+|[.\-]+$/g, '');
    return cleaned || 'skill';
}

/** promisify execFile 简化版（无 stdout 捕获需求时） */
function execFileAsync(file: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(file, args, {windowsHide: true}, (err) => (err ? reject(err) : resolve()));
    });
}

export {isZipDownloadUrl, resolveSkillsShSkill, resolveZipSkill, SKILLS_SH_URL_RE};
