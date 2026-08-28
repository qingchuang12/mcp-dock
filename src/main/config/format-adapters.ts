/**
 * 多格式配置读写适配器（jsonc / json / toml）
 *
 * 原实现位于 ConfigManager.readConfig / writeConfig 内的各客户端分支，
 * 现整体下沉为纯函数，行为完全一致（分支顺序、返回形状、合并兜底均不变）。
 * ConfigManager 仅负责文件 I/O（读文件、原子写、缓存失效）与这些函数的编排。
 */

import * as jsonc from 'jsonc-parser';
import * as TOML from 'smol-toml';
import type {
    AnyClientId,
    ClientConfig,
    ClientType,
    McpServerConfig,
} from './types';
import {SERVERS_KEY_CLIENTS} from './types';

/**
 * 获取客户端使用的 MCP 服务器键名
 */
export function getServersKey(client: AnyClientId): string {
    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) return 'servers';
    if (client === 'zed') return 'context_servers';
    if (client === 'opencode') return 'mcp';
    return 'mcpServers';
}

/**
 * 配置文件不存在（ENOENT）时返回的默认 ClientConfig。
 */
export function defaultConfigForMissing(client: AnyClientId): ClientConfig {
    if (client === 'zed') {
        return {mcpServers: {}, context_servers: {}};
    }
    if (client === 'opencode' || client === 'openclaw') {
        return {mcpServers: {}};
    }
    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) {
        return {mcpServers: {}, servers: {}};
    }
    return {mcpServers: {}};
}

/**
 * 判断 writeConfig 是否进入「默认分支」（默认分支会触发客户端缓存失效）。
 * 与 ConfigManager.writeConfig 原分支结构保持一致。
 */
export function reachesDefaultBranch(client: AnyClientId): boolean {
    return !(
        client === 'jetbrains'
        || client === 'codex-cli'
        || client === 'openclaw'
        || client === 'opencode'
        || client === 'claude-code'
        || client === 'zed'
        || SERVERS_KEY_CLIENTS.includes(client as ClientType)
    );
}

/**
 * 解析已读取到的配置文件内容（非空，且一定存在）为 ClientConfig。
 * 对应 ConfigManager.readConfig 的 try 分支。
 */
export function readClientConfig(client: AnyClientId, content: string): ClientConfig {
    if (client === 'jetbrains') {
        const config = JSON.parse(content);
        return {mcpServers: config.mcpServers || {}};
    }

    if (client === 'codex-cli') {
        const tomlConfig = TOML.parse(content) as Record<string, any>;
        const mcpServers: Record<string, McpServerConfig> = {};
        const rawServers = tomlConfig.mcp_servers || {};
        for (const [name, serverDef] of Object.entries(rawServers)) {
            const def = serverDef as Record<string, any>;
            if (def.command) {
                mcpServers[name] = {
                    command: def.command,
                    args: def.args || [],
                    env: def.env || {},
                    ...(def.cwd ? {cwd: def.cwd} : {}),
                };
            }
        }
        return {mcpServers};
    }

    if (client === 'openclaw') {
        const config = jsonc.parse(content);
        const rawServers = config.mcp?.servers || {};
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(rawServers)) {
            const d = def as Record<string, any>;
            if (d.url) {
                mcpServers[name] = {
                    url: d.url,
                    type: d.type || 'http',
                    headers: d.headers || {},
                };
            } else if (d.command) {
                mcpServers[name] = {
                    command: d.command,
                    args: d.args || [],
                    env: {},
                    ...(d.cwd ? {cwd: d.cwd} : {}),
                };
            }
        }
        return {mcpServers, ...config};
    }

    if (client === 'opencode') {
        const config = jsonc.parse(content);
        const rawMcp = config.mcp || {};
        const mcpServers: Record<string, McpServerConfig> = {};
        for (const [name, def] of Object.entries(rawMcp)) {
            const d = def as Record<string, any>;
            if (d.type === 'local' && Array.isArray(d.command) && d.command.length > 0) {
                mcpServers[name] = {
                    command: d.command[0],
                    args: d.command.slice(1),
                    env: d.environment || d.env || {},
                    ...(d.cwd ? {cwd: d.cwd} : {}),
                };
            } else if (d.type === 'remote' && d.url) {
                mcpServers[name] = {
                    url: d.url,
                    type: 'http',
                    headers: d.headers || {},
                };
            }
        }
        return {mcpServers, ...config};
    }

    if (client === 'claude-code' || client === 'zed') {
        const config = jsonc.parse(content);
        const serversKey = getServersKey(client);
        return {
            mcpServers: config[serversKey] || {},
            ...config,
        };
    }

    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) {
        const config = jsonc.parse(content);
        return {
            mcpServers: config.servers || {},
            ...config,
        };
    }

    const config = jsonc.parse(content);
    return config;
}

/**
 * 将 ClientConfig 序列化为待写入的配置文本。
 * 对应 ConfigManager.writeConfig 的各分支（jetbrains / codex-cli / openclaw /
 * opencode / claude-code+zed / servers-key / 默认），行为与原文逐字一致。
 * existingContent 为「已读取到的现有文件内容」（文件不存在时由调用方传入 '{}'）。
 */
export function writeClientConfig(client: AnyClientId, config: ClientConfig, existingContent: string): string {
    if (client === 'jetbrains') {
        let existingConfig: Record<string, any> = {};
        try {
            existingConfig = JSON.parse(existingContent);
        } catch {
            // file doesn't exist
        }
        existingConfig.mcpServers = config.mcpServers || {};
        return JSON.stringify(existingConfig, null, 2);
    }

    if (client === 'codex-cli') {
        let existingToml: Record<string, any> = {};
        try {
            existingToml = TOML.parse(existingContent) as Record<string, any>;
        } catch {
            // 文件不存在或解析失败
        }
        const mcpServers = config.mcpServers || {};
        const tomlServers: Record<string, any> = {};
        for (const [name, serverDef] of Object.entries(mcpServers)) {
            tomlServers[name] = {
                command: serverDef.command,
                ...(serverDef.args && serverDef.args.length > 0 ? {args: serverDef.args} : {}),
                ...(serverDef.env && Object.keys(serverDef.env).length > 0 ? {env: serverDef.env} : {}),
                ...(serverDef.cwd ? {cwd: serverDef.cwd} : {}),
            };
        }
        existingToml.mcp_servers = tomlServers;
        return TOML.stringify(existingToml);
    }

    if (client === 'openclaw') {
        const mcpServers = config.mcpServers || {};
        const openclawServers: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers)) {
            if (def.url) {
                openclawServers[name] = {
                    url: def.url,
                    type: 'http',
                    ...(def.headers && Object.keys(def.headers).length > 0 ? {headers: def.headers} : {}),
                };
            } else {
                openclawServers[name] = {
                    command: def.command,
                    ...(def.args && def.args.length > 0 ? {args: def.args} : {}),
                    ...(def.cwd ? {cwd: def.cwd} : {}),
                };
            }
        }

        const edits = jsonc.modify(existingContent, ['mcp', 'servers'], openclawServers, {
            formattingOptions: {tabSize: 2, insertSpaces: true}
        });
        return jsonc.applyEdits(existingContent, edits);
    }

    if (client === 'opencode') {
        const mcpServers = config.mcpServers || {};
        const opencodeMcp: Record<string, any> = {};
        for (const [name, def] of Object.entries(mcpServers)) {
            if (def.url) {
                opencodeMcp[name] = {
                    type: 'remote',
                    url: def.url,
                    ...(def.headers && Object.keys(def.headers).length > 0 ? {headers: def.headers} : {}),
                    enabled: true,
                };
            } else {
                opencodeMcp[name] = {
                    type: 'local',
                    command: [def.command, ...(def.args || [])],
                    ...(def.env && Object.keys(def.env).length > 0 ? {environment: def.env} : {}),
                    ...(def.cwd ? {cwd: def.cwd} : {}),
                    enabled: true,
                };
            }
        }

        const edits = jsonc.modify(existingContent, ['mcp'], opencodeMcp, {
            formattingOptions: {tabSize: 2, insertSpaces: true}
        });
        return jsonc.applyEdits(existingContent, edits);
    }

    // Claude Code / Zed: 包含非 MCP 设置，需 merge 写入
    if (client === 'claude-code' || client === 'zed') {
        const serversKey = getServersKey(client);
        const mcpServers = config.mcpServers || (config as any)[serversKey] || {};

        const edits = jsonc.modify(existingContent, [serversKey], mcpServers, {
            formattingOptions: {tabSize: 2, insertSpaces: true}
        });

        return jsonc.applyEdits(existingContent, edits);
    }

    // VS Code: 写入时将 mcpServers -> servers
    if (SERVERS_KEY_CLIENTS.includes(client as ClientType)) {
        const {mcpServers, servers, ...rest} = config;
        const writeConfig = {
            ...rest,
            servers: mcpServers || servers || {},
        };
        return JSON.stringify(writeConfig, null, 2);
    }

    return JSON.stringify(config, null, 2);
}
