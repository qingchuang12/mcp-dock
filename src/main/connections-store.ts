/**
 * ConnectionsStore - API 直连管理（单例）
 *
 * 设计：
 *  - 连接配置明文存于 ~/.ai-tool/connections.json（不存 secret 明文，仅存 tokenId 引用）。
 *  - 每条连接绑定一个令牌（tokenId），验证时用 SecretStore 取 secret 探活 baseUrl。
 *  - 状态枚举：active | unverified | error | token_revoked。
 *  - 导出配置不含 secret 明文。
 */

import fs from 'fs';
import path from 'path';
import {app} from 'electron';
import {getSecretStore} from './secret-store';
import {
    BUILTIN_MCP_SOURCE_IDS,
    BUILTIN_SKILL_SOURCE_IDS,
    type ConnectionKind,
    PLATFORM_HEALTH_PATHS,
    PLATFORM_META,
    type PlatformType,
} from '../shared/platform-constants';

export type {PlatformType, ConnectionKind} from '../shared/platform-constants';
export {PLATFORM_META} from '../shared/platform-constants';

export type ConnectionStatus = 'active' | 'unverified' | 'error' | 'token_revoked';

export interface ApiConnection {
    id: string;
    name: string;
    platformType: PlatformType;
    baseUrl: string;
    tokenId?: string;
    customHeaders: Record<string, string>;
    status: ConnectionStatus;
    /** 详情摘要（如版本、区域等任意文本） */
    detail: string;
    /** 最近一次验证的文字说明（成功/令牌无效/网络错误等），便于前端提示 */
    lastVerifyMessage?: string;
    lastCheckedAt: number | null;
    createdAt: number;
    /** 是否设为默认连接（全局唯一，Store 的 Skills 来源默认选中此项） */
    isDefault?: boolean;
    /** 归属资源类型：mcp 源 / skill 源。存量数据缺省视为 skill。 */
    kind?: ConnectionKind;
    /** 是否启用。缺省视为启用；禁用后不出现在 Store 来源下拉中。 */
    enabled?: boolean;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export class ConnectionsStore {
    private filePath: string;
    /** 内置 MCP 源只 seed 一次的标记文件，避免用户删除后每次启动又被写回 */
    private mcpSeedFlagPath: string;
    /** 内置 Skill 源只 seed 一次的标记文件，与 MCP 源相互独立，互不影响 */
    private skillSeedFlagPath: string;
    private connections: ApiConnection[] = [];

    constructor() {
        const home = app.getPath('home');
        const dir = path.join(home, '.ai-tool');
        this.filePath = path.join(dir, 'connections.json');
        this.mcpSeedFlagPath = path.join(dir, '.mcp-sources-seeded');
        this.skillSeedFlagPath = path.join(dir, '.skill-sources-seeded');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
        this.load();

        // 关联令牌事件：令牌撤销/删除时更新依赖连接状态
        const ss = getSecretStore();
        ss.onRevoke = (tokenId: string) => this.markTokenRevoked(tokenId);
        ss.onDelete = (tokenId: string) => this.markTokenRevoked(tokenId);
    }

    private load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            this.connections = JSON.parse(raw) as ApiConnection[];
        } catch {
            this.connections = [];
        }
        this.migrate();
    }

    /**
     * 存量数据迁移 + 内置源 seed。
     *
     * - 老数据没有 kind 字段：按 platformType 推断（official/smithery 归 mcp，其余归 skill）。
     * - 老数据没有 enabled 字段：一律补 true，保证升级后不会突然全部消失。
     * - 内置 official / smithery（MCP）与 github（Skill / GitHub Registry）源以固定 id 落库，
     *   用户可编辑/禁用，删除后可通过各自的「恢复内置源」重新 seed。
     */
    private migrate(): void {
        let changed = false;

        for (const c of this.connections) {
            if (c.kind === undefined) {
                c.kind = c.platformType === 'official' || c.platformType === 'smithery' ? 'mcp' : 'skill';
                changed = true;
            }
            if (c.enabled === undefined) {
                c.enabled = true;
                changed = true;
            }
        }

        // MCP 内置源与 Skill 内置源各自独立 seed：用各自的标记文件，互不耦合。
        // 一次标记保证用户删除后不会每次启动又被写回，但两类源互相独立触发。
        const mcpSeeded = fs.existsSync(this.mcpSeedFlagPath);
        if (!mcpSeeded) {
            for (const seed of this.builtinMcpSeeds()) {
                if (!this.connections.some(c => c.id === seed.id)) {
                    this.connections.push(seed);
                    changed = true;
                }
            }
            try {
                fs.writeFileSync(this.mcpSeedFlagPath, String(Date.now()), 'utf-8');
            } catch {
                /* seed 标记写入失败不阻断主流程 */
            }
        }

        const skillSeeded = fs.existsSync(this.skillSeedFlagPath);
        if (!skillSeeded) {
            for (const seed of this.builtinSkillSeeds()) {
                if (!this.connections.some(c => c.id === seed.id)) {
                    this.connections.push(seed);
                    changed = true;
                }
            }
            try {
                fs.writeFileSync(this.skillSeedFlagPath, String(Date.now()), 'utf-8');
            } catch {
                /* seed 标记写入失败不阻断主流程 */
            }
        }

        if (changed) this.persist();
    }

    /** 内置 MCP 源的种子数据 */
    private builtinMcpSeeds(): ApiConnection[] {
        const now = Date.now();
        return [
            {
                id: BUILTIN_MCP_SOURCE_IDS.official,
                name: 'Official Registry',
                platformType: 'official',
                baseUrl: PLATFORM_META.official.defaultBaseUrl,
                customHeaders: {},
                status: 'unverified',
                detail: 'modelcontextprotocol/servers 官方仓库',
                lastCheckedAt: null,
                createdAt: now,
                kind: 'mcp',
                enabled: true,
            },
            {
                id: BUILTIN_MCP_SOURCE_IDS.smithery,
                name: 'Smithery',
                platformType: 'smithery',
                baseUrl: PLATFORM_META.smithery.defaultBaseUrl,
                customHeaders: {},
                status: 'unverified',
                detail: 'Smithery MCP 注册中心',
                lastCheckedAt: null,
                createdAt: now - 1,
                kind: 'mcp',
                enabled: true,
            },
        ];
    }

    /** 内置 Skill 源的种子数据（GitHub Registry，store 下拉默认来源） */
    private builtinSkillSeeds(): ApiConnection[] {
        const now = Date.now();
        return [
            {
                id: BUILTIN_SKILL_SOURCE_IDS.github,
                name: 'GitHub Registry',
                platformType: 'github',
                baseUrl: PLATFORM_META.github.defaultBaseUrl,
                customHeaders: {},
                status: 'unverified',
                detail: 'modelcontextprotocol/servers 官方 GitHub 仓库',
                lastCheckedAt: null,
                createdAt: now - 100,
                kind: 'skill',
                enabled: true,
            },
            {
                id: BUILTIN_SKILL_SOURCE_IDS.clawhub,
                name: 'ClawHub',
                platformType: 'clawhub',
                baseUrl: PLATFORM_META.clawhub.defaultBaseUrl,
                customHeaders: {},
                status: 'unverified',
                detail: 'clawhub.ai 公开技能趋势榜单（无凭证即可查询）',
                lastCheckedAt: null,
                createdAt: now - 90,
                kind: 'skill',
                enabled: true,
            },
        ];
    }

    /** 重新写回缺失的内置 MCP 源（用户误删后恢复） */
    restoreBuiltinMcpSources(): ApiConnection[] {
        let changed = false;
        for (const seed of this.builtinMcpSeeds()) {
            if (!this.connections.some(c => c.id === seed.id)) {
                this.connections.push(seed);
                changed = true;
            }
        }
        if (changed) this.persist();
        return this.list('mcp');
    }

    /** 重新写回缺失的内置 Skill 源（GitHub Registry，用户误删后恢复） */
    restoreBuiltinSkillSources(): ApiConnection[] {
        let changed = false;
        for (const seed of this.builtinSkillSeeds()) {
            if (!this.connections.some(c => c.id === seed.id)) {
                this.connections.push(seed);
                changed = true;
            }
        }
        if (changed) this.persist();
        return this.list('skill');
    }

    private persist(): void {
        fs.writeFileSync(this.filePath, JSON.stringify(this.connections, null, 2), 'utf-8');
    }

    /** 列出连接；传 kind 时只返回该类型（存量无 kind 的数据视为 skill） */
    list(kind?: ConnectionKind): ApiConnection[] {
        const all = this.connections.slice().sort((a, b) => b.createdAt - a.createdAt);
        if (!kind) return all;
        return all.filter(c => (c.kind ?? 'skill') === kind);
    }

    get(id: string): ApiConnection | null {
        return this.connections.find(c => c.id === id) || null;
    }

    /** 创建或更新连接 */
    upsert(conn: Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'> & Partial<Pick<ApiConnection, 'id'>>): ApiConnection {
        const now = Date.now();
        if (conn.id) {
            const idx = this.connections.findIndex(c => c.id === conn.id);
            if (idx >= 0) {
                const existing = this.connections[idx];
                const updated: ApiConnection = {...existing, ...conn, lastCheckedAt: existing.lastCheckedAt};
                this.connections[idx] = updated;
                this.persist();
                // 重新评估状态
                this.evaluateStatus(updated);
                return this.connections[idx];
            }
        }
        const created: ApiConnection = {
            ...conn,
            id: `conn_${Math.random().toString(36).slice(2, 10)}`,
            createdAt: now,
            status: 'unverified',
            lastCheckedAt: null,
            kind: conn.kind ?? 'skill',
            enabled: conn.enabled ?? true,
        };
        this.connections.push(created);
        this.persist();
        this.evaluateStatus(created);
        return created;
    }

    delete(id: string): void {
        this.connections = this.connections.filter(c => c.id !== id);
        this.persist();
    }

    /**
     * 将某连接设为默认。默认标记按 kind 维度隔离：
     * 设一个 skill 源为默认，只会清除其它 skill 源的默认标记，不影响 mcp 源（反之亦然），
     * 这样 Skill 源管理与 MCP 源管理各自可独立设定一个默认源。
     */
    setDefault(id: string): void {
        const target = this.connections.find(c => c.id === id);
        if (!target) throw new Error('connection not found');
        const kind = target.kind ?? 'skill';
        for (const c of this.connections) {
            if (c.kind === kind) c.isDefault = c.id === id;
        }
        this.persist();
    }

    /** 当前默认连接（可能为 null） */
    getDefault(): ApiConnection | null {
        return this.connections.find(c => c.isDefault) || null;
    }

    /** 启用 / 禁用某连接 */
    setEnabled(id: string, enabled: boolean): ApiConnection {
        const target = this.connections.find(c => c.id === id);
        if (!target) throw new Error('connection not found');
        target.enabled = enabled;
        this.persist();
        return target;
    }

    /** 根据令牌状态重算连接状态（不写库，调用方决定） */
    private evaluateStatus(conn: ApiConnection): ConnectionStatus {
        const ss = getSecretStore();
        if (conn.tokenId) {
            const meta = ss.listTokens().find(t => t.id === conn.tokenId);
            if (!meta) return (conn.status = 'unverified');
            if (meta.revoked || ss.isExpired(meta)) return (conn.status = 'token_revoked');
        }
        return conn.status;
    }

    private markTokenRevoked(tokenId: string): void {
        let changed = false;
        for (const c of this.connections) {
            if (c.tokenId === tokenId && c.status !== 'token_revoked') {
                c.status = 'token_revoked';
                changed = true;
            }
        }
        if (changed) this.persist();
    }

    /** 探活：用绑定令牌实际请求 baseUrl 一次 */
    async verify(id: string): Promise<ApiConnection> {
        const conn = this.connections.find(c => c.id === id);
        if (!conn) throw new Error('connection not found');

        const ss = getSecretStore();
        const meta = conn.tokenId ? ss.listTokens().find(t => t.id === conn.tokenId) : undefined;
        if (conn.tokenId && (!meta || meta.revoked || ss.isExpired(meta))) {
            conn.status = 'token_revoked';
            conn.lastCheckedAt = Date.now();
            this.persist();
            return conn;
        }

        const headers: Record<string, string> = {'User-Agent': UA, ...conn.customHeaders};
        const hasToken = !!conn.tokenId;
        if (hasToken) {
            const secret = ss.getSecretToken(conn.tokenId!);
            if (secret) headers['Authorization'] = `Bearer ${secret}`;
        }

        // 依次尝试该平台的探活端点，任一连通即判定成功。
        // 不直接探 baseUrl：部分站点首页对非浏览器请求超时，但 API 端点正常。
        const paths = PLATFORM_HEALTH_PATHS[conn.platformType] || ['/'];
        const targets = paths.map(p => this.joinUrl(conn.baseUrl, p));

        let lastFailure = '';
        let authFailure: string | null = null;

        try {
            for (const url of targets) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 10000);
                const started = Date.now();
                try {
                    const res = await fetch(url, {method: 'GET', headers, signal: controller.signal});
                    const cost = Date.now() - started;
                    const ctype = res.headers.get('content-type') || '';
                    const isJson = ctype.includes('json');

                    if (res.status === 401 || res.status === 403) {
                        // 鉴权失败只在「确实带了令牌」时才归因于令牌；
                        // 未绑定令牌时说明该端点本就需要授权，不代表连接本身不可用，继续试下一个。
                        authFailure = hasToken
                            ? `令牌无效或权限不足（HTTP ${res.status}），请检查令牌是否正确或已过期`
                            : `该接口需要授权（HTTP ${res.status}），请为此连接绑定 API 令牌`;
                        lastFailure = authFailure;
                        continue;
                    }

                    if (res.ok) {
                        conn.status = 'active';
                        conn.lastVerifyMessage = isJson
                            ? `连接成功（${cost}ms）${hasToken ? '，令牌有效' : '，该平台接口无需令牌即可访问'}`
                            : `连接成功（${cost}ms），站点可达；该平台未提供公开 JSON 接口，搜索时将回退页面解析`;
                        return conn;
                    }

                    lastFailure = `连接失败（HTTP ${res.status}），请检查 Base URL 是否正确`;
                } catch (e: any) {
                    const cost = Date.now() - started;
                    lastFailure =
                        e?.name === 'AbortError'
                            ? `连接超时（>${cost}ms），站点未响应或网络不可达`
                            : '无法连接：网络不可达或 URL 不正确';
                } finally {
                    clearTimeout(timer);
                }
            }

            // 全部端点均未连通
            if (authFailure && hasToken) {
                conn.status = 'token_revoked';
                conn.lastVerifyMessage = authFailure;
            } else {
                conn.status = 'error';
                conn.lastVerifyMessage = lastFailure || '连接失败';
            }
        } finally {
            conn.lastCheckedAt = Date.now();
            this.persist();
        }
        return conn;
    }

    /** 拼接 baseUrl 与探活路径，避免重复/缺失斜杠 */
    private joinUrl(baseUrl: string, p: string): string {
        const base = baseUrl.replace(/\/+$/, '');
        if (!p || p === '/') return base || baseUrl;
        return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
    }

    /** 导出单条/全部连接配置（不含 secret 明文） */
    exportConfig(id?: string): string {
        const list = id ? this.connections.filter(c => c.id === id) : this.connections;
        const out = list.map(c => ({
            name: c.name,
            platformType: c.platformType,
            baseUrl: c.baseUrl,
            headers: {
                ...c.customHeaders,
                // 仅说明形态，不写入真实 secret
                ...(c.tokenId ? {Authorization: 'Bearer <YOUR_TOKEN_SECRET>'} : {}),
            },
            detail: c.detail,
            note: 'secret 不随配置导出；请在客户端通过绑定的令牌 ID 注入。',
        }));
        return JSON.stringify(id ? out[0] : {connections: out}, null, 2);
    }
}

// ==================== 单例 ====================
let instance: ConnectionsStore | null = null;

export function getConnectionsStore(): ConnectionsStore {
    if (!instance) instance = new ConnectionsStore();
    return instance;
}
