/**
 * deriveSkillMdRawUrl 单测（G1）
 *
 * 背景：zip / 平台压缩包通道安装的 skill 其 .source.json 中 rawBaseUrl 恒为空串；
 * 旧组件以 `${rawBaseUrl}/SKILL.md` 拼接会得到 truthy 的 '/SKILL.md' 死链。
 * 该函数收口「只有 rawBaseUrl 非空才给出外链」的判定。
 */
import {describe, expect, it} from 'vitest';
import {deriveSkillMdRawUrl} from '../renderer/src/lib/skillMdUrl';

describe('deriveSkillMdRawUrl', () => {
    it('空串 → undefined（不产出 /SKILL.md 死链）', () => {
        expect(deriveSkillMdRawUrl('')).toBeUndefined();
    });

    it('undefined → undefined', () => {
        expect(deriveSkillMdRawUrl(undefined)).toBeUndefined();
    });

    it('纯空白 → undefined', () => {
        expect(deriveSkillMdRawUrl('   ')).toBeUndefined();
        expect(deriveSkillMdRawUrl('\t\n ')).toBeUndefined();
    });

    it('正常 GitHub raw 基址 → 追加 /SKILL.md', () => {
        expect(deriveSkillMdRawUrl('https://raw.githubusercontent.com/owner/repo/main/skills/demo'))
            .toBe('https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md');
    });
});
