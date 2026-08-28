/**
 * 客户端 Skills 目录路径 —— 单一来源（P2-4）
 *
 * 此前 config-manager / skills-manager / history-manager 各持一份硬编码的
 * defaultSkillsPaths 字面量表，且 history-manager 那份完全无视
 * customSkillsPaths / customClients，导致备份/回滚漏算自定义位置的 Skill。
 * 现统一收口到本模块，三处均委托此处解析。
 */

import os from 'os';
import path from 'path';
import {CLOUD_ROOT_DIR} from '../shared/cloud-sync-constants';
import type {CustomClientDef, SkillClientType} from './config-manager';

export interface SkillsPathResolution {
    customClients?: CustomClientDef[];
    customSkillsPaths?: Partial<Record<SkillClientType, string>>;
}

/**
 * 各平台共用的默认 Skills 目录（darwin / win32 / linux 完全一致）。
 */
export function computeDefaultSkillsPaths(home: string = os.homedir()): Record<SkillClientType, string> {
    return {
        cursor: path.join(home, '.cursor', 'skills'),
        'claude-code': path.join(home, '.claude', 'skills'),
        'gemini-cli': path.join(home, '.gemini', 'skills'),
        'codex-cli': path.join(home, '.codex', 'skills'),
        opencode: path.join(home, '.config', 'opencode', 'skills'),
        'agent-skills': path.join(home, '.agents', 'skills'),
        codebuddy: path.join(home, '.codebuddy', 'skills'),
        workbuddy: path.join(home, '.workbuddy', 'skills'),
        qoder: path.join(home, '.qoder', 'skills'),
        marscode: path.join(home, '.marscode', 'skills'),
        cloud: path.join(home, '.ai-tools', 'cloud', CLOUD_ROOT_DIR, 'skills'),
    };
}

/**
 * 单一来源：根据自定义配置解析某客户端的 Skills 目录路径。
 * 优先级：自定义客户端 skillsPath > 全局自定义 skillsPaths > 内置默认路径。
 */
export function resolveSkillsPath(
    client: SkillClientType | string,
    opts: SkillsPathResolution = {}
): string {
    const custom = opts.customClients?.find(c => c.id === client);
    if (custom?.skillsPath) return custom.skillsPath;
    return (
        opts.customSkillsPaths?.[client as SkillClientType]
        || computeDefaultSkillsPaths()[client as SkillClientType]
    );
}
