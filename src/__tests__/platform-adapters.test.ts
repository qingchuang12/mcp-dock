/**
 * 测试2（第三批）：各平台 adapter 的映射函数单测。
 * 喂缺字段 / 空 payload / 畸形对象，断言不抛错且返回结构稳定（防 P2-13）。
 */
import {describe, it, expect} from 'vitest';
import {mapEntry as mapClawhub} from '../main/platforms/clawhub';
import {mapEntry as mapSkillhub} from '../main/platforms/skillhub';
import {mapEntry as mapSkillsmp} from '../main/platforms/skillsmp';
import {mapSkill, mapMCPServer} from '../main/platforms/modelscope';
import {mapServer} from '../main/platforms/bailian';

// 各类缺字段 / 空 / 畸形的 raw 对象输入，均不应抛出
// （调用方始终传入对象，null/undefined 不在契约内，故不测）
const NASTY_INPUTS = [{}, {unknownField: 'x'}, {id: ''}, {slug: null}, {native: {skill: {categories: null}}}];

describe('clawhub.mapEntry', () => {
    it('缺字段不抛错，id 兜底为空串', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapClawhub(raw)).not.toThrow();
        }
        const item = mapClawhub({});
        expect(item.source).toBe('clawhub');
        expect(typeof item.id).toBe('string');
        expect(item.downloadUrl).toContain('clawhub');
    });

    it('正常字段映射', () => {
        const item = mapClawhub({slug: 'foo', displayName: 'Foo', summary: 'desc'});
        expect(item.id).toBe('foo');
        expect(item.name).toBe('Foo');
        expect(item.description).toBe('desc');
    });
});

describe('skillhub.mapEntry', () => {
    it('缺字段不抛错', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapSkillhub(raw)).not.toThrow();
        }
        const item = mapSkillhub({});
        expect(item.source).toBe('skillhub');
        expect(item.sourceUrl).toContain('skillhub.cn');
    });
});

describe('skillsmp.mapEntry', () => {
    it('缺字段不抛错，category 可用请求级回填', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapSkillsmp(raw, 'cat')).not.toThrow();
        }
        const item = mapSkillsmp({}, 'cat');
        expect(item.source).toBe('skillsmp');
        expect(item.category).toBe('cat');
    });
});

describe('modelscope.mapSkill / mapMCPServer', () => {
    it('mapSkill 缺字段不抛错', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapSkill(raw)).not.toThrow();
        }
        const item = mapSkill({});
        expect(item.source).toBe('modelscope');
        expect(item.sourceUrl).toContain('modelscope.cn');
    });

    it('mapMCPServer 缺字段不抛错', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapMCPServer(raw)).not.toThrow();
        }
        const item = mapMCPServer({});
        expect(item.source).toBe('modelscope');
        expect(item.categories).toEqual([]);
        expect(item.tags).toEqual([]);
    });
});

describe('bailian.mapServer', () => {
    it('缺字段不抛错，id 由 source/serverName/idx 组成', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapServer(raw, 0)).not.toThrow();
        }
        const item = mapServer({serverName: 'svc', source: 'ALIYUN'}, 3);
        expect(item.id).toBe('ALIYUN-svc-3');
        expect(item.isVerified).toBe(true);
        expect(item.source).toBe('bailian');
    });
});
