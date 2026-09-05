/**
 * 客户端路径探测自动化测试
 *
 * 覆盖：三平台配置路径表完整性、Skills 目录完整性、显示名完整性。
 * 这些是「加一个内置客户端」最容易漏改的地方——漏配某个平台会导致该客户端
 * 在该平台下直接消失，故用遍历 ALL_BUILTIN_CLIENTS 的方式兜底，而非逐条硬编码。
 */

import {describe, expect, it} from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    getClientAppPaths,
    getClientConfigMarkers,
    getClientDisplayName,
    getDefaultClientPaths
} from '../main/config/client-probe';
import {ALL_BUILTIN_CLIENTS, SKILL_SUPPORTED_CLIENTS} from '../main/config/types';
import {computeDefaultSkillsPaths} from '../main/client-paths';

const HOME = '/home/testuser';
const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

describe('getDefaultClientPaths', () => {
    it.each(PLATFORMS)('%s 下每个内置客户端都有配置路径（jetbrains 动态扫描除外）', (platform: NodeJS.Platform) => {
        const paths = getDefaultClientPaths(HOME, platform);
        for (const client of ALL_BUILTIN_CLIENTS) {
            if (client === 'jetbrains') continue; // 版本目录需运行时扫描，路径表留空
            expect(paths[client], `${client} @ ${platform}`).toBeTruthy();
        }
    });

    it('ZCode 指向用户级 ~/.zcode/cli/config.json（三平台一致）', () => {
        for (const platform of PLATFORMS) {
            expect(getDefaultClientPaths(HOME, platform).zcode)
                .toBe(path.join(HOME, '.zcode', 'cli', 'config.json'));
        }
    });

    it('TRAE SOLO CN 三平台均指向 User/mcp.json（VS Code fork 布局）', () => {
        expect(getDefaultClientPaths(HOME, 'darwin')['trae-solo-cn'])
            .toBe(path.join(HOME, 'Library', 'Application Support', 'TRAE SOLO CN', 'User', 'mcp.json'));
        expect(getDefaultClientPaths(HOME, 'win32')['trae-solo-cn'])
            .toBe(path.join(HOME, 'AppData', 'Roaming', 'TRAE SOLO CN', 'User', 'mcp.json'));
        expect(getDefaultClientPaths(HOME, 'linux')['trae-solo-cn'])
            .toBe(path.join(HOME, '.config', 'TRAE SOLO CN', 'User', 'mcp.json'));
    });
});

describe('computeDefaultSkillsPaths', () => {
    it('每个支持 Skills 的客户端都有 Skills 目录', () => {
        const paths = computeDefaultSkillsPaths(HOME);
        for (const client of SKILL_SUPPORTED_CLIENTS) {
            expect(paths[client], client).toBeTruthy();
        }
    });
});

describe('getClientDisplayName', () => {
    it('每个内置客户端都有显式显示名（而非回退成原始 id）', () => {
        for (const client of ALL_BUILTIN_CLIENTS) {
            expect(getClientDisplayName(client), client).not.toBe(client);
        }
    });

    it('ZCode 显示名为 ZCode', () => {
        expect(getClientDisplayName('zcode')).toBe('ZCode');
    });

    it('TRAE SOLO CN 显示名为 TRAE SOLO CN', () => {
        expect(getClientDisplayName('trae-solo-cn')).toBe('TRAE SOLO CN');
    });
});

describe('ZCode 已安装判定（本机相关，CI 未装则跳过）', () => {
    it('config marker 指向本机 ~/.zcode，命中即判已安装', async () => {
        const marker = path.join(os.homedir(), '.zcode');
        let exists = false;
        try {
            await fs.access(marker);
            exists = true;
        } catch {
            // 仅在已安装 ZCode 的机器上验证
        }
        if (!exists) return;

        // isClientInstalled 遍历 getConfigMarkers 命中即 return true；
        // 本机 ~/.zcode 存在 与 marker 配置正确 共同保证 ZCode 被识别为已安装。
        expect(getClientConfigMarkers('zcode')).toContain(marker);
    });
});

describe('TRAE SOLO CN 已安装判定（本机相关，CI 未装则跳过）', () => {
    it('win32 应用路径探测包含本机实际安装的 exe', async () => {
        const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'TRAE SOLO CN', 'TRAE SOLO CN.exe');
        let exists = false;
        try {
            await fs.access(exe);
            exists = true;
        } catch {
            // 仅在已安装 TRAE SOLO CN 的机器上验证
        }
        if (!exists) return;

        // isClientInstalled 遍历 getClientAppPaths 命中即判已安装；
        // 本机 exe 存在 与探测表配置正确 共同保证 TRAE SOLO CN 被识别。
        expect(getClientAppPaths('trae-solo-cn', 'win32')).toContain(exe);
    });
});
