/**
 * 测试2（第三批）：各平台 adapter 的映射函数单测。
 * 喂缺字段 / 空 payload / 畸形对象，断言不抛错且返回结构稳定（防 P2-13）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {clawhubAdapter, mapEntry as mapClawhub} from '../main/platforms/clawhub';
import {mapEntry as mapSkillhub} from '../main/platforms/skillhub';
import {mapEntry as mapSkillsmp} from '../main/platforms/skillsmp';
import {mapMCPServer, mapSkill} from '../main/platforms/modelscope';
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
    it('缺字段不抛错，id 采用稳定编码且与下标无关', () => {
        for (const raw of NASTY_INPUTS) {
            expect(() => mapServer(raw, 0)).not.toThrow();
        }
        const item = mapServer({serverName: 'svc', source: 'ALIYUN'}, 3);
        expect(item.id).toBe('bailian:ALIYUN:svc');
        // id 不再依赖切片下标（翻页/排序/过滤后详情仍可回查）
        expect(mapServer({serverName: 'svc', source: 'ALIYUN'}, 0).id).toBe(item.id);
        expect(mapServer({serverName: 'svc', source: 'ALIYUN'}, 99).id).toBe(item.id);
        expect(item.isVerified).toBe(true);
        expect(item.source).toBe('bailian');
    });
});

/** 模拟一次成功的 Convex RPC 响应（path=search:searchSkills，value 为数组）。 */
function convexResponse(items: unknown[]) {
    return {
        ok: true,
        status: 200,
        json: async () => ({status: 'success', value: items}),
    };
}

describe('clawhub 运行时离线缓存（替代写死静态索引）', () => {
    let tmp: string;
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhub-cache-'));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        globalThis.fetch = realFetch;
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    it('在线成功累积缓存，断网后回退到累积的离线索引', async () => {
        const params = {query: 'a', page: 1, pageSize: 20, baseUrl: '', cacheDir: tmp};

        vi.stubGlobal('fetch', vi.fn(async () => convexResponse([
            {slug: 's1', name: 'S1', summary: 'desc1'},
            {slug: 's2', name: 'S2', summary: 'desc2'},
        ])));
        const online = await clawhubAdapter.searchSkills!(params);
        expect(online.items).toHaveLength(2);

        // 缓存文件已写入，条目按 id 去重
        const cacheFile = path.join(tmp, 'clawhub', 'offline-index.json');
        expect(fs.existsSync(cacheFile)).toBe(true);
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        expect(cached.skills).toHaveLength(2);

        // 断网后回退到累积缓存
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const offline = await clawhubAdapter.searchSkills!(params);
        expect(offline.items.map(i => i.id).sort()).toEqual(['s1', 's2']);
        expect(offline.complete).toBe(true);
    });

    it('重复累积按 id 去重，新条目覆盖旧条目', async () => {
        const cacheDir = path.join(tmp, 'clawhub');
        fs.mkdirSync(cacheDir, {recursive: true});
        fs.writeFileSync(path.join(cacheDir, 'offline-index.json'), JSON.stringify({
            skills: [{slug: 's1', name: 'Old', summary: 'old-desc'}],
        }), 'utf8');

        vi.stubGlobal('fetch', vi.fn(async () => convexResponse([
            {slug: 's1', name: 'S1', summary: 'new-desc'},
            {slug: 's2', name: 'S2', summary: 'desc2'},
        ])));
        await clawhubAdapter.searchSkills!({query: 'a', page: 1, pageSize: 20, baseUrl: '', cacheDir: tmp});

        const cached = JSON.parse(fs.readFileSync(path.join(tmp, 'clawhub', 'offline-index.json'), 'utf8'));
        expect(cached.skills).toHaveLength(2);
        const s1 = cached.skills.find((s: {slug: string}) => s.slug === 's1');
        expect(s1.summary).toBe('new-desc');
    });
});
