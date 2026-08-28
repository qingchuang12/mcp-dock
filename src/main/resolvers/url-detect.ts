/**
 * 平台 Skill 解析器 —— URL 检测与 HTML 提取。
 * 子策略：detection / 从 HTML 提取 github 链接、仓库路径、内联 JSON、直链；
 * 以及入口函数 resolvePlatformSkillUrl（见原 platform-skill-resolver.ts 策略 1~5）。
 */

import {DiscoveredSkill, SkillsManager} from '../skills-manager';
import type {ResolvePlatformResult, SupportedPlatform} from './types';
import {PLATFORM_NAMES, UA} from './types';
import {resolveZipSkill} from './install-zip';
import {CLAWHUB_DOWNLOAD_BASE} from './clawhub';

/**
 * 判断 URL 属于哪个平台
 */
export function detectPlatform(url: string): SupportedPlatform {
    const u = url.toLowerCase();
    if (u.includes('modelscope.cn')) return 'modelscope';
    if (u.includes('safeskill.cn')) return 'safeskill';
    if (u.includes('skillhub.cn')) return 'skillhub';
    if (u.includes('skillsmp.com')) return 'skillsmp';
    if (u.includes('clawhub.ai')) return 'clawhub';
    return 'unknown';
}

/**
 * 从 ClawHub 的 skill 详情 URL 中提取 slug。
 * 详情页形态：/<owner>/skills/<slug> 或 /skills/<owner>/<slug> 或 /api/v1/skills/<slug>，
 * slug 始终为路径最后一段（如 tavily）。无 slug 时返回 ''。
 */
function extractClawhubSlug(url: string): string {
    try {
        const u = new URL(url);
        const seg = u.pathname.split('/').filter(Boolean);
        const slug = seg[seg.length - 1] ?? '';
        return /^[A-Za-z0-9._-]+$/.test(slug) ? slug : '';
    } catch {
        return '';
    }
}

/**
 * 从一段 HTML 中提取所有 github.com 仓库链接（去重）
 */
function extractGithubUrls(html: string): string[] {
    const urls = new Set<string>();
    // 标准仓库链接
    const repoRe = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
    let m: RegExpExecArray | null;
    while ((m = repoRe.exec(html)) !== null) {
        // 去掉尾部可能的 /tree/、/blob/ 等，保留 owner/repo 主体（parseImportUrl 也能处理带子路径的）
        urls.add(m[0]);
    }
    return [...urls];
}

/**
 * 从文本中提取 “仓库: owner/repo” / “repo: owner/repo” 形态的 GitHub 路径。
 * 主要用于 SkillsMP 这类 SSR 页面（直接展示仓库路径而非链接）。
 */
export function extractRepoPaths(text: string): string[] {
    const repos = new Set<string>();
    const re = /(?:仓库|repo|repository)\s*[:：]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        repos.add(m[1].trim());
    }
    return [...repos];
}

/**
 * 将一组 owner/repo 或 github URL 归一化为 https://github.com/owner/repo
 */
function toGithubUrl(repoOrUrl: string): string {
    if (/^https?:\/\//i.test(repoOrUrl)) return repoOrUrl;
    return `https://github.com/${repoOrUrl}`;
}

/**
 * 从内联 JSON 脚本（window.__X__ = {...}）中提取文本，用于二次搜索 github 链接
 */
function extractInlineJson(html: string): string {
    const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    let collected = '';
    for (const s of scripts) {
        if (/window\.__|self\.__|__NEXT_DATA__|__remixContext|__INITIAL_STATE__/.test(s)) {
            collected += s + '\n';
        }
    }
    return collected;
}

/**
 * 提取 SKILL.md / raw / zip 等可能的直链
 */
function extractDirectLinks(html: string): string[] {
    const links: string[] = [];
    const re = /https?:\/\/[^\s"'<>]+?\.(?:md|zip)(?:\?[^\s"'<>]*)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        links.push(m[0]);
    }
    // 也匹配常见的 raw 托管（如 raw.githubusercontent / gitee / 对象存储）
    const rawRe = /https?:\/\/(?:raw\.githubusercontent\.com|gitee\.com|[^"'<>]+\/raw\/)[^\s"'<>]+/gi;
    while ((m = rawRe.exec(html)) !== null) {
        links.push(m[0]);
    }
    return links;
}

/**
 * 解析平台 skill 页面 URL → 可安装的 Skill 信息
 *
 * 兼容两类输入：
 *  - 列表页（如 SkillsMP 的 /zh/skills）：返回页面中包含的多个仓库对应的 Skill；
 *  - 详情页（各平台单个 skill）：返回该 skill 对应的源。
 */
export async function resolvePlatformSkillUrl(
    skillsManager: SkillsManager,
    url: string
): Promise<ResolvePlatformResult> {
    const platform = detectPlatform(url);

    if (platform === 'unknown') {
        // 不是受支持的平台，交由 GitHub 解析器处理（兼容原有行为）
        const fallback = await skillsManager.parseImportUrl(url);
        return {...fallback, platform: 'unknown', resolvedVia: fallback.success ? 'github' : 'unknown'};
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let html = '';
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
            signal: controller.signal,
        });
        if (res.ok) {
            html = await res.text();
        }
    } catch {
        // 网络错误继续走下方兜底
    } finally {
        clearTimeout(timer);
    }

    // SkillsMP：SSR 页面直接展示 “仓库: owner/repo”，优先按列表批量解析
    if (platform === 'skillsmp') {
        const repoPaths = extractRepoPaths(html || url);
        if (repoPaths.length > 0) {
            const merged: DiscoveredSkill[] = [];
            let lastError = '';
            for (const repo of repoPaths) {
                const ghUrl = toGithubUrl(repo);
                try {
                    const r = await skillsManager.parseImportUrl(ghUrl);
                    if (r.success && r.skills.length > 0) merged.push(...r.skills);
                    else if (r.error) lastError = r.error;
                } catch {
                    // 单个解析失败不影响其它
                }
            }
            if (merged.length > 0) {
                return {success: true, skills: merged, platform, resolvedVia: 'list'};
            }
            if (lastError) {
                return {success: false, skills: [], platform, resolvedVia: 'list', error: lastError};
            }
        }
    }

    // ClawHub 原生 skill：SPA 详情页抓不到源（GitHub 链接也非真实仓库），改用站内 zip 直链。
    // 详情页形态为 /<owner>/skills/<slug> 或 /api/v1/skills/<slug>，slug 均为路径最后一段；
    // 下载通道 https://clawhub.ai/api/v1/download?slug=<slug> 实测返回 application/zip（含 SKILL.md）。
    if (platform === 'clawhub') {
        const slug = extractClawhubSlug(url);
        if (slug) {
            const downloadUrl = `${CLAWHUB_DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}`;
            const zipResult = await resolveZipSkill(skillsManager, downloadUrl, platform);
            // 成功直接返回；下载/解压失败则携带明确错误（resolvedVia 复用 'zip' 标记，platform 标 clawhub）
            if (zipResult.success || zipResult.resolvedVia === 'zip') {
                return zipResult;
            }
        }
    }

    // 策略 2a：HTML 或内联 JSON 中的 GitHub 仓库链接
    const inlineJson = extractInlineJson(html);
    const githubUrls = [
        ...extractGithubUrls(html),
        ...extractGithubUrls(inlineJson),
    ];

    // 策略 2a'：HTML/内联 JSON 中的 “仓库: owner/repo” 路径（兜底，覆盖未渲染为链接的情况）
    const repoPaths = extractRepoPaths(html || '') || extractRepoPaths(inlineJson || '');
    for (const repo of repoPaths) {
        const gh = toGithubUrl(repo);
        if (!githubUrls.includes(gh)) githubUrls.push(gh);
    }

    if (githubUrls.length > 0) {
        // 批量尝试，返回所有成功解析的 Skill（支持详情页 + 列表页）
        const merged: DiscoveredSkill[] = [];
        let lastError = '';
        for (const gh of githubUrls) {
            try {
                const ghResult = await skillsManager.parseImportUrl(gh);
                if (ghResult.success && ghResult.skills.length > 0) {
                    merged.push(...ghResult.skills);
                } else if (ghResult.error) {
                    lastError = ghResult.error;
                }
            } catch {
                // 单个链接解析失败不影响其它
            }
        }
        if (merged.length > 0) {
            return {success: true, skills: merged, platform, resolvedVia: 'github'};
        }
        if (lastError) {
            // GitHub 解析失败（如该链接不是 skill 仓库），继续尝试直链
            // 仅保留错误用于后续兜底提示
        }
    }

    // 策略 2b：直链（SKILL.md / zip / raw）
    const directLinks = extractDirectLinks(html);
    const skillMd = directLinks.find(l => l.toLowerCase().endsWith('.md'));
    const zip = directLinks.find(l => l.toLowerCase().endsWith('.zip'));

    if (skillMd) {
        const discovered: DiscoveredSkill = {
            name: skillMd.split('/').filter(Boolean).pop()?.replace(/\.md$/, '') || 'skill',
            path: '',
            skillMdUrl: skillMd,
            skillMdContent: '',
            files: [{name: 'SKILL.md', path: 'SKILL.md', rawUrl: skillMd}],
            repository: {url, branch: '', owner: platform, repo: 'skill'},
        };
        return {
            success: true,
            skills: [discovered],
            platform,
            resolvedVia: 'direct-skill-md',
        };
    }

    if (zip) {
        // zip 需要下载后解压，当前安装通道面向 SKILL.md 目录；返回明确提示
        return {
            success: false,
            skills: [],
            platform,
            resolvedVia: 'zip',
            error:
                'Detected a zip download link but the installer requires a SKILL.md-based source. ' +
                'Please paste the GitHub repository URL of this skill instead.',
        };
    }

    // 全部策略失败：给出可操作的错误提示
    return {
        success: false,
        skills: [],
        platform,
        resolvedVia: 'unknown',
        error:
            `Could not extract a downloadable skill source from ${PLATFORM_NAMES[platform]}. ` +
            `The page may load its data dynamically (SPA) or require login. ` +
            `Tip: open the skill page in your browser, find the "GitHub" / "Source" / "Download" link, ` +
            `and paste that URL here here instead.`,
    };
}

