import {describe, it, expect, vi, beforeEach} from 'vitest';
import path from 'path';
import os from 'os';

vi.mock('electron', () => ({
    app: {
        getPath: (name: string) => (name === 'home'
            ? path.join(os.tmpdir(), 'sync-task-dedup-test')
            : ''),
    },
}));

const fakePush = vi.fn(async () => ({ok: true, message: 'ok'}));
const fakePull = vi.fn(async () => ({ok: true, message: 'ok'}));
vi.mock('../main/cloud-sync-service', () => ({
    getCloudSyncService: () => ({push: fakePush, pull: fakePull}),
}));

import {SyncTaskManager} from '../main/sync-task-manager';

function fresh(): SyncTaskManager {
    const mgr = new SyncTaskManager(() => {});
    // 清空可能从磁盘载入的历史，保证用例隔离
    (mgr as any).tasks = [];
    (mgr as any).persist();
    fakePush.mockClear();
    fakePull.mockClear();
    return mgr;
}

describe('SyncTaskManager 去重', () => {
    it('相同 kind+scope 的待处理任务不会重复入队', () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', '上传 MCP 配置到云端', 'mcp');
        const b = mgr.enqueue('cloud-push', '上传 MCP 配置到云端', 'mcp');
        expect(b.id).toBe(a.id);
        const same = mgr.list().filter(t => t.kind === 'cloud-push' && t.scope === 'mcp');
        expect(same.length).toBe(1);
    });

    it('不同 scope 视为不同任务，可分别入队', () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        const b = mgr.enqueue('cloud-push', 'Skills', 'skills');
        expect(b.id).not.toBe(a.id);
        expect(mgr.list().length).toBe(2);
    });

    it('已完成的任务不阻止新任务入队', async () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        a.status = 'success';
        (mgr as any).persist();
        const b = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        expect(b.id).not.toBe(a.id);
    });

    it('正在同步(running)的任务也被视为重复', () => {
        const mgr = fresh();
        const a = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        a.status = 'running';
        const b = mgr.enqueue('cloud-push', 'MCP', 'mcp');
        expect(b.id).toBe(a.id);
    });
});
