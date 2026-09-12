/**
 * 已安装 Skill「打得开」的标识解析守卫（plan-17.0）。
 *
 * 根因：zip / 平台通道（coze / modelscope / clawhub / skillhub）以**展示名**建目录、
 * 以**平台 id** 写 .source.json，二者不同源；而本地详情查询只认目录名，导致「我的库 →
 * 点击已安装技能」在 id 与目录名不一致时永远落空（虾评实测：目录名「AI情感咨询与治愈助手」、
 * id 为 UUID e8f2aaea-…）。
 *
 * 本文件固定三条契约：
 * 1. 传平台 id（UUID）能反查到目录，且返回的是**真实目录名**（详情页标题不能是 UUID）；
 * 2. 既有口径不受影响（目录名直查、owner/slug 末段、无 .source.json 的手工目录）；
 * 3. 不存在的 id 返回 null，不误命中其它目录。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {buildZip, type ZipEntry} from '../main/zip-writer';
import {SkillsManager} from '../main/skills-manager';

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

/** 虾评实测形态：平台 id 为 UUID，展示名是中文，二者毫无派生关系 */
const COZE_UUID = 'e8f2aaea-5076-443a-879a-678c9cf54246';
const COZE_DIR = 'AI情感咨询与治愈助手';

let manager: SkillsManager;
let testDir: string;

function entry(zipPath: string, content: string): ZipEntry {
    return {zipPath, data: Buffer.from(content, 'utf8'), mtime: new Date()};
}

/** 任意 zip 下载都返回同一个 skill 包（本文件不测下载，只测安装后的解析） */
function stubZipDownload(): void {
    const zip = buildZip([
        entry('skill/SKILL.md', '---\nname: demo\ndescription: d\n---\n# demo\n'),
        entry('skill/ref/api.md', '接口说明'),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => zip,
    })));
}

beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `mcp-dock-local-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, {recursive: true});
    manager = new SkillsManager();
    (manager as unknown as {getSkillsPath: () => string}).getSkillsPath = () => testDir;
});

afterEach(async () => {
    await fs.rm(testDir, {recursive: true, force: true}).catch(() => {});
    vi.unstubAllGlobals();
});

describe('getLocalSkillDetail 的标识解析', () => {
    it('V1: 平台 id 与目录名不同源（虾评 UUID）→ 按 .source.json.id 反查命中，且返回真实目录名', async () => {
        stubZipDownload();
        const res = await manager.installSkillFromZip('https://example.invalid/x.zip', COZE_DIR, ['cursor'], {
            id: COZE_UUID,
            repositoryUrl: 'https://xiaping.coze.com',
        });
        expect(res.success, JSON.stringify(res)).toBe(true);
        expect(await fs.access(path.join(testDir, COZE_DIR)).then(() => true).catch(() => false)).toBe(true);

        // 复刻 Library 点击（改造前用 source.id 导航）→ 详情页 getLocalSkillDetail(UUID)
        const detail = await manager.getLocalSkillDetail(COZE_UUID);
        expect(detail).not.toBeNull();
        // 标题必须是真实目录名，不能把 UUID 当技能名显示
        expect(detail!.name).toBe(COZE_DIR);
        expect(detail!.skillMdContent).toContain('# demo');
        expect(detail!.files).toContain('SKILL.md');
    });

    it('V2: 目录名直查仍命中（回归：既有入口不受影响）', async () => {
        stubZipDownload();
        await manager.installSkillFromZip('https://example.invalid/x.zip', 'demo-skill', ['cursor'],
            {id: 'PantherAng/demo-skill'});

        const detail = await manager.getLocalSkillDetail('demo-skill');
        expect(detail).not.toBeNull();
        expect(detail!.name).toBe('demo-skill');
    });

    it('V3: owner/slug 型 id 按末段命中（ClawHub / ModelScope 形态）', async () => {
        stubZipDownload();
        await manager.installSkillFromZip('https://example.invalid/x.zip', 'alipay-payment-integration', ['cursor'],
            {id: 'PantherAng/alipay-payment-integration'});

        const detail = await manager.getLocalSkillDetail('PantherAng/alipay-payment-integration');
        expect(detail).not.toBeNull();
        expect(detail!.name).toBe('alipay-payment-integration');
    });

    it('V4: 无 .source.json 的手工目录按目录名命中', async () => {
        await fs.mkdir(path.join(testDir, 'manual-skill'), {recursive: true});
        await fs.writeFile(path.join(testDir, 'manual-skill', 'SKILL.md'), '# manual\n', 'utf-8');

        const detail = await manager.getLocalSkillDetail('manual-skill');
        expect(detail).not.toBeNull();
        expect(detail!.source).toBeNull();
    });

    it('V5: 不存在的 id 返回 null，且不误命中同目录下的其它技能', async () => {
        stubZipDownload();
        await manager.installSkillFromZip('https://example.invalid/x.zip', 'demo-skill', ['cursor'],
            {id: 'PantherAng/demo-skill'});

        expect(await manager.getLocalSkillDetail('not-installed-at-all')).toBeNull();
        // 别的技能的 UUID 不能命中本目录
        expect(await manager.getLocalSkillDetail('00000000-0000-4000-8000-000000000000')).toBeNull();
    });
});
