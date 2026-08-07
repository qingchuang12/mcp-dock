/**
 * Skill 简介的解析与多语言择优。
 *
 * 回归背景：详情页原先用单行正则解析 SKILL.md frontmatter，遇到块标量写法
 * （`description: >`）会解析成字面量 ">"，导致「列表有简介、点进详情空白」。
 */
import {describe, expect, it} from 'vitest';
import {parseFrontmatter} from '../shared/frontmatter';
import {pickSkillDescription} from '../renderer/src/lib/localizedText';

const blockScalar = `---\nname: diagram\ndescription: >\n  Create architecture diagrams\n  and flowcharts.\nlicense: MIT\n---\n\n# Body\n`;
const bom = `\uFEFF---\r\ndescription: "Quoted intro"\r\n---\r\nbody`;
const zhFm = `---\ndescription: 用于生成架构图的技能\ndescription_en: Generate architecture diagrams\n---\n`;

describe('frontmatter', () => {
    it('block scalar', () => {
        expect(parseFrontmatter(blockScalar).description).toBe('Create architecture diagrams and flowcharts.');
    });
    it('bom + crlf + quotes', () => {
        expect(parseFrontmatter(bom).description).toBe('Quoted intro');
    });
});

describe('pickSkillDescription', () => {
    it('zh ui prefers zh locale over en frontmatter', () => {
        expect(
            pickSkillDescription('zh', {
                frontmatter: parseFrontmatter(blockScalar),
                locales: {zh: '创建架构图与流程图'},
                primary: 'Create architecture diagrams',
            })
        ).toBe('创建架构图与流程图');
    });
    it('en ui prefers en frontmatter', () => {
        expect(
            pickSkillDescription('en', {
                frontmatter: parseFrontmatter(blockScalar),
                locales: {zh: '创建架构图与流程图'},
            })
        ).toBe('Create architecture diagrams and flowcharts.');
    });
    it('en ui falls back to only-available zh', () => {
        expect(pickSkillDescription('en', {locales: {zh: '只有中文'}})).toBe('只有中文');
    });
    it('zh ui falls back to en when no zh', () => {
        expect(pickSkillDescription('zh-CN', {primary: 'English only'})).toBe('English only');
    });
    it('zh ui picks zh frontmatter over en variant', () => {
        expect(pickSkillDescription('zh', {frontmatter: parseFrontmatter(zhFm)})).toBe('用于生成架构图的技能');
    });
    it('en ui picks description_en variant', () => {
        expect(pickSkillDescription('en', {frontmatter: parseFrontmatter(zhFm)})).toBe('Generate architecture diagrams');
    });
    it('empty when nothing available', () => {
        expect(pickSkillDescription('zh', {primary: '   '})).toBe('');
    });
});
