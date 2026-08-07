/**
 * CloudSyncStore - 云同步配置（单例）
 *
 * 设计：
 *  - 配置明文存于 ~/.ai-tool/cloud-sync.json，只含 secretId 引用，不含任何凭据明文。
 *  - 凭据明文交给 SecretStore 的通用密文接口（putRawSecret / getRawSecret）加密落盘。
 *  - isActive() 决定「云端存储」这个虚拟客户端是否出现在客户端列表中。
 */

import fs from 'fs';
import path from 'path';
import {app} from 'electron';
import {getSecretStore} from './secret-store';
import {
    CLOUD_ROOT_DIR,
    type CloudSyncConfig,
    type CloudSyncConfigInput,
    defaultCloudSyncConfig,
} from '../shared/cloud-sync-constants';

export type {
    CloudProvider,
    CloudSyncConfig,
    CloudSyncConfigInput,
    CloudSyncResult,
    GitCloudConfig,
    SftpCloudConfig,
} from '../shared/cloud-sync-constants';
export {CLOUD_ROOT_DIR, CLOUD_CLIENT_ID} from '../shared/cloud-sync-constants';

export class CloudSyncStore {
    private filePath: string;
    /** 本地暂存区根目录：~/.ai-tool/cloud */
    private stagingRoot: string;
    private config: CloudSyncConfig = defaultCloudSyncConfig();

    constructor() {
        const home = app.getPath('home');
        const dir = path.join(home, '.ai-tool');
        this.filePath = path.join(dir, 'cloud-sync.json');
        this.stagingRoot = path.join(dir, 'cloud');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
        this.load();
    }

    private load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<CloudSyncConfig>;
            const def = defaultCloudSyncConfig();
            // 逐层合并，保证新增字段在存量配置上也有默认值
            this.config = {
                ...def,
                ...parsed,
                git: {...def.git, ...(parsed.git || {})},
                sftp: {...def.sftp, ...(parsed.sftp || {})},
            };
        } catch {
            this.config = defaultCloudSyncConfig();
        }
    }

    private persist(): void {
        fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8');
    }

    /** 暂存区根目录（git 工作副本 / sftp 镜像根） */
    getStagingRoot(): string {
        return this.stagingRoot;
    }

    /** 暂存区中与云端同构的 ai-tool 目录 */
    getStagingDataDir(): string {
        return path.join(this.stagingRoot, CLOUD_ROOT_DIR);
    }

    /** 云客户端的 MCP 配置文件路径 */
    getStagingMcpConfigPath(): string {
        return path.join(this.getStagingDataDir(), 'mcp', 'mcp.json');
    }

    /** 云客户端的 Skills 目录 */
    getStagingSkillsPath(): string {
        return path.join(this.getStagingDataDir(), 'skills');
    }

    /** 确保暂存区目录结构存在 */
    ensureStagingDirs(): void {
        fs.mkdirSync(path.dirname(this.getStagingMcpConfigPath()), {recursive: true});
        fs.mkdirSync(this.getStagingSkillsPath(), {recursive: true});
    }

    /** 返回配置（只含 secretId，无明文） */
    getConfig(): CloudSyncConfig {
        return JSON.parse(JSON.stringify(this.config)) as CloudSyncConfig;
    }

    /**
     * 云同步是否可用：已启用且当前 provider 的必填项齐全。
     * 决定「云端存储」虚拟客户端是否出现在客户端列表中。
     */
    isActive(): boolean {
        if (!this.config.enabled) return false;
        if (this.config.provider === 'git') {
            return !!this.config.git.repoUrl.trim() && !!this.config.git.branch.trim();
        }
        return !!this.config.sftp.host.trim() && !!this.config.sftp.username.trim();
    }

    /**
     * 写入凭据明文并返回 secretId。
     * input 缺省 → 保留原 secretId；空串 → 删除凭据；有值 → 覆盖写入。
     */
    private resolveSecret(input: string | undefined, existingId: string | undefined): string | undefined {
        const ss = getSecretStore();
        if (input === undefined) return existingId;
        if (input === '') {
            if (existingId) ss.deleteRawSecret(existingId);
            return undefined;
        }
        return ss.putRawSecret(existingId || null, input);
    }

    /** 更新配置：明文凭据换成 secretId 后落盘 */
    setConfig(patch: CloudSyncConfigInput): CloudSyncConfig {
        const cur = this.config;

        if (patch.enabled !== undefined) cur.enabled = patch.enabled;
        if (patch.provider !== undefined) cur.provider = patch.provider;

        if (patch.git) {
            const {passphraseInput, tokenInput, ...rest} = patch.git;
            cur.git = {
                ...cur.git,
                ...rest,
                passphraseSecretId: this.resolveSecret(passphraseInput, cur.git.passphraseSecretId),
                tokenSecretId: this.resolveSecret(tokenInput, cur.git.tokenSecretId),
            };
        }

        if (patch.sftp) {
            const {passwordInput, passphraseInput, ...rest} = patch.sftp;
            cur.sftp = {
                ...cur.sftp,
                ...rest,
                passwordSecretId: this.resolveSecret(passwordInput, cur.sftp.passwordSecretId),
                passphraseSecretId: this.resolveSecret(passphraseInput, cur.sftp.passphraseSecretId),
            };
        }

        this.persist();
        if (this.isActive()) this.ensureStagingDirs();
        return this.getConfig();
    }

    /** 记录一次同步结果 */
    recordSync(message: string): void {
        this.config.lastSyncAt = Date.now();
        this.config.lastSyncMessage = message;
        this.persist();
    }

    /** 取某个 secretId 的明文（仅主进程内部传输时调用） */
    revealSecret(id?: string): string | undefined {
        if (!id) return undefined;
        return getSecretStore().getRawSecret(id) ?? undefined;
    }
}

// ==================== 单例 ====================
let instance: CloudSyncStore | null = null;

export function getCloudSyncStore(): CloudSyncStore {
    if (!instance) instance = new CloudSyncStore();
    return instance;
}
