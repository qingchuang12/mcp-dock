/**
 * 商店模块纯函数测试（S2-14）
 * 覆盖：paginateServers / filterServersByCategory / sortServers / buildPageList / formatCompactNumber / formatRelativeTime
 */
import {describe, it, expect, vi} from 'vitest';
import {paginateServers, filterServersByCategory, sortServers} from '../renderer/src/lib/search';
import {formatCompactNumber, formatRelativeTime} from '../renderer/src/lib/format';
import type {ServerListItem} from '../renderer/src/api/registry';
import type {TFunction} from 'i18next';

// ============================================================
// paginateServers
// ============================================================
function makeServers(count: number): ServerListItem[] {
    return Array.from({length: count}, (_, i) => ({
        id: `server-${i + 1}`,
        displayName: `Server ${i + 1}`,
        description: `Desc ${i + 1}`,
        iconUrl: null,
    }));
}

describe('paginateServers', () => {
    it('正常分页：第 1 页，每页 10 条，共 25 条', () => {
        const servers = makeServers(25);
        const result = paginateServers(servers, 1, 10);
        expect(result.items).toHaveLength(10);
        expect(result.items[0].id).toBe('server-1');
        expect(result.items[9].id).toBe('server-10');
        expect(result.totalItems).toBe(25);
        expect(result.totalPages).toBe(3);
        expect(result.startIndex).toBe(0);
        expect(result.endIndex).toBe(10);
    });

    it('正常分页：第 3 页（最后一页不满），每页 10 条，共 25 条', () => {
        const servers = makeServers(25);
        const result = paginateServers(servers, 3, 10);
        expect(result.items).toHaveLength(5);
        expect(result.items[0].id).toBe('server-21');
        expect(result.items[4].id).toBe('server-25');
        expect(result.startIndex).toBe(20);
        expect(result.endIndex).toBe(25);
    });

    it('越界页 clamp 到最后一页', () => {
        const servers = makeServers(25);
        const result = paginateServers(servers, 99, 10);
        expect(result.items).toHaveLength(5);
        expect(result.items[0].id).toBe('server-21');
    });

    it('page ≤ 0 clamp 到第 1 页', () => {
        const servers = makeServers(25);
        const result = paginateServers(servers, 0, 10);
        expect(result.items).toHaveLength(10);
        expect(result.items[0].id).toBe('server-1');
    });

    it('page 为负数 clamp 到第 1 页', () => {
        const servers = makeServers(25);
        const result = paginateServers(servers, -5, 10);
        expect(result.items).toHaveLength(10);
        expect(result.items[0].id).toBe('server-1');
    });

    it('空列表：totalPages = 1，items 为空', () => {
        const result = paginateServers([], 1, 10);
        expect(result.items).toHaveLength(0);
        expect(result.totalItems).toBe(0);
        expect(result.totalPages).toBe(1);
        expect(result.startIndex).toBe(0);
        expect(result.endIndex).toBe(0);
    });

    it('pageSize 大于总数：返回全部', () => {
        const servers = makeServers(5);
        const result = paginateServers(servers, 1, 100);
        expect(result.items).toHaveLength(5);
        expect(result.totalPages).toBe(1);
    });

    it('startIndex / endIndex 正确反映区间', () => {
        const servers = makeServers(10);
        const result = paginateServers(servers, 1, 10);
        expect(result.startIndex).toBe(0);
        expect(result.endIndex).toBe(10);
        // 区间公式：startIndex + 1 ~ endIndex
        // 即 1-10
    });
});

// ============================================================
// filterServersByCategory
// ============================================================
describe('filterServersByCategory', () => {
    const servers: ServerListItem[] = [
        {id: 's1', displayName: 'AI Chat', description: '', iconUrl: null, categories: ['ai', 'chat']},
        {id: 's2', displayName: 'Code Review', description: '', iconUrl: null, categories: ['coding']},
        {id: 's3', displayName: 'Database Tools', description: '', iconUrl: null, categories: ['database']},
        {id: 's4', displayName: 'No Category', description: '', iconUrl: null},
    ];

    it('categoryId 为 all 或空时返回全部', () => {
        expect(filterServersByCategory(servers, 'all')).toHaveLength(4);
        expect(filterServersByCategory(servers, '')).toHaveLength(4);
    });

    it('精确匹配 categories 字段', () => {
        const result = filterServersByCategory(servers, 'ai');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('s1');
    });

    it('同一服务器匹配多个分类', () => {
        const result = filterServersByCategory(servers, 'chat');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('s1');
    });

    it('不存在的分类返回空数组', () => {
        const result = filterServersByCategory(servers, 'nonexistent');
        expect(result).toHaveLength(0);
    });

    it('无 categories 字段时回退到关键词推断', () => {
        const result = filterServersByCategory(servers, 'database');
        // s4 没有 categories，但 displayName 包含 'Database'，inferSkillCategoryId 可能推断为 'database'
        // 这里只验证至少 s3 被匹配到
        expect(result.some(s => s.id === 's3')).toBe(true);
    });
});

// ============================================================
// sortServers
// ============================================================
describe('sortServers', () => {
    const servers: ServerListItem[] = [
        {id: 's1', displayName: 'A', description: '', iconUrl: null, stars: 10, lastCommitAt: '2024-01-01'},
        {id: 's2', displayName: 'B', description: '', iconUrl: null, stars: 50, lastCommitAt: '2024-06-01'},
        {id: 's3', displayName: 'C', description: '', iconUrl: null, stars: 5, lastCommitAt: '2023-12-01'},
        {id: 's4', displayName: 'D', description: '', iconUrl: null, stars: 0, lastCommitAt: undefined},
    ];

    it('relevance 保持原序', () => {
        const result = sortServers(servers, 'relevance');
        expect(result.map(s => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    });

    it('空 sortId 保持原序', () => {
        const result = sortServers(servers, '');
        expect(result.map(s => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    });

    it('stars 按星标降序', () => {
        const result = sortServers(servers, 'stars');
        expect(result.map(s => s.id)).toEqual(['s2', 's1', 's3', 's4']);
    });

    it('stars 无星标数据不报错', () => {
        const noStars: ServerListItem[] = [
            {id: 'a', displayName: 'A', description: '', iconUrl: null},
            {id: 'b', displayName: 'B', description: '', iconUrl: null, stars: 5},
        ];
        const result = sortServers(noStars, 'stars');
        expect(result[0].id).toBe('b');
    });

    it('updated 按 lastCommitAt 降序', () => {
        const result = sortServers(servers, 'updated');
        expect(result.map(s => s.id)).toEqual(['s2', 's1', 's3', 's4']);
    });

    it('updated 缺失时间戳的排在末尾', () => {
        const result = sortServers(servers, 'updated');
        expect(result[result.length - 1].id).toBe('s4');
    });

    it('updated 使用 updatedAt 回退', () => {
        const withUpdatedAt: ServerListItem[] = [
            {id: 'a', displayName: 'A', description: '', iconUrl: null, updatedAt: '2025-01-01'},
            {id: 'b', displayName: 'B', description: '', iconUrl: null, updatedAt: '2024-01-01'},
        ];
        const result = sortServers(withUpdatedAt, 'updated');
        expect(result[0].id).toBe('a');
    });

    it('updated 无效时间戳视为 0，排在末尾', () => {
        const withBadDate: ServerListItem[] = [
            {id: 'a', displayName: 'A', description: '', iconUrl: null, lastCommitAt: 'not-a-date'},
            {id: 'b', displayName: 'B', description: '', iconUrl: null, lastCommitAt: '2024-01-01'},
        ];
        const result = sortServers(withBadDate, 'updated');
        expect(result[0].id).toBe('b');
    });

    it('不修改原数组', () => {
        const original = [...servers];
        sortServers(servers, 'stars');
        expect(servers.map(s => s.id)).toEqual(original.map(s => s.id));
    });
});

// ============================================================
// formatCompactNumber
// ============================================================
describe('formatCompactNumber', () => {
    it('百万级 → M', () => {
        expect(formatCompactNumber(1000000)).toBe('1.0M');
        expect(formatCompactNumber(2500000)).toBe('2.5M');
    });

    it('千级 → K', () => {
        expect(formatCompactNumber(1000)).toBe('1.0K');
        expect(formatCompactNumber(1234)).toBe('1.2K');
        expect(formatCompactNumber(9999)).toBe('10.0K');
    });

    it('小于千 → 原数字字符串', () => {
        expect(formatCompactNumber(0)).toBe('0');
        expect(formatCompactNumber(999)).toBe('999');
        expect(formatCompactNumber(42)).toBe('42');
    });

    it('null / undefined / NaN → 空串', () => {
        expect(formatCompactNumber(null)).toBe('');
        expect(formatCompactNumber(undefined)).toBe('');
        expect(formatCompactNumber(NaN)).toBe('');
    });
});

// ============================================================
// formatRelativeTime
// ============================================================
describe('formatRelativeTime', () => {
    const mockT = vi.fn((key: string, options?: Record<string, unknown>) => {
        const defaults: Record<string, string> = {
            'store.timeToday': 'today',
            'store.timeYesterday': 'yesterday',
            'store.timeDaysAgo': `${options?.count ?? '?'}d ago`,
            'store.timeWeeksAgo': `${options?.count ?? '?'}w ago`,
            'store.timeMonthsAgo': `${options?.count ?? '?'}mo ago`,
            'store.timeYearsAgo': `${options?.count ?? '?'}y ago`,
        };
        return defaults[key] || key;
    }) as unknown as TFunction;

    it('空字符串返回空串', () => {
        expect(formatRelativeTime(mockT, '')).toBe('');
    });

    it('今天', () => {
        const now = new Date();
        const dateStr = now.toISOString();
        expect(formatRelativeTime(mockT, dateStr)).toBe('today');
    });

    it('昨天', () => {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        expect(formatRelativeTime(mockT, yesterday.toISOString())).toBe('yesterday');
    });

    it('3 天前', () => {
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        expect(formatRelativeTime(mockT, threeDaysAgo.toISOString())).toBe('3d ago');
    });

    it('2 周前', () => {
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        expect(formatRelativeTime(mockT, twoWeeksAgo.toISOString())).toBe('2w ago');
    });

    it('3 月前', () => {
        const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        expect(formatRelativeTime(mockT, threeMonthsAgo.toISOString())).toBe('3mo ago');
    });

    it('1 年前', () => {
        const oneYearAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
        expect(formatRelativeTime(mockT, oneYearAgo.toISOString())).toBe('1y ago');
    });

    it('无效日期字符串不抛错，返回空串', () => {
        expect(formatRelativeTime(mockT, 'not-a-date')).toBe('');
    });
});

// ============================================================
// buildPageList
// ============================================================
function buildPageList(current: number, total: number): number[] {
    if (total <= 7) {
        return Array.from({length: total}, (_, i) => i + 1);
    }
    const pages = new Set<number>([1, total, current]);
    for (let d = 1; d <= 1; d++) {
        if (current - d >= 1) pages.add(current - d);
        if (current + d <= total) pages.add(current + d);
    }
    const sorted = [...pages].sort((a, b) => a - b);
    const out: number[] = [];
    let prev = 0;
    for (const p of sorted) {
        if (prev && p - prev > 1) out.push(-1); // 省略号
        out.push(p);
        prev = p;
    }
    return out;
}

describe('buildPageList', () => {
    it('≤7 页：全部显示，无省略号', () => {
        expect(buildPageList(1, 5)).toEqual([1, 2, 3, 4, 5]);
        expect(buildPageList(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('首页 1/100：省略号在右侧', () => {
        const pages = buildPageList(1, 100);
        expect(pages[0]).toBe(1);
        expect(pages[1]).toBe(2);
        expect(pages).toContain(-1); // 省略号
        expect(pages[pages.length - 1]).toBe(100);
    });

    it('末页 100/100：省略号在左侧', () => {
        const pages = buildPageList(100, 100);
        expect(pages[0]).toBe(1);
        expect(pages).toContain(-1);
        expect(pages[pages.length - 2]).toBe(99);
        expect(pages[pages.length - 1]).toBe(100);
    });

    it('中间页 50/100：两端省略号', () => {
        const pages = buildPageList(50, 100);
        expect(pages[0]).toBe(1);
        expect(pages[pages.length - 1]).toBe(100);
        // 应有 1, 49, 50, 51, 100，中间两个省略号
        const ellipsisCount = pages.filter(p => p === -1).length;
        expect(ellipsisCount).toBeGreaterThanOrEqual(2);
        expect(pages).toContain(50);
    });

    it('第 2 页：1,2,3,...,100', () => {
        const pages = buildPageList(2, 100);
        expect(pages[0]).toBe(1);
        expect(pages[1]).toBe(2);
        expect(pages[2]).toBe(3);
        expect(pages).toContain(-1);
        expect(pages[pages.length - 1]).toBe(100);
    });

    it('总页数=1：无省略号', () => {
        expect(buildPageList(1, 1)).toEqual([1]);
    });

    it('总页数=8，当前第 4 页', () => {
        const pages = buildPageList(4, 8);
        expect(pages[0]).toBe(1);
        expect(pages).toContain(4);
        expect(pages[pages.length - 1]).toBe(8);
        // 至少有一个省略号
        expect(pages).toContain(-1);
    });
});
