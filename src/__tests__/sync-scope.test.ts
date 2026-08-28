import {describe, it, expect} from 'vitest';
import path from 'path';
import {resolveScopeDirs} from '../shared/sync-scope';

const STAGING = path.join('home', 'u', '.ai-tools', 'cloud', 'ai-tools');
const REMOTE = path.join('data', 'ai-tools');

describe('resolveScopeDirs · MCP/Skill 上传隔离', () => {
    it("scope='skills' 只解析 skills 子目录，绝不碰 mcp", () => {
        const r = resolveScopeDirs('skills', STAGING, REMOTE);
        expect(r.subDir).toBe('skills');
        expect(r.local).toBe(path.join(STAGING, 'skills'));
        expect(r.remote.endsWith('/skills')).toBe(true);
        expect(r.local).not.toContain('mcp');
    });

    it("scope='mcp' 只解析 mcp 子目录，绝不碰 skills", () => {
        const r = resolveScopeDirs('mcp', STAGING, REMOTE);
        expect(r.subDir).toBe('mcp');
        expect(r.local).toBe(path.join(STAGING, 'mcp'));
        expect(r.remote.endsWith('/mcp')).toBe(true);
        expect(r.local).not.toContain('skills');
    });

    it("scope=undefined/缺省 走全量（兼容旧任务）", () => {
        const r = resolveScopeDirs(undefined, STAGING, REMOTE);
        expect(r.subDir).toBe('');
        expect(r.local).toBe(STAGING);
        expect(r.remote).toBe(REMOTE);
    });
});
