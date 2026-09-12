/**
 * 测试：ModelScope 配额窗口按资源类型拆分（D4）。
 *
 * 背景：`searchPlatformDirectPaged`（旧版直连 skill 分发，供 PlatformConnectionBrowser 使用）
 * 曾对 Skill 与 MCP 端点统一套用 `MODELSCOPE_QUOTA_PRODUCT = 100` 的窗口，
 * 导致 Skill 第 6 页起（6×20 = 120 > 100）被误判为「越界」而返回空列表 + 配额提示，
 * 表现为「ModelScope 技能列表翻不到后面的数据」。
 * 实测两套窗口相互独立：Skill 2400、MCP 100，须由 `conn.kind` 显式决定，不靠猜。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import os from 'os';
import {searchPlatformDirectPaged} from '../main/resolvers/dispatch';

// searchPlatformDirectPaged → dispatch → skills-manager → config-manager → cloud-sync-store
// 间接依赖 electron；此处以最小桩替换，避免在 node 测试环境加载真实 electron。
vi.mock('electron', () => ({
    app: {getPath: () => os.tmpdir(), isPackaged: false},
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s, 'utf8'),
        decryptString: (b: Buffer) => b.toString('utf8'),
    },
}));

const BASE = 'https://modelscope.cn';

/**
 * 构造一个命中 ModelScope skills 端点的最小成功响应。
 * total 取 2000（< skill 窗口 2400），避免触发「catalog 超上限」的末页哨兵，
 * 从而让断言只聚焦「预判是否误判越界」这一目标行为。
 */
function okResponse() {
    return {
        ok: true,
        status: 200,
        headers: {get: () => 'application/json'},
        text: async () =>
            JSON.stringify({data: {skills: [{id: 'o/r', name: 'R'}], total: 2000, page_number: 1, page_size: 20}}),
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ModelScope 配额窗口按资源类型拆分', () => {
    it('skill：page×size = 120（6×20）不被判越界（窗口 2400）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
        const res = await searchPlatformDirectPaged('modelscope', BASE, null, 'q', 6, 20, '', 'skill');
        expect(res.message).not.toBe('__QUOTA_LIMIT_EXCEED__');
        expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('mcp：page×size = 120（6×20）被判越界（窗口 100），且不发请求', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
        const res = await searchPlatformDirectPaged('modelscope', BASE, null, 'q', 6, 20, '', 'mcp');
        expect(res.message).toBe('__QUOTA_LIMIT_EXCEED__');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('skill：正好命中窗口边界 2400（120×20）仍可请求', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
        const res = await searchPlatformDirectPaged('modelscope', BASE, null, 'q', 120, 20, '', 'skill');
        expect(res.message).not.toBe('__QUOTA_LIMIT_EXCEED__');
        expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('skill：超过窗口 2420（121×20）判越界且不发请求', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
        const res = await searchPlatformDirectPaged('modelscope', BASE, null, 'q', 121, 20, '', 'skill');
        expect(res.message).toBe('__QUOTA_LIMIT_EXCEED__');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('缺省 kind 视为 skill（存量连接未传 kind 时的向后兼容）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
        const res = await searchPlatformDirectPaged('modelscope', BASE, null, 'q', 6, 20);
        expect(res.message).not.toBe('__QUOTA_LIMIT_EXCEED__');
        expect(globalThis.fetch).toHaveBeenCalled();
    });
});
