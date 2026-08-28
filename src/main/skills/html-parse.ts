/**
 * SKILL.md 解析与构建（frontmatter / 正文）
 *
 * 原实现位于 SkillsManager 的私有方法（parseSkillMd / buildSkillMd），
 * 现整体下沉为模块级纯函数，行为完全一致。
 */

import {parseFrontmatter} from '../../shared/frontmatter';

export interface ParsedSkillMd {
    success: boolean;
    name?: string;
    description?: string;
    body?: string;
    error?: string;
}

/**
 * 解析 SKILL.md 文本，提取 name / description / body
 */
export function parseSkillMd(text: string, fallbackName?: string): ParsedSkillMd {
    const fm = parseFrontmatter(text);
    let name = fm.name || fallbackName;
    let description = fm.description || '';
    let body = text.trim();
    const match = text.match(/^---[^\n]*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (match) {
        body = match[2].trim();
    }
    if (!name) {
        return {success: false, error: '无法识别 Skill 名称（SKILL.md 缺少 name 且无可用目录名）'};
    }
    return {success: true, name, description, body};
}

/**
 * 生成 SKILL.md 内容（YAML frontmatter + 正文），符合 Anthropic Skill 规范
 */
export function buildSkillMd(name: string, description: string, body: string): string {
    const desc = (description || '').trim();
    const frontmatter =
        `---\nname: ${name}\n` +
        `description: ${desc}\n---\n\n`;
    return frontmatter + (body || '').trim() + '\n';
}
