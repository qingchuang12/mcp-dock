/**
 * Skill 云端同步冲突检测
 *
 * 原实现位于 SkillsManager.checkCloudSyncConflicts，现整体下沉为模块级纯函数，
 * 行为完全一致。SkillsManager 仅做薄转发（注入 getSkillsPath 解析）。
 */

import fs from 'fs/promises';
import path from 'path';
import type {SkillClientType} from '../config/types';
import type {SkillCloudConflict, SkillSourceMeta} from './types';

/**
 * 检查 Skill 同步到云端时的冲突。
 * 对比本地 skill 与云端 skill 的修改时间（.source.json 的 updatedAt 或 SKILL.md 的 mtime）
 * 仅返回云端已存在同名 skill 的条目（即存在冲突的）。
 *
 * @param cloudSkillsPath 云端 skills 目录（来自 this.getSkillsPath('cloud')）
 * @param items 待检查的 { name, sourceClient } 列表
 * @param getSkillsPath 客户端 → 其 skills 目录路径 的解析函数
 */
export async function detectCloudConflicts(
    cloudSkillsPath: string,
    items: Array<{ name: string; sourceClient: SkillClientType }>,
    getSkillsPath: (client: SkillClientType) => string
): Promise<SkillCloudConflict[]> {
    const conflicts: SkillCloudConflict[] = [];

    for (const item of items) {
        const sourceSkillsPath = getSkillsPath(item.sourceClient);
        if (!sourceSkillsPath || !cloudSkillsPath) continue;
        const sourcePath = path.join(sourceSkillsPath, item.name);
        const cloudPath = path.join(cloudSkillsPath, item.name);

        let localUpdatedAt: string | null = null;
        let cloudUpdatedAt: string | null = null;

        // 读取本地 skill 的修改时间
        try {
            const sourceJsonPath = path.join(sourcePath, '.source.json');
            const sourceContent = await fs.readFile(sourceJsonPath, 'utf-8');
            const sourceMeta: SkillSourceMeta = JSON.parse(sourceContent);
            localUpdatedAt = sourceMeta.updatedAt || sourceMeta.installedAt;
        } catch {
            // 无 .source.json，使用 SKILL.md 的 mtime
            try {
                const stat = await fs.stat(path.join(sourcePath, 'SKILL.md'));
                localUpdatedAt = stat.mtime.toISOString();
            } catch { /* ignore */ }
        }

        // 读取云端 skill 的修改时间
        try {
            const cloudJsonPath = path.join(cloudPath, '.source.json');
            const cloudContent = await fs.readFile(cloudJsonPath, 'utf-8');
            const cloudMeta: SkillSourceMeta = JSON.parse(cloudContent);
            cloudUpdatedAt = cloudMeta.updatedAt || cloudMeta.installedAt;
        } catch {
            try {
                const stat = await fs.stat(path.join(cloudPath, 'SKILL.md'));
                cloudUpdatedAt = stat.mtime.toISOString();
            } catch { /* ignore */ }
        }

        // 仅云端已存在同名 skill 时才报告冲突
        if (!cloudUpdatedAt) continue;

        let resolution: SkillCloudConflict['resolution'];
        if (!localUpdatedAt) {
            resolution = 'cloud_newer';
        } else if (localUpdatedAt === cloudUpdatedAt) {
            resolution = 'same';
        } else if (localUpdatedAt > cloudUpdatedAt) {
            resolution = 'local_newer';
        } else {
            resolution = 'cloud_newer';
        }

        conflicts.push({
            name: item.name,
            localUpdatedAt,
            cloudUpdatedAt,
            resolution,
        });
    }

    return conflicts;
}
