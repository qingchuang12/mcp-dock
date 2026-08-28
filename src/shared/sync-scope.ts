/**
 * 同步内容范围 → 本地/远端子目录解析（纯函数，无外部依赖，便于单测）。
 *
 *  - 'mcp'    → 仅 mcp 子目录
 *  - 'skills' → 仅 skills 子目录
 *  - 'all'/缺省 → 整个暂存区（兼容旧任务 / 全量入口）
 *
 * 这是 MCP 与 Skill 云上传"分离"的核心：sftpPush 用这里的 local/remote 调 uploadDir，
 * 因此 scope='skills' 时绝对不会把 mcp 目录传上去，反之亦然。
 */
import path from 'path';
import type {SyncTaskScope} from './sync-task-types';

export function resolveScopeDirs(
    scope: SyncTaskScope | undefined,
    stagingDataDir: string,
    remoteDataDir: string
): {subDir: string; local: string; remote: string} {
    const subDir = scope === 'mcp' ? 'mcp' : scope === 'skills' ? 'skills' : '';
    const local = subDir ? path.join(stagingDataDir, subDir) : stagingDataDir;
    const remote = subDir ? `${remoteDataDir}/${subDir}` : remoteDataDir;
    return {subDir, local, remote};
}
