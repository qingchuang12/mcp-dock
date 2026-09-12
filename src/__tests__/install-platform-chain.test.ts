/**
 * ModelScope 安装链路端到端验证（plan-8.0 验收标准 1）。
 *
 * 用户主诉是「商店里 ModelScope 技能安装基本都失败」，根因是安装通道从未接线
 * （PLATFORM_SKILL_DOWNLOAD 漏登记 + 适配器无 fetchSkillDownload），而非网络。
 * 本文件补齐单元测试之外的**集成级**证据：适配器产出直链 → installSkillFromZip
 * 消费直链 → 落盘出真实技能目录（含 SKILL.md 与文件清单）。
 *
 * 约束：不装到真实用户目录（getSkillsPath 重定向临时目录）；zip 由项目自带
 * zip-writer 在内存生成，不依赖真实网络。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {buildZip, type ZipEntry} from '../main/zip-writer';
import {SkillsManager} from '../main/skills-manager';
import {modelscopeAdapter} from '../main/platforms/modelscope';
import {getAdapter} from '../main/platforms/registry';
import {PLATFORM_SKILL_DOWNLOAD} from '../shared/platform-constants';

vi.mock('electron', () => ({
    app: {getPath: () => os.tmpdir(), isPackaged: false},
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s, 'utf8'),
        decryptString: (b: Buffer) => b,
    },
}));

vi.mock('../main/config-manager', () => ({
    SKILL_SUPPORTED_CLIENTS: ['cursor'],
}));

let manager: SkillsManager;
let testDir: string;

function entry(zipPath: string, content: string): ZipEntry {
    return {zipPath, data: Buffer.from(content, 'utf8'), mtime: new Date()};
}

/** 构造带顶层外壳目录的 skill zip（模拟 ModelScope archive/zip/master 的常见结构） */
function demoZip(): Buffer {
    return buildZip([
        entry('alipay-payment-integration/SKILL.md', '---\nname: alipay-payment-integration\ndescription: d\n---\n# demo\n'),
        entry('alipay-payment-integration/ref/api.md', '接口说明'),
        entry('alipay-payment-integration/scripts/run.mjs', 'console.log(1)'),
    ]);
}

/** 模拟 ModelScope 直链返回真 zip */
function stubZipDownload(): void {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
        if (/\/archive\/zip\/master$/.test(url)) {
            return {ok: true, status: 200, arrayBuffer: async () => demoZip()};
        }
        return {ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0)};
    }));
}

beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `mcp-dock-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, {recursive: true});
    manager = new SkillsManager();
    (manager as unknown as {getSkillsPath: () => string}).getSkillsPath = () => testDir;
});

afterEach(async () => {
    await fs.rm(testDir, {recursive: true, force: true}).catch(() => {});
    vi.unstubAllGlobals();
});

describe('ModelScope 安装链路端到端', () => {
    it('V1: fetchSkillDownload 直链 → installSkillFromZip → 落盘真目录（含 SKILL.md 与真实清单）', async () => {
        stubZipDownload();
        const {downloadUrl} = await modelscopeAdapter.fetchSkillDownload!({
            baseUrl: '',
            skillId: 'PantherAng/alipay-payment-integration',
        });
        expect(downloadUrl).toBe(
            'https://www.modelscope.cn/skills/PantherAng/alipay-payment-integration/archive/zip/master'
        );

        // 模拟 IPC skills:install-platform-skill 的后半段（index.ts:644 同参数形态）
        const res = await manager.installSkillFromZip(downloadUrl, 'alipay-payment-integration', ['cursor'], {
            id: 'PantherAng/alipay-payment-integration',
            repositoryUrl: 'https://modelscope.cn/PantherAng/alipay-payment-integration',
        });
        expect(res.success, JSON.stringify(res)).toBe(true);

        const root = path.join(testDir, 'alipay-payment-integration');
        // SKILL.md 真实落盘
        const skillMd = await fs.readFile(path.join(root, 'SKILL.md'), 'utf-8');
        expect(skillMd).toContain('name: alipay-payment-integration');
        // 文件清单是真实清单，不是只有 .source.json 的空壳
        const meta = JSON.parse(await fs.readFile(path.join(root, '.source.json'), 'utf-8'));
        expect([...meta.files].sort()).toEqual(['SKILL.md', 'ref/api.md', 'scripts/run.mjs']);
        expect(await fs.readFile(path.join(root, 'ref', 'api.md'), 'utf-8')).toBe('接口说明');
    });

    it('V2: 未接线平台（skillsmp）主进程无下载通道、渲染层按钮禁用——双重拦截', () => {
        // E1（plan-9.0）后 clawhub / skillhub 已接线，改用仍未接线的 skillsmp 守卫同一契约：
        // 主进程侧（index.ts:628 的判断条件）：无 fetchSkillDownload → 安装请求被明确拒绝
        expect(getAdapter('skillsmp')?.fetchSkillDownload).toBeUndefined();
        // 渲染层侧守卫（SkillDetail.tsx:377 的判断条件）：未登记 → 安装按钮禁用
        expect(PLATFORM_SKILL_DOWNLOAD).not.toContain('skillsmp');
        // E1 已接线平台：必须登记且实现下载通道（与 PLATFORM_SKILL_DOWNLOAD 双向守卫呼应）
        for (const p of ['clawhub', 'skillhub'] as const) {
            expect(PLATFORM_SKILL_DOWNLOAD).toContain(p);
            expect(typeof getAdapter(p)!.fetchSkillDownload).toBe('function');
        }
    });

    it('V3: id 含 / 的路由往返（encodeURIComponent → decodeURIComponent）不破坏 owner/slug', async () => {
        const rawId = 'PantherAng/alipay-payment-integration';
        // 复刻 SkillCard.tsx:75 → 路由 → SkillDetail.tsx:169 的编解码路径
        const roundTripped = decodeURIComponent(encodeURIComponent(rawId));
        expect(roundTripped).toBe(rawId);

        const {downloadUrl} = await modelscopeAdapter.fetchSkillDownload!({baseUrl: '', skillId: roundTripped});
        // owner 与 slug 各占一段，斜杠保持为路径分隔符
        expect(downloadUrl).toBe('https://www.modelscope.cn/skills/PantherAng/alipay-payment-integration/archive/zip/master');
    });

    it('V4: 空 / 空白 skillId 明确报错，不产出 404 直链', async () => {
        await expect(modelscopeAdapter.fetchSkillDownload!({baseUrl: '', skillId: ''})).rejects.toThrow(/技能 ID/);
        await expect(modelscopeAdapter.fetchSkillDownload!({baseUrl: '', skillId: '   '})).rejects.toThrow(/技能 ID/);
    });
});
