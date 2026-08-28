/**
 * HistoryManager 自动化测试
 * 覆盖: 备份创建、列表、恢复、差异比较、清理
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock electron 模块
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir() },
}));

import { HistoryManager } from '../main/history-manager';

let historyManager: HistoryManager;
let originalBackupDir: string;
let testBackupDir: string;

beforeEach(async () => {
  testBackupDir = path.join(os.tmpdir(), `mcp-dock-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testBackupDir, { recursive: true });

  historyManager = new HistoryManager();
  originalBackupDir = (historyManager as any).backupDir;
  (historyManager as any).backupDir = testBackupDir;
});

afterEach(async () => {
  await fs.rm(testBackupDir, { recursive: true, force: true }).catch(() => {});
});

describe('listBackups', () => {
  it('应在空目录返回空列表', async () => {
    const backups = await historyManager.listBackups();
    expect(backups).toEqual([]);
  });

  it('应正确列出备份文件', async () => {
    const backupData = {
      timestamp: '2025-01-01T00:00:00.000Z',
      clients: {
        cursor: { config: { mcpServers: { 'test-server': { command: 'node' } } }, serverCount: 1 },
      },
      skills: {},
    };
    await fs.writeFile(
      path.join(testBackupDir, 'backup-2025-01-01T00-00-00-000Z.json'),
      JSON.stringify(backupData),
      'utf-8'
    );

    const backups = await historyManager.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0].timestamp).toBe('2025-01-01T00:00:00.000Z');
    expect(backups[0].serverCount).toBe(1);
  });

  it('应忽略非备份文件', async () => {
    await fs.writeFile(path.join(testBackupDir, 'not-a-backup.txt'), 'random', 'utf-8');
    await fs.writeFile(path.join(testBackupDir, 'backup-invalid.txt'), 'not json', 'utf-8');

    const backups = await historyManager.listBackups();
    expect(backups).toEqual([]);
  });

  it('应按时间倒序排列', async () => {
    for (const ts of ['2025-01-01', '2025-06-01', '2025-03-01']) {
      const data = {
        timestamp: `${ts}T00:00:00.000Z`,
        clients: {},
        skills: {},
      };
      await fs.writeFile(
        path.join(testBackupDir, `backup-${ts}T00-00-00-000Z.json`),
        JSON.stringify(data),
        'utf-8'
      );
    }

    const backups = await historyManager.listBackups();
    expect(backups).toHaveLength(3);
    expect(backups[0].timestamp).toBe('2025-06-01T00:00:00.000Z');
    expect(backups[1].timestamp).toBe('2025-03-01T00:00:00.000Z');
    expect(backups[2].timestamp).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('getDiff (相对上一条备份)', () => {
  const writeBackup = async (ts: string, clients: Record<string, Record<string, any>>) => {
    const data = {
      timestamp: ts,
      clients: Object.fromEntries(
        Object.entries(clients).map(([id, mcpServers]) => [
          id,
          { config: { mcpServers }, serverCount: Object.keys(mcpServers).length },
        ])
      ),
      skills: {},
    };
    await fs.writeFile(
      path.join(testBackupDir, `backup-${ts.replace(/[:.]/g, '-')}.json`),
      JSON.stringify(data),
      'utf-8'
    );
  };

  it('应显示相对上一条备份的变更（安装场景）', async () => {
    // A：cursor 已有 s1；B：cursor 又装了 s2（B 是变更后的状态）
    await writeBackup('2025-01-01T00:00:00.000Z', { cursor: { 's1': { command: 'node' } } });
    await writeBackup('2025-01-02T00:00:00.000Z', {
      cursor: { 's1': { command: 'node' }, 's2': { command: 'node' } },
    });

    const diff = await historyManager.getDiff('2025-01-02T00:00:00.000Z');
    expect(diff).not.toBeNull();
    expect(diff!.added).toEqual(['s2']);       // 本次只新增了 s2
    expect(diff!.removed).toEqual([]);
    expect(diff!.modified).toEqual([]);
  });

  it('应显示相对上一条备份的变更（从某客户端移除场景）', async () => {
    // A：s1 装在 cursor + vscode；B：从 cursor 移除 s1
    await writeBackup('2025-03-01T00:00:00.000Z', {
      cursor: { 's1': { command: 'node' } },
      vscode: { 's1': { command: 'node' } },
    });
    await writeBackup('2025-03-02T00:00:00.000Z', {
      cursor: {},
      vscode: { 's1': { command: 'node' } },
    });

    const diff = await historyManager.getDiff('2025-03-02T00:00:00.000Z');
    expect(diff).not.toBeNull();
    expect(diff!.removed).toEqual(['s1']);      // 本次从 cursor 移除了 s1
    expect(diff!.added).toEqual([]);
    expect(diff!.modified).toEqual([]);
  });

  it('无更早备份时以空基线比较（全部视为新增）', async () => {
    await writeBackup('2025-04-01T00:00:00.000Z', { cursor: { 's1': { command: 'node' } } });
    const diff = await historyManager.getDiff('2025-04-01T00:00:00.000Z');
    expect(diff!.added).toEqual(['s1']);
    expect(diff!.removed).toEqual([]);
  });
});

describe('backup 去重（避免空变更历史）', () => {
  const install = (map: Record<string, Record<string, any>>) => ({
    getClientTypes: () => ['cursor'],
    getSkillsPath: () => path.join(testBackupDir, 'no-such-skills'),
    readConfig: async (client: string) => ({
      mcpServers: client === 'cursor' ? map[client] || {} : {},
    }),
  });

  it('无实际变更（重复创建已存在的 server）时应跳过、不创建空变更备份', async () => {
    (historyManager as any).configManager = install({ cursor: { 's1': { command: 'node' } } });
    const f1 = await (historyManager as any).backup();
    expect(f1).not.toBeNull();
    const f2 = await (historyManager as any).backup(); // 与上一条完全一致
    expect(f2).toBeNull();
    const backups = await historyManager.listBackups();
    expect(backups).toHaveLength(1);
  });

  it('状态发生变化时仍应创建新备份', async () => {
    const state = { cursor: { 's1': { command: 'node' } } };
    (historyManager as any).configManager = install(state);
    await (historyManager as any).backup();
    state.cursor['s2'] = { command: 'node' }; // 新增一个 server
    const f2 = await (historyManager as any).backup();
    expect(f2).not.toBeNull();
    const backups = await historyManager.listBackups();
    expect(backups).toHaveLength(2);
  });
});

describe('clearAll', () => {
  it('应清空所有备份', async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(testBackupDir, `backup-test-${i}.json`),
        JSON.stringify({ timestamp: new Date().toISOString(), clients: {}, skills: {} }),
        'utf-8'
      );
    }

    const result = await historyManager.clearAll();
    expect(result).toBe(true);

    const files = await fs.readdir(testBackupDir);
    const backupFiles = files.filter(f => f.startsWith('backup-'));
    expect(backupFiles).toHaveLength(0);
  });
});

describe('cleanOldBackups', () => {
  it('应保留最新的 maxBackups 个备份', async () => {
    (historyManager as any).maxBackups = 3;

    for (let i = 0; i < 5; i++) {
      const ts = `2025-0${i + 1}-01`;
      await fs.writeFile(
        path.join(testBackupDir, `backup-${ts}T00-00-00-000Z.json`),
        JSON.stringify({ timestamp: `${ts}T00:00:00.000Z`, clients: {}, skills: {} }),
        'utf-8'
      );
    }

    await (historyManager as any).cleanOldBackups();

    const files = await fs.readdir(testBackupDir);
    const backupFiles = files.filter(f => f.startsWith('backup-') && f.endsWith('.json')).sort().reverse();
    expect(backupFiles).toHaveLength(3);
    expect(backupFiles[0]).toContain('2025-05');
    expect(backupFiles[1]).toContain('2025-04');
    expect(backupFiles[2]).toContain('2025-03');
  });
});
