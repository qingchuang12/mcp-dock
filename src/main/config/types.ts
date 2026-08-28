/**
 * 配置管理器 —— 公共类型与常量（单一来源）
 *
 * 原定义在 config-manager.ts 顶部，现下沉为独立模块，行为完全一致。
 * config-manager.ts 仍以 `export * from './config/types'` 透出，外部 import 路径不变。
 */

// 单个 MCP Server 的配置
export interface McpServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    type?: 'stdio' | 'http' | 'streamable-http' | 'sse';
    headers?: Record<string, string>;
}

export interface ClientConfig {
    mcpServers?: Record<string, McpServerConfig>;

    [key: string]: any;
}

// 所有 MCP 客户端类型
// 'cloud' 是虚拟客户端：指向 ~/.ai-tools/cloud/ai-tools 暂存区，由云同步（Git / SFTP）推拉到远端
export type ClientType =
    'cursor'
    | 'vscode'
    | 'claude-code'
    | 'gemini-cli'
    | 'codex-cli'
    | 'windsurf'
    | 'zed'
    | 'trae'
    | 'trae-cn'
    | 'marscode'
    | 'kiro'
    | 'opencode'
    | 'jetbrains'
    | 'antigravity'
    | 'openclaw'
    | 'codebuddy'
    | 'workbuddy'
    | 'qoder'
    | 'cloud';

/** 任意客户端 id：内置 ClientType 或用户手动添加的 custom:<slug> */
export type AnyClientId = ClientType | string;

// 支持 Skills 的客户端类型（含 .agents 统一标准）
export type SkillClientType =
    'cursor'
    | 'claude-code'
    | 'gemini-cli'
    | 'codex-cli'
    | 'opencode'
    | 'agent-skills'
    | 'codebuddy'
    | 'workbuddy'
    | 'qoder'
    | 'marscode'
    | 'cloud';

// 客户端是否支持 Skills
export const SKILL_SUPPORTED_CLIENTS: SkillClientType[] = ['cursor', 'claude-code', 'gemini-cli', 'codex-cli', 'opencode', 'agent-skills', 'codebuddy', 'workbuddy', 'qoder', 'marscode', 'cloud'];

/** 所有内置客户端类型（单一来源：备份/遍历统一复用，避免硬编码遗漏，P1-3/P2-4）。'cloud' 为暂存区非真实配置，单独排除。 */
export const ALL_BUILTIN_CLIENTS: ClientType[] = [
    'cursor', 'vscode', 'claude-code', 'gemini-cli', 'codex-cli', 'windsurf', 'zed',
    'trae', 'trae-cn', 'marscode', 'kiro', 'opencode', 'jetbrains', 'antigravity',
    'openclaw', 'codebuddy', 'workbuddy', 'qoder',
];

// VS Code 使用 "servers" 键而非 "mcpServers"
export const SERVERS_KEY_CLIENTS: ClientType[] = ['vscode'];

export interface ClientInfo {
    id: ClientType | string;
    name: string;
    installed: boolean;
    configPath: string;
    configExists: boolean;
    supportsSkills: boolean;
    skillsPath?: string;
    /** 是否为用户手动添加的客户端 */
    isCustom?: boolean;
}

/** 用户手动添加的客户端定义（持久化到 settings.json） */
export interface CustomClientDef {
    /** 唯一 id，形如 custom:<slug> */
    id: string;
    name: string;
    /** MCP 配置文件绝对路径 */
    configPath: string;
    /** 是否支持 Skills */
    supportsSkills: boolean;
    /** Skills 目录绝对路径（supportsSkills 时有效） */
    skillsPath?: string;
}
