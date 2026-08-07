/**
 * CloudSyncService - 云端存储传输（单例）
 *
 * 设计：
 *  - 「云端」被当作一个客户端：本地暂存区 ~/.ai-tool/cloud/ai-tool 与云端 <remote>/ai-tool 目录同构。
 *    同步 MCP / Skill 到云客户端 = 写本地暂存区；push/pull 负责暂存区与远端之间的传输。
 *  - Git 通道调用系统 git CLI（与项目中 tar/PowerShell 解压一致的 shell-out 思路），
 *    凭据不写入 .git/config：token 拼进临时 URL 参数，SSH 走 GIT_SSH_COMMAND。
 *  - SFTP 通道用 ssh2-sftp-client，支持密钥与用户名+密码两种认证。
 *  - 仅手动触发，无后台自动同步。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
import SftpClient from 'ssh2-sftp-client';
import {CLOUD_ROOT_DIR, type CloudSyncResult} from '../shared/cloud-sync-constants';
import {getCloudSyncStore} from './cloud-sync-store';
import {EnvManager} from './env-manager';

const execFileAsync = promisify(execFile);

/** git 命令超时（clone/push 可能较慢） */
const GIT_TIMEOUT = 120_000;
/** sftp 连接超时 */
const SFTP_TIMEOUT = 20_000;

export class CloudSyncService {
    private envManager = new EnvManager();

    // ==================== 公开接口 ====================

    /** 测试连接：git 探 ls-remote；sftp 探连接 + 建 ai-tool 目录 */
    async testConnection(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const cfg = store.getConfig();
        try {
            if (cfg.provider === 'git') return await this.gitTest();
            return await this.sftpTest();
        } catch (e: any) {
            return {ok: false, message: this.normalizeError(e)};
        }
    }

    /** 上传：把本地暂存区推到云端 */
    async push(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        if (!store.isActive()) return {ok: false, message: '云同步未配置或未启用'};
        store.ensureStagingDirs();
        this.writeManifest();
        try {
            const cfg = store.getConfig();
            const res = cfg.provider === 'git' ? await this.gitPush() : await this.sftpPush();
            if (res.ok) store.recordSync(res.message);
            return res;
        } catch (e: any) {
            return {ok: false, message: this.normalizeError(e)};
        }
    }

    /** 下载：把云端拉到本地暂存区 */
    async pull(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        if (!store.isActive()) return {ok: false, message: '云同步未配置或未启用'};
        store.ensureStagingDirs();
        try {
            const cfg = store.getConfig();
            const res = cfg.provider === 'git' ? await this.gitPull() : await this.sftpPull();
            if (res.ok) store.recordSync(res.message);
            return res;
        } catch (e: any) {
            return {ok: false, message: this.normalizeError(e)};
        }
    }

    // ==================== Git ====================

    /**
     * 构造带凭据的远端 URL。
     * https-token 模式把 token 拼进 URL 作为一次性命令参数，不写入 .git/config，避免明文落盘。
     */
    private gitRemoteUrl(): string {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        const url = git.repoUrl.trim();
        if (git.authType !== 'https-token') return url;
        const token = store.revealSecret(git.tokenSecretId);
        if (!token) return url;
        try {
            const u = new URL(url);
            u.username = encodeURIComponent(token);
            u.password = '';
            return u.toString();
        } catch {
            return url;
        }
    }

    /** git 子进程环境：增强 PATH + SSH 密钥 + 关掉交互式凭据弹窗 */
    private gitEnv(): NodeJS.ProcessEnv {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: this.envManager.getEnhancedPath(),
            // 任何需要交互输入的场景直接失败，而不是挂起等待用户
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
        };
        if (git.authType === 'ssh-key' && git.privateKeyPath) {
            const key = git.privateKeyPath.replace(/\\/g, '/');
            env.GIT_SSH_COMMAND = `ssh -i "${key}" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o BatchMode=yes`;
        }
        return env;
    }

    private async git(args: string[], cwd?: string): Promise<string> {
        const {stdout} = await execFileAsync('git', args, {
            cwd: cwd || getCloudSyncStore().getStagingRoot(),
            env: this.gitEnv(),
            timeout: GIT_TIMEOUT,
            maxBuffer: 10 * 1024 * 1024,
        });
        return (stdout || '').trim();
    }

    /** 确保暂存区是一个 git 仓库，并写好提交身份 */
    private async ensureRepo(): Promise<void> {
        const store = getCloudSyncStore();
        const root = store.getStagingRoot();
        store.ensureStagingDirs();
        if (!fs.existsSync(path.join(root, '.git'))) {
            await this.git(['init']);
        }
        const git = store.getConfig().git;
        await this.git(['config', 'user.name', git.userName || 'AI-Tools']);
        await this.git(['config', 'user.email', git.userEmail || 'ai-tools@localhost']);
    }

    private async gitTest(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        if (!git.repoUrl.trim()) return {ok: false, message: '请填写仓库地址'};

        const runtime = await this.envManager.checkGit();
        if (!runtime.available) {
            return {ok: false, message: '未检测到 git，请先安装 Git 后重试'};
        }

        const out = await this.git(['ls-remote', '--heads', this.gitRemoteUrl()], os.tmpdir());
        const hasBranch = out.includes(`refs/heads/${git.branch}`);
        return {
            ok: true,
            message: hasBranch
                ? `连接成功，已找到分支 ${git.branch}（git ${runtime.version}）`
                : `连接成功，但远端还没有分支 ${git.branch}，首次上传时会自动创建`,
        };
    }

    private async gitPull(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        await this.ensureRepo();

        const url = this.gitRemoteUrl();
        const heads = await this.git(['ls-remote', '--heads', url, git.branch], os.tmpdir());
        if (!heads.trim()) {
            return {ok: true, message: `云端分支 ${git.branch} 还是空的，没有可下载的内容`, changed: false};
        }

        await this.git(['fetch', url, git.branch]);
        // 暂存区是应用私有目录，直接以远端为准硬重置
        await this.git(['reset', '--hard', 'FETCH_HEAD']);
        store.ensureStagingDirs();
        return {ok: true, message: '已从云端下载最新内容', changed: true};
    }

    private async gitPush(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        await this.ensureRepo();

        await this.git(['add', '-A', CLOUD_ROOT_DIR]);
        const staged = await this.git(['status', '--porcelain']);
        if (staged) {
            await this.git(['commit', '-m', `sync from ${os.hostname()} @ ${new Date().toISOString()}`]);
        }

        const hasCommit = await this.git(['rev-parse', '--verify', 'HEAD']).catch(() => '');
        if (!hasCommit) {
            return {ok: true, message: '暂存区没有可上传的内容', changed: false};
        }

        await this.git(['push', this.gitRemoteUrl(), `HEAD:refs/heads/${git.branch}`]);
        return {
            ok: true,
            message: staged ? '已上传到云端' : '云端已是最新，无需上传',
            changed: !!staged,
        };
    }

    // ==================== SFTP ====================

    private async sftpConnect(): Promise<SftpClient> {
        const store = getCloudSyncStore();
        const sftp = store.getConfig().sftp;
        const client = new SftpClient();

        const opts: Record<string, any> = {
            host: sftp.host.trim(),
            port: sftp.port || 22,
            username: sftp.username.trim(),
            readyTimeout: SFTP_TIMEOUT,
        };

        if (sftp.authType === 'password') {
            opts.password = store.revealSecret(sftp.passwordSecretId) || '';
        } else {
            if (!sftp.privateKeyPath) throw new Error('请填写私钥文件路径');
            opts.privateKey = fs.readFileSync(sftp.privateKeyPath);
            const passphrase = store.revealSecret(sftp.passphraseSecretId);
            if (passphrase) opts.passphrase = passphrase;
        }

        await client.connect(opts as any);
        return client;
    }

    /** 云端根目录：<remoteDir>/ai-tool（posix 分隔符） */
    private remoteDataDir(): string {
        const sftp = getCloudSyncStore().getConfig().sftp;
        const base = (sftp.remoteDir || '/').replace(/\/+$/, '');
        return `${base}/${CLOUD_ROOT_DIR}`;
    }

    private async sftpTest(): Promise<CloudSyncResult> {
        const cfg = getCloudSyncStore().getConfig().sftp;
        if (!cfg.host.trim() || !cfg.username.trim()) {
            return {ok: false, message: '请填写主机与用户名'};
        }
        const client = await this.sftpConnect();
        try {
            const remote = this.remoteDataDir();
            // 自动创建云端 ai-tool 存储目录
            if (!(await client.exists(remote))) await client.mkdir(remote, true);
            return {ok: true, message: `连接成功，云端存储目录：${remote}`};
        } finally {
            await client.end().catch(() => {
            });
        }
    }

    private async sftpPush(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const client = await this.sftpConnect();
        try {
            const remote = this.remoteDataDir();
            if (!(await client.exists(remote))) await client.mkdir(remote, true);
            await client.uploadDir(store.getStagingDataDir(), remote);
            return {ok: true, message: '已上传到云端', changed: true};
        } finally {
            await client.end().catch(() => {
            });
        }
    }

    private async sftpPull(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const client = await this.sftpConnect();
        try {
            const remote = this.remoteDataDir();
            if (!(await client.exists(remote))) {
                await client.mkdir(remote, true);
                return {ok: true, message: '云端存储目录为空，没有可下载的内容', changed: false};
            }
            await client.downloadDir(remote, store.getStagingDataDir());
            store.ensureStagingDirs();
            return {ok: true, message: '已从云端下载最新内容', changed: true};
        } finally {
            await client.end().catch(() => {
            });
        }
    }

    // ==================== 工具 ====================

    /** 写一份清单，便于在云端识别来源设备与时间 */
    private writeManifest(): void {
        const store = getCloudSyncStore();
        const file = path.join(store.getStagingDataDir(), 'manifest.json');
        const data = {
            version: 1,
            updatedAt: new Date().toISOString(),
            device: os.hostname(),
            platform: process.platform,
        };
        try {
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
        } catch {
            /* 清单写入失败不阻断同步 */
        }
    }

    /** 错误归一：把底层报错翻译成可读提示 */
    private normalizeError(e: any): string {
        const raw = [e?.stderr, e?.message, String(e)].find(x => x && String(x).trim()) || '未知错误';
        const msg = String(raw);

        if (e?.code === 'ENOENT' && /git/i.test(msg)) return '未检测到 git，请先安装 Git 后重试';
        if (e?.killed || /ETIMEDOUT|timed? out/i.test(msg)) return '连接超时，请检查网络或主机地址';
        if (/Authentication failed|All configured authentication methods failed|Permission denied \(publickey/i.test(msg)) {
            return '认证失败，请检查密钥 / 密码是否正确';
        }
        if (/could not read Username|terminal prompts disabled|Invalid username or password/i.test(msg)) {
            return '认证失败，请检查访问令牌是否正确或已过期';
        }
        if (/Repository not found|does not appear to be a git repository/i.test(msg)) {
            return '仓库不存在或无访问权限，请检查仓库地址';
        }
        if (/ENOTFOUND|getaddrinfo|Could not resolve host/i.test(msg)) return '无法解析主机地址，请检查网络与地址拼写';
        if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝，请检查主机与端口';
        if (/No such file/i.test(msg)) return '远程路径不存在，请检查远程目录配置';

        return msg.split('\n').slice(0, 3).join(' ').slice(0, 300);
    }
}

// ==================== 单例 ====================
let instance: CloudSyncService | null = null;

export function getCloudSyncService(): CloudSyncService {
    if (!instance) instance = new CloudSyncService();
    return instance;
}
