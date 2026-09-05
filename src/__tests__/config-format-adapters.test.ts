/**
 * ZCode 配置格式适配器自动化测试
 *
 * ZCode 原生格式（官方 https://zcode.z.ai/cn/newdocs/mcp-services）：
 *   {"mcp": {"servers": {"<name>": {"command": ..., "args": [...], "env": {...}}}}}
 * 与业界通用的 mcpServers 不同，故需专用读写分支。
 * 停用标记写在 server 对象内的 "enable": false，字段缺失即视为启用。
 *
 * 覆盖：mcp.servers 双向转换、enable 透传、非 MCP 字段保留、分支开关。
 */

import {describe, expect, it} from 'vitest';
import {
    defaultConfigForMissing,
    reachesDefaultBranch,
    readClientConfig,
    writeClientConfig,
} from '../main/config/format-adapters';

describe('ZCode 读取（mcp.servers → mcpServers）', () => {
    it('解析 stdio 型 server', () => {
        const raw = JSON.stringify({
            mcp: {servers: {memory: {command: 'npx', args: ['-y', '@m/server-memory'], env: {FOO: 'bar'}}}},
        });
        expect(readClientConfig('zcode', raw).mcpServers).toEqual({
            memory: {command: 'npx', args: ['-y', '@m/server-memory'], env: {FOO: 'bar'}},
        });
    });

    it('解析 http 型 server', () => {
        const raw = JSON.stringify({
            mcp: {servers: {remote: {url: 'https://example.com/mcp', type: 'http', headers: {Authorization: 'Bearer x'}}}},
        });
        expect(readClientConfig('zcode', raw).mcpServers).toEqual({
            remote: {url: 'https://example.com/mcp', type: 'http', headers: {Authorization: 'Bearer x'}},
        });
    });

    it('保留 enable: false，且不把缺失的 enable 补成 true', () => {
        const raw = JSON.stringify({mcp: {servers: {off: {command: 'node', enable: false}, on: {command: 'node'}}}});
        const servers = readClientConfig('zcode', raw).mcpServers!;
        expect(servers.off.enable).toBe(false);
        expect(servers.on.enable).toBeUndefined();
    });

    it('mcp 键缺失时降级为空 mcpServers', () => {
        expect(readClientConfig('zcode', '{"model":"glm"}').mcpServers).toEqual({});
    });
});

describe('ZCode 写入（mcpServers → mcp.servers）', () => {
    it('文件不存在时从 {} 建出 mcp.servers', () => {
        const out = writeClientConfig('zcode', {mcpServers: {memory: {command: 'npx', args: ['-y', 'pkg']}}}, '{}');
        expect(JSON.parse(out).mcp.servers.memory).toEqual({command: 'npx', args: ['-y', 'pkg']});
    });

    it('保留 config.json 内的非 MCP 字段，且只覆盖 mcp.servers', () => {
        const existing = JSON.stringify({model: 'glm-5', mcp: {servers: {old: {command: 'node'}}}});
        const out = writeClientConfig('zcode', {mcpServers: {added: {command: 'npx'}}}, existing);
        const parsed = JSON.parse(out);
        expect(parsed.model).toBe('glm-5');
        expect(Object.keys(parsed.mcp.servers)).toEqual(['added']);
    });

    it('写回时透传 enable: false', () => {
        const existing = JSON.stringify({mcp: {servers: {off: {command: 'node', enable: false}}}});
        const out = writeClientConfig('zcode', {mcpServers: {off: {command: 'node', enable: false}}}, existing);
        expect(JSON.parse(out).mcp.servers.off.enable).toBe(false);
    });

    it('读 → 写 → 读 往返一致', () => {
        const original = JSON.stringify({
            theme: 'dark',
            mcp: {
                servers: {
                    a: {command: 'node', args: ['a.js'], env: {K: 'V'}, cwd: '/tmp'},
                    b: {url: 'https://x/mcp', type: 'http', enable: false},
                },
            },
        });
        const once = readClientConfig('zcode', original);
        const out = writeClientConfig('zcode', once, original);

        expect(JSON.parse(out).theme).toBe('dark');
        expect(readClientConfig('zcode', out).mcpServers).toEqual(once.mcpServers);
    });
});

describe('ZCode 分支开关', () => {
    it('配置文件缺失时返回空 mcpServers', () => {
        expect(defaultConfigForMissing('zcode')).toEqual({mcpServers: {}});
    });

    it('走专用分支，不进默认分支（默认分支会整文件覆盖，丢非 MCP 设置）', () => {
        expect(reachesDefaultBranch('zcode')).toBe(false);
    });
});
