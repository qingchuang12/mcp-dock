/**
 * 测试1（第三批）：platforms/shared.ts 纯函数单测。
 * 锁定 extractPageInfo / locateArray 的行为，防止 P2-14 描述的分页静默错位。
 */
import {describe, it, expect} from 'vitest';
import {
    extractPageInfo,
    locateArray,
    pickLike,
    emptyPageInfo,
    buildUrl,
    fillTpl,
} from '../main/platforms/shared';

describe('locateArray', () => {
    it('直接返回数组', () => {
        const arr = [{id: 1}, {id: 2}];
        expect(locateArray(arr)).toBe(arr);
    });

    it('从常见包裹层定位数组', () => {
        expect(locateArray({data: {skills: [1, 2]}})).toEqual([1, 2]);
        expect(locateArray({skills: [1, 2]})).toEqual([1, 2]);
        expect(locateArray({items: [1, 2]})).toEqual([1, 2]);
        expect(locateArray({data: {list: [1, 2]}})).toEqual([1, 2]);
        expect(locateArray({data: [1, 2]})).toEqual([1, 2]);
        expect(locateArray({results: [1, 2]})).toEqual([1, 2]);
        expect(locateArray({list: [1, 2]})).toEqual([1, 2]);
    });

    it('找不到数组时返回空数组（不抛错）', () => {
        expect(locateArray({})).toEqual([]);
        expect(locateArray({data: {total: 5}})).toEqual([]);
        expect(locateArray(null)).toEqual([]);
        expect(locateArray(undefined)).toEqual([]);
    });
});

describe('extractPageInfo', () => {
    it('空响应回退到请求参数，hasMore 依据 itemCount', () => {
        const info = extractPageInfo({}, 2, 20, 0);
        expect(info.page).toBe(2);
        expect(info.pageSize).toBe(20);
        expect(info.total).toBeNull();
        expect(info.hasMore).toBe(false);
    });

    it('data.pagination 优先', () => {
        const json = {data: {pagination: {total: 100, page_size: 10, page_number: 1, total_pages: 10}}};
        const info = extractPageInfo(json, 1, 20, 10);
        expect(info.total).toBe(100);
        expect(info.pageSize).toBe(10);
        expect(info.totalPages).toBe(10);
        expect(info.hasMore).toBe(true);
    });

    it('顶层 pagination 层也可用', () => {
        const json = {pagination: {total: 45, limit: 20, page: 1, pages: 3}};
        const info = extractPageInfo(json, 1, 20, 20);
        expect(info.total).toBe(45);
        expect(info.pageSize).toBe(20);
        expect(info.totalPages).toBe(3);
        expect(info.hasMore).toBe(true);
    });

    it('用 total 与 effectiveSize 推算 totalPages 与 hasMore', () => {
        const json = {total: 25, page_size: 10, page: 1};
        const info = extractPageInfo(json, 1, 10, 10);
        expect(info.totalPages).toBe(3);
        expect(info.hasMore).toBe(true); // 1*10 < 25
    });

    it('最后一页 hasMore 为 false', () => {
        const json = {total: 25, page_size: 10, page: 3};
        const info = extractPageInfo(json, 3, 10, 5);
        expect(info.hasMore).toBe(false); // 3*10 >= 25
    });

    it('hasNext 布尔优先', () => {
        const json = {data: {pagination: {hasNext: false, total: 100}}};
        const info = extractPageInfo(json, 1, 20, 20);
        expect(info.hasMore).toBe(false);
    });

    it('itemCount 不足一页时 hasMore=false', () => {
        const info = extractPageInfo({}, 1, 20, 5);
        expect(info.hasMore).toBe(false);
    });
});

describe('pickLike', () => {
    it('仅保留含 name/title/id/slug/repo 的对象', () => {
        const arr = [
            {id: 'a'},
            {foo: 'bar'},
            {title: 't'},
            null,
            'string',
            {slug: 's'},
        ];
        expect(pickLike(arr).length).toBe(3);
    });
});

describe('emptyPageInfo', () => {
    it('返回稳定空结构', () => {
        expect(emptyPageInfo(3, 15)).toEqual({page: 3, pageSize: 15, total: 0, totalPages: 0, hasMore: false});
    });
});

describe('buildUrl / fillTpl', () => {
    it('buildUrl 处理斜杠', () => {
        expect(buildUrl('https://x.com/', '/a')).toBe('https://x.com/a');
        expect(buildUrl('https://x.com', 'a')).toBe('https://x.com/a');
    });

    it('fillTpl 替换占位符并转义', () => {
        const url = fillTpl('/s?q={q}&page={page}&size={size}', 'a b', 2, 20);
        expect(url).toContain('q=a%20b');
        expect(url).toContain('page=2');
        expect(url).toContain('size=20');
    });
});
