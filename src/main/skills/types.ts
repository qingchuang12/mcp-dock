/**
 * Skills 管理器 —— 公共类型（单一来源）
 *
 * 原定义在 skills-manager.ts 顶部，现下沉为独立模块，行为完全一致。
 * skills-manager.ts 仍以 `export * from './skills/types'` 透出，外部 import 路径不变。
 */

import type {CustomClientDef, SkillClientType} from '../config/types';

// GitHub 仓库中发现的 Skill 信息
export interface DiscoveredSkill {
    name: string;
    path: string;
    skillMdUrl: string;
    skillMdContent: string;
    files: Array<{ name: string; path: string; rawUrl: string }>;
    repository: {
        url: string;
        branch: string;
        owner: string;
        repo: string;
    };
    /** 非 GitHub 源的 zip 下载直链（如 ModelScope 的 /skills/<owner>/<slug>/archive/zip/master）；存在时安装走 zip 解压通道 */
    downloadUrl?: string;
}

// Import 解析结果
export interface ImportParseResult {
    success: boolean;
    skills: DiscoveredSkill[];
    error?: string;
}

// Skills 来源元数据
export interface SkillSourceMeta {
    id: string;
    installedAt: string;
    updatedAt: string;
    source: {
        repositoryUrl: string;
        branch: string;
        skillPath: string;
        rawBaseUrl: string;
    };
    files: string[];
}

// 已安装的 Skill 信息
export interface InstalledSkill {
    name: string;
    path: string;
    source: SkillSourceMeta | null;
    hasUpdate?: boolean;
}

// Skills 安装结果
export interface SkillInstallResult {
    success: boolean;
    error?: string;
}

// 单个 Skill 同步到其他客户端的结果
export interface SkillSyncResult {
    success: SkillClientType[];
    failed: SkillClientType[];
    errors: Record<string, string>;
}

// 批量同步多个 Skill 的结果
export interface SkillBatchSyncResult {
    synced: number;
    failed: number;
    details: Array<{
        name: string;
        success: SkillClientType[];
        failed: SkillClientType[];
    }>;
}

// Skill 云端同步冲突信息
export interface SkillCloudConflict {
    name: string;
    localUpdatedAt: string | null;
    cloudUpdatedAt: string | null;
    /** 'local_newer' | 'cloud_newer' | 'same' */
    resolution: 'local_newer' | 'cloud_newer' | 'same';
}

// 用户设置（持久化于 ~/.ai-tools/settings.json）
export interface SkillsSettings {
    customSkillsPaths?: Partial<Record<SkillClientType, string>>;
    customClients?: CustomClientDef[];
}
