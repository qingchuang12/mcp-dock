/**
 * HistoryManager 自动化测试
 * 覆盖: 备份创建、列表、恢复、差异比较、清理
 */

// 显式导入 vi：src/__tests__ 未被任何 tsconfig include 覆盖，拿不到 vitest/globals 的全局类型
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock electron 模块
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir() },
}));

import { HistoryManager } from '../main/history-manager';

let historyManager: HistoryManager;
let testBackupDir: string;

beforeEach(async () => {
  testBackupDir = path.join(os.tmpdir(), `mcp-dock-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testBackupDir, { recursive: true });

  historyManager = new HistoryManager();
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

describe('listBackups · 计数口径与客户端清单', () => {
  const write = async (ts: string, data: Record<string, any>) => {
    await fs.writeFile(
      path.join(testBackupDir, `backup-${ts.replace(/[:.]/g, '-')}.json`),
      JSON.stringify({timestamp: ts, clients: {}, skills: {}, ...data}),
      'utf-8'
    );
  };

  it('serverCount 跨客户端去重，不再累加（与 skillCount 口径一致）', async () => {
    // s1 装在 3 个客户端、s2 装在 2 个客户端 → 去重后应为 2，累加则为 5
    await write('2025-02-01T00:00:00.000Z', {
      clients: {
        cursor: {config: {mcpServers: {s1: {}, s2: {}}}, serverCount: 2},
        vscode: {config: {mcpServers: {s1: {}, s2: {}}}, serverCount: 2},
        zed: {config: {mcpServers: {s1: {}}}, serverCount: 1},
      },
    });

    const backups = await historyManager.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0].serverCount).toBe(2);
  });

  it('clients 只含承载内容的客户端，未安装的空配置不进列表', async () => {
    await write('2025-02-02T00:00:00.000Z', {
      clients: {
        // 未安装：文件不存在，readConfig 返回空配置落盘
        cursor: {config: {mcpServers: {}}, serverCount: 0},
        windsurf: {config: {mcpServers: {}}, serverCount: 0},
        // 有 MCP server
        marscode: {config: {mcpServers: {s1: {}}}, serverCount: 1},
        // 无 server 但有 Skill
        codebuddy: {config: {mcpServers: {}}, serverCount: 0},
        // 既无 server 也无 skill
        qoder: {config: {mcpServers: {}}, serverCount: 0},
      },
      skills: {codebuddy: ['my-skill']},
    });

    const backups = await historyManager.listBackups();
    expect(backups[0].clients).toEqual(['marscode', 'codebuddy']);
  });

  it('Skill 去重统计：同一 Skill 装在多个客户端只计 1 次', async () => {
    await write('2025-02-03T00:00:00.000Z', {
      clients: {
        cursor: {config: {mcpServers: {}}, serverCount: 0},
        codebuddy: {config: {mcpServers: {}}, serverCount: 0},
      },
      skills: {cursor: ['a', 'b'], codebuddy: ['b', 'c']},
    });

    const backups = await historyManager.listBackups();
    expect(backups[0].skillCount).toBe(3);
    expect(backups[0].clients).toEqual(['cursor', 'codebuddy']);
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

describe('getDiff · Skill 内容变更（skillsModified）', () => {
  /** 写入含 skills / skillContents 的备份（模拟 P1-3 之后产生的备份） */
  const writeSkillBackup = async (
    ts: string,
    opts: {
      skills?: Record<string, string[]>;
      skillContents?: Record<string, Record<string, string>>;
    } = {},
  ) => {
    const data = {
      timestamp: ts,
      clients: {},
      skills: opts.skills ?? {},
      ...(opts.skillContents ? {skillContents: opts.skillContents} : {}),
    };
    await fs.writeFile(
      path.join(testBackupDir, `backup-${ts.replace(/[:.]/g, '-')}.json`),
      JSON.stringify(data),
      'utf-8'
    );
  };

  it('名字不变、SKILL.md 内容变了 → 记为 modified', async () => {
    const skills = {cursor: ['demo-skill']};
    await writeSkillBackup('2025-05-01T00:00:00.000Z', {
      skills,
      skillContents: {cursor: {'demo-skill': '---\nname: demo-skill\n---\n\nold body'}},
    });
    await writeSkillBackup('2025-05-02T00:00:00.000Z', {
      skills,
      skillContents: {cursor: {'demo-skill': '---\nname: demo-skill\n---\n\nnew body'}},
    });

    const diff = await historyManager.getDiff('2025-05-02T00:00:00.000Z');
    expect(diff!.skillsModified).toEqual(['demo-skill']);
    expect(diff!.skillsAdded).toEqual([]);
    expect(diff!.skillsRemoved).toEqual([]);
    expect(diff!.skillClientChanges).toEqual([
      {client: 'cursor', added: [], removed: [], modified: ['demo-skill']},
    ]);
  });

  it('内容完全没变 → 不产生 modified（不会刷出空变更记录）', async () => {
    const payload = {
      skills: {cursor: ['demo-skill']},
      skillContents: {cursor: {'demo-skill': '---\nname: demo-skill\n---\n\nsame body'}},
    };
    await writeSkillBackup('2025-05-03T00:00:00.000Z', payload);
    await writeSkillBackup('2025-05-04T00:00:00.000Z', payload);

    const diff = await historyManager.getDiff('2025-05-04T00:00:00.000Z');
    expect(diff!.skillsModified).toEqual([]);
    expect(diff!.skillsAdded).toEqual([]);
    expect(diff!.skillsRemoved).toEqual([]);
  });

  it('旧备份无 skillContents 字段时跳过内容比较（不误报全量 modified）', async () => {
    const skills = {cursor: ['demo-skill']};
    // 上一条：P1-3 之前的旧备份，没有 skillContents
    await writeSkillBackup('2025-05-05T00:00:00.000Z', {skills});
    // 当前：新备份，有 skillContents
    await writeSkillBackup('2025-05-06T00:00:00.000Z', {
      skills,
      skillContents: {cursor: {'demo-skill': '---\nname: demo-skill\n---\n\nbody'}},
    });

    const diff = await historyManager.getDiff('2025-05-06T00:00:00.000Z');
    expect(diff!.skillsModified).toEqual([]);
    expect(diff!.skillsAdded).toEqual([]);
    expect(diff!.skillsRemoved).toEqual([]);
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
    const state: Record<string, Record<string, any>> = { cursor: { 's1': { command: 'node' } } };
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
