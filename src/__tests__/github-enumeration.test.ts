/**
 * GitHub 目录枚举健壮性测试（弱网抖动场景）
 *
 * 背景：本机到 api.github.com 存在约 33% 的间歇性失败（`TypeError: fetch failed`），
 * 旧的「多目录串行请求 + catch 静默吞错」把网络抖动放大成安装失败，并把「请求失败」
 * 伪装成「目录为空」。这里用注入的 fetchImpl 覆盖以下要点（**不依赖真实网络**）：
 *   1) 枚举请求失败必须抛错/标记失败，绝不返回空数组被当成「空目录」
 *   2) 网络类错误指数退避重试生效（第 1 次失败、第 2 次成功 → 最终成功）
 *   3) HTTP 4xx 属确定性错误，不重试
 *   4) trees 响应 truncated=true 时回退到递归枚举
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    fetchGitHubTree,
    findSkillDirsEx,
    githubFetchWithRetry,
    GitHubHttpError,
    isRetryableNetworkError,
    listDirFiles,
} from '../main/github';

/** 构造一个最小可用的 Response 替身（只提供被调用到的方法） */
function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** 网络层失败（Node fetch 在 DNS/TCP 失败时的典型形态） */
function fetchFailed(): never {
    throw new TypeError('fetch failed');
}

beforeEach(() => {
    // 兜底：任何未被注入 fetchImpl 的请求（如 listDirFiles 的 HTML 兜底）都快速失败，
    // 避免测试意外打到真实网络。
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => fetchFailed()));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ===================== githubFetchWithRetry =====================

describe('githubFetchWithRetry', () => {
    it('网络抖动：首次失败、第二次成功 → 最终成功（重试生效）', async () => {
        const impl = vi.fn()
            .mockImplementationOnce(() => fetchFailed())
            .mockResolvedValueOnce(jsonResponse({ok: 1}));

        const res = await githubFetchWithRetry('https://api.github.com/x', {
            retryDelaysMs: [1], // 1 次重试，1ms 退避
            fetchImpl: impl,
        });

        expect(res.status).toBe(200);
        expect(impl).toHaveBeenCalledTimes(2);
    });

    it('HTTP 404 属确定性错误 → 不重试，直接抛 GitHubHttpError', async () => {
        const impl = vi.fn().mockResolvedValue(jsonResponse({message: 'Not Found'}, 404));

        await expect(
            githubFetchWithRetry('https://api.github.com/x', {
                retryDelaysMs: [1, 1, 1], // 即便给了重试预算也不该消耗
                fetchImpl: impl,
            })
        ).rejects.toBeInstanceOf(GitHubHttpError);

        expect(impl).toHaveBeenCalledTimes(1);
    });

    it('HTTP 403 不重试（限流/无权限为确定性失败）', async () => {
        const impl = vi.fn().mockResolvedValue(jsonResponse({message: 'API rate limit exceeded'}, 403));

        await expect(
            githubFetchWithRetry('https://api.github.com/x', {
                retryDelaysMs: [1, 1, 1],
                fetchImpl: impl,
            })
        ).rejects.toMatchObject({status: 403});

        expect(impl).toHaveBeenCalledTimes(1);
    });

    it('网络错误持续失败 → 抛最后一个错误，重试次数 = 退避序列长度', async () => {
        const impl = vi.fn().mockImplementation(() => fetchFailed());

        await expect(
            githubFetchWithRetry('https://api.github.com/x', {
                retryDelaysMs: [1, 1],
                fetchImpl: impl,
            })
        ).rejects.toThrow('fetch failed');

        // 首次 + 2 次重试
        expect(impl).toHaveBeenCalledTimes(3);
    });
});

// ===================== isRetryableNetworkError =====================

describe('isRetryableNetworkError', () => {
    it('TypeError: fetch failed / AbortError / ECONNRESET 判为可重试', () => {
        expect(isRetryableNetworkError(new TypeError('fetch failed'))).toBe(true);
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        expect(isRetryableNetworkError(abort)).toBe(true);
        expect(isRetryableNetworkError(new Error('read ECONNRESET'))).toBe(true);
    });

    it('HTTP 状态错误 / 未知错误判为不可重试', () => {
        expect(isRetryableNetworkError(new GitHubHttpError(404, 'x'))).toBe(false);
        expect(isRetryableNetworkError(new Error('boom'))).toBe(false);
        expect(isRetryableNetworkError(undefined)).toBe(false);
    });

    it('原因藏在 err.cause 时也能识别（Node fetch 常见形态）', () => {
        const err = new TypeError('fetch failed');
        (err as any).cause = {code: 'ETIMEDOUT'};
        expect(isRetryableNetworkError(err)).toBe(true);
    });
});

// ===================== fetchGitHubTree =====================

describe('fetchGitHubTree', () => {
    it('返回 path / blobPaths / truncated', async () => {
        const impl = vi.fn().mockResolvedValue(jsonResponse({
            truncated: false,
            tree: [
                {path: 'a/SKILL.md', type: 'blob'},
                {path: 'a', type: 'tree'},
                {path: 'a/ref/x.md', type: 'blob'},
            ],
        }));

        const tree = await fetchGitHubTree('o', 'r', 'main', {fetchImpl: impl, retryDelaysMs: []});

        expect(tree.paths).toEqual(['a/SKILL.md', 'a', 'a/ref/x.md']);
        expect(tree.blobPaths).toEqual(['a/SKILL.md', 'a/ref/x.md']);
        expect(tree.truncated).toBe(false);
    });

    it('truncated=true 如实透出，交由调用方回退', async () => {
        const impl = vi.fn().mockResolvedValue(jsonResponse({truncated: true, tree: []}));
        const tree = await fetchGitHubTree('o', 'r', 'main', {fetchImpl: impl, retryDelaysMs: []});
        expect(tree.truncated).toBe(true);
    });
});

// ===================== listDirFiles =====================

describe('listDirFiles（trees 优先 + 失败传播 + truncated 回退）', () => {
    it('trees 单请求成功 → 按 dirPath 前缀过滤出相对子路径', async () => {
        const impl = vi.fn().mockResolvedValue(jsonResponse({
            truncated: false,
            tree: [
                {path: 'skills/foo/SKILL.md', type: 'blob'},
                {path: 'skills/foo/ref/a.md', type: 'blob'},
                {path: 'skills/bar/SKILL.md', type: 'blob'},
            ],
        }));

        const files = await listDirFiles('o', 'r', 'main', 'skills/foo', {fetchImpl: impl, retryDelaysMs: []});

        expect(files.map(f => f.name).sort()).toEqual(['SKILL.md', 'ref/a.md']);
        // name/path 均为「相对 dirPath 的子路径」，rawUrl 命中正确 raw 地址
        expect(files.find(f => f.name === 'ref/a.md')!.rawUrl)
            .toBe('https://raw.githubusercontent.com/o/r/main/ref/a.md');
        expect(impl).toHaveBeenCalledTimes(1); // 关键：单请求，不再逐目录串行
    });

    it('trees 失败 → 回退 Contents 递归，且相对路径正确', async () => {
        const impl = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/git/trees/')) return fetchFailed();
            if (url.includes('/contents/skills/foo?ref=main')) {
                return jsonResponse([
                    {name: 'SKILL.md', type: 'file'},
                    {name: 'sub', type: 'dir'},
                ]);
            }
            if (url.includes('/contents/skills/foo/sub?ref=main')) {
                return jsonResponse([{name: 'b.md', type: 'file'}]);
            }
            throw new Error(`unexpected url: ${url}`);
        });

        const files = await listDirFiles('o', 'r', 'main', 'skills/foo', {fetchImpl: impl, retryDelaysMs: []});
        expect(files.map(f => f.name).sort()).toEqual(['SKILL.md', 'sub/b.md']);
    });

    it('trees truncated=true → 回退到 Contents 递归（不把不完整树当结果）', async () => {
        const impl = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/git/trees/')) return jsonResponse({truncated: true, tree: [{path: 'x', type: 'blob'}]});
            if (url.includes('/contents/skills/foo?ref=main')) {
                return jsonResponse([{name: 'SKILL.md', type: 'file'}]);
            }
            throw new Error(`unexpected url: ${url}`);
        });

        const files = await listDirFiles('o', 'r', 'main', 'skills/foo', {fetchImpl: impl, retryDelaysMs: []});
        expect(files.map(f => f.name)).toEqual(['SKILL.md']);
    });

    it('全部枚举失败 → 抛错（绝不静默返回空数组被当成「空目录」）', async () => {
        const impl = vi.fn().mockImplementation(() => fetchFailed());

        await expect(
            listDirFiles('o', 'r', 'main', 'skills/foo', {fetchImpl: impl, retryDelaysMs: []})
        ).rejects.toThrow(/枚举 Skill 目录失败/);
    });
});

// ===================== findSkillDirsEx =====================

describe('findSkillDirsEx（区分「无 SKILL.md」与「枚举失败」）', () => {
    it('trees 命中 → 返回目录且 enumerationFailed=false', async () => {
        const impl = vi.fn().mockResolvedValue(jsonResponse({
            truncated: false,
            tree: [{path: 'skills/foo/SKILL.md', type: 'blob'}],
        }));

        const r = await findSkillDirsEx('o', 'r', 'main', 'skills/foo', {fetchImpl: impl, retryDelaysMs: []});
        expect(r.enumerationFailed).toBe(false);
        expect(r.dirs).toEqual(['skills/foo']);
    });

    it('全面网络失败 → enumerationFailed=true 且带原因（不谎报「无 SKILL.md」）', async () => {
        const impl = vi.fn().mockImplementation(() => fetchFailed());

        const r = await findSkillDirsEx('o', 'r', 'main', 'skills/foo', {fetchImpl: impl, retryDelaysMs: []});
        expect(r.enumerationFailed).toBe(true);
        expect(r.dirs).toEqual([]);
        expect(r.error).toBeTruthy();
    });

    it('成功枚举但确无 SKILL.md → enumerationFailed=false（«空» 与 «失败» 可区分）', async () => {
        const impl = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/git/trees/')) return jsonResponse({truncated: false, tree: []});
            if (url.includes('/search/code')) return jsonResponse({items: []});
            return jsonResponse([]); // contents 返回空数组 = 确定性为空
        });

        const r = await findSkillDirsEx('o', 'r', 'main', 'skills/foo', {fetchImpl: impl, retryDelaysMs: []});
        expect(r.enumerationFailed).toBe(false);
        expect(r.dirs).toEqual([]);
    });
});
