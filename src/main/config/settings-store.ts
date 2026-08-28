/**
 * 用户设置持久化辅助（原子写 / 加载 / 路径安全校验）
 *
 * 原实现位于 ConfigManager 的私有方法（writeFileAtomic / saveUserSettings /
 * assertSafeConfigPath），现整体下沉为模块级函数，行为完全一致。
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type {ClientType, CustomClientDef, SkillClientType} from './types';

/** 用户设置（持久化于 ~/.ai-tools/settings.json） */
export interface UserSettings {
    customConfigPaths?: Partial<Record<ClientType, string>>;
    customSkillsPaths?: Partial<Record<SkillClientType, string>>;
    // 用户手动添加的客户端列表
    customClients?: CustomClientDef[];
    // 编辑保存后转为「手动安装」的 MCP server id 列表：此后不再被当作商店来源，避免线上更新覆盖
    manualMcpServers?: string[];
}

/**
 * 原子写：先写临时文件再 rename，避免崩溃/断电留下截断的 JSON/TOML 让客户端起不来（P0-4）
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
}

/**
 * 加载用户设置（文件缺失/解析失败时返回空对象）
 */
export async function loadUserSettingsFile(filePath: string): Promise<UserSettings> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

/**
 * 校验自定义客户端路径安全性（P1-6）：仅允许位于用户主目录内，
 * 避免 config:write 把配置写到 ~/.bashrc、/etc/passwd 等任意位置造成任意文件写。
 */
export function assertSafeConfigPath(raw: string, field: string): string {
    if (!raw) throw new Error(`INVALID_PATH:${field} 不能为空`);
    const p = path.resolve(raw);
    if (!path.isAbsolute(p)) {
        throw new Error(`INVALID_PATH:${field} 必须是绝对路径`);
    }
    const rel = path.relative(os.homedir(), p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`UNSAFE_PATH:${field} 必须位于用户主目录内（${os.homedir()}）`);
    }
    return p;
}
