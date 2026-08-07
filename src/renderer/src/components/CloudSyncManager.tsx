/**
 * 云同步设置卡片
 * 支持 Git（系统 git CLI）与 SFTP（ssh2-sftp-client）两种通道，云端自动创建 ai-tool 目录存放 mcp / skill。
 * 凭据以明文提交给主进程，落盘时换成 SecretStore 的 secretId；已保存的凭据在这里只显示占位符。
 */
import {useEffect, useState} from 'react';
import {
    type AllRuntimes,
    type CloudSyncConfig,
    type CloudSyncConfigInput,
    defaultCloudSyncConfig,
    useElectronAPI,
} from '../lib/electron';
import {CLOUD_ROOT_DIR} from '../../../shared/cloud-sync-constants';
import {toast} from './Toast';

interface Props {
    /** 运行时探测结果，用于在 Git 模式下提示未安装 git */
    runtimes?: AllRuntimes | null;
    /** 配置保存后通知外部（云客户端的可用性会变化） */
    onChanged?: () => void;
}

/** 已保存凭据的占位提示 */
const SAVED_PLACEHOLDER = '••••••••（已保存）';

export default function CloudSyncManager({runtimes, onChanged}: Props) {
    const api = useElectronAPI();
    const [cfg, setCfg] = useState<CloudSyncConfig>(defaultCloudSyncConfig());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);

    // 明文凭据输入：undefined = 未改动（保留原值），'' = 清除，其他 = 覆盖
    const [gitToken, setGitToken] = useState<string | undefined>(undefined);
    const [gitPassphrase, setGitPassphrase] = useState<string | undefined>(undefined);
    const [sftpPassword, setSftpPassword] = useState<string | undefined>(undefined);
    const [sftpPassphrase, setSftpPassphrase] = useState<string | undefined>(undefined);

    const load = async () => {
        try {
            setCfg(await api.cloudSync.getConfig());
        } catch (e) {
            console.error('load cloud sync config failed', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [api]);

    /** 把表单拼成补丁；明文字段未改动时不下发 */
    const buildPatch = (): CloudSyncConfigInput => ({
        enabled: cfg.enabled,
        provider: cfg.provider,
        git: {
            repoUrl: cfg.git.repoUrl.trim(),
            branch: cfg.git.branch.trim() || 'main',
            authType: cfg.git.authType,
            privateKeyPath: cfg.git.privateKeyPath,
            userName: cfg.git.userName,
            userEmail: cfg.git.userEmail,
            ...(gitToken !== undefined ? {tokenInput: gitToken} : {}),
            ...(gitPassphrase !== undefined ? {passphraseInput: gitPassphrase} : {}),
        },
        sftp: {
            host: cfg.sftp.host.trim(),
            port: cfg.sftp.port || 22,
            username: cfg.sftp.username.trim(),
            authType: cfg.sftp.authType,
            privateKeyPath: cfg.sftp.privateKeyPath,
            remoteDir: cfg.sftp.remoteDir.trim() || '/',
            ...(sftpPassword !== undefined ? {passwordInput: sftpPassword} : {}),
            ...(sftpPassphrase !== undefined ? {passphraseInput: sftpPassphrase} : {}),
        },
    });

    /** 保存前的必填校验，返回错误文案 */
    const validate = (): string | null => {
        if (!cfg.enabled) return null;
        if (cfg.provider === 'git') {
            if (!cfg.git.repoUrl.trim()) return '请填写 Git 仓库地址';
        } else {
            if (!cfg.sftp.host.trim()) return '请填写 SFTP 主机地址';
            if (!cfg.sftp.username.trim()) return '请填写 SFTP 用户名';
        }
        return null;
    };

    const persist = async (): Promise<CloudSyncConfig | null> => {
        const err = validate();
        if (err) {
            toast.error(err);
            return null;
        }
        const next = await api.cloudSync.setConfig(buildPatch());
        setCfg(next);
        // 明文已落盘为 secretId，清掉本地输入态回到占位符显示
        setGitToken(undefined);
        setGitPassphrase(undefined);
        setSftpPassword(undefined);
        setSftpPassphrase(undefined);
        onChanged?.();
        return next;
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            if (await persist()) toast.success('云同步配置已保存');
        } catch (e: any) {
            toast.error(e?.message || '保存失败');
        } finally {
            setSaving(false);
        }
    };

    /** 测试前先保存，避免测的是旧配置 */
    const handleTest = async () => {
        setTesting(true);
        try {
            if (!(await persist())) return;
            const res = await api.cloudSync.test();
            if (res.ok) toast.success(res.message || '连接成功');
            else toast.error(res.message || '连接失败');
        } catch (e: any) {
            toast.error(e?.message || '测试失败');
        } finally {
            setTesting(false);
        }
    };

    const gitMissing = cfg.provider === 'git' && runtimes ? !runtimes.git.available : false;

    return (
        <div className="card p-4">
            <div className="flex items-center justify-between mb-1">
                <h2 className="text-[13px] font-semibold text-white">云同步</h2>
                <button
                    onClick={() => setCfg({...cfg, enabled: !cfg.enabled})}
                    className={`relative w-9 h-5 rounded-full transition-colors ${cfg.enabled ? 'bg-[#34c759]' : 'bg-[#3a3a3c]'}`}
                    title={cfg.enabled ? '关闭云同步' : '开启云同步'}
                >
                    <span
                        className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-all ${cfg.enabled ? 'left-[18px]' : 'left-[2px]'}`}/>
                </button>
            </div>
            <p className="text-[12px] text-[#98989d] mb-3">
                把云端当作一个客户端：会在远端自动创建 <code
                className="font-mono text-[#98989d]">{CLOUD_ROOT_DIR}</code> 目录存放 MCP 配置与 Skill。配置完成后可在「我的库」手动上传
                / 下载。
            </p>

            {loading ? (
                <div className="h-24 rounded-md bg-[#3a3a3c]/40 animate-pulse"/>
            ) : (
                <div className={cfg.enabled ? '' : 'opacity-50 pointer-events-none'}>
                    {/* 通道切换 */}
                    <div className="flex gap-2 mb-4">
                        {(['git', 'sftp'] as const).map(p => (
                            <button
                                key={p}
                                onClick={() => setCfg({...cfg, provider: p})}
                                className={`flex-1 px-3 py-2 rounded-md text-[12px] font-medium transition-colors ${
                                    cfg.provider === p ? 'bg-[#0a84ff] text-white' : 'bg-[#3a3a3c] text-[#98989d] hover:text-white'
                                }`}
                            >
                                {p === 'git' ? 'Git 仓库' : 'SFTP'}
                            </button>
                        ))}
                    </div>

                    {gitMissing && (
                        <div
                            className="mb-3 px-3 py-2 rounded-md bg-[#ff9f0a]/10 border border-[#ff9f0a]/30 text-[11px] text-[#ff9f0a]">
                            未检测到系统 git，Git 通道无法使用。请先安装 Git 并在「运行时环境」中刷新。
                        </div>
                    )}

                    {cfg.provider === 'git' ? (
                        <div className="space-y-3">
                            <Field label="仓库地址">
                                <input
                                    value={cfg.git.repoUrl}
                                    onChange={e => setCfg({...cfg, git: {...cfg.git, repoUrl: e.target.value}})}
                                    placeholder="git@github.com:user/ai-tool-sync.git 或 https://github.com/user/ai-tool-sync.git"
                                    className={inputCls + ' font-mono'}
                                />
                            </Field>
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="分支">
                                    <input
                                        value={cfg.git.branch}
                                        onChange={e => setCfg({...cfg, git: {...cfg.git, branch: e.target.value}})}
                                        placeholder="main"
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label="认证方式">
                                    <select
                                        value={cfg.git.authType}
                                        onChange={e => setCfg({
                                            ...cfg,
                                            git: {
                                                ...cfg.git,
                                                authType: e.target.value as CloudSyncConfig['git']['authType']
                                            }
                                        })}
                                        className={inputCls}
                                    >
                                        <option value="none">无（公开仓库 / 已配置凭据）</option>
                                        <option value="ssh-key">SSH 密钥</option>
                                        <option value="https-token">HTTPS 令牌</option>
                                    </select>
                                </Field>
                            </div>

                            {cfg.git.authType === 'ssh-key' && (
                                <>
                                    <Field label="私钥路径">
                                        <input
                                            value={cfg.git.privateKeyPath || ''}
                                            onChange={e => setCfg({
                                                ...cfg,
                                                git: {...cfg.git, privateKeyPath: e.target.value}
                                            })}
                                            placeholder="~/.ssh/id_ed25519"
                                            className={inputCls + ' font-mono'}
                                        />
                                    </Field>
                                    <SecretField
                                        label="私钥口令（可选）"
                                        value={gitPassphrase}
                                        saved={!!cfg.git.passphraseSecretId}
                                        onChange={setGitPassphrase}
                                    />
                                </>
                            )}

                            {cfg.git.authType === 'https-token' && (
                                <SecretField
                                    label="访问令牌"
                                    value={gitToken}
                                    saved={!!cfg.git.tokenSecretId}
                                    onChange={setGitToken}
                                    placeholder="Personal Access Token"
                                />
                            )}

                            <div className="grid grid-cols-2 gap-3">
                                <Field label="提交者名称">
                                    <input
                                        value={cfg.git.userName || ''}
                                        onChange={e => setCfg({...cfg, git: {...cfg.git, userName: e.target.value}})}
                                        placeholder="AI-Tools"
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label="提交者邮箱">
                                    <input
                                        value={cfg.git.userEmail || ''}
                                        onChange={e => setCfg({...cfg, git: {...cfg.git, userEmail: e.target.value}})}
                                        placeholder="ai-tools@localhost"
                                        className={inputCls}
                                    />
                                </Field>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="grid grid-cols-[1fr_100px] gap-3">
                                <Field label="主机">
                                    <input
                                        value={cfg.sftp.host}
                                        onChange={e => setCfg({...cfg, sftp: {...cfg.sftp, host: e.target.value}})}
                                        placeholder="sftp.example.com"
                                        className={inputCls + ' font-mono'}
                                    />
                                </Field>
                                <Field label="端口">
                                    <input
                                        type="number"
                                        value={cfg.sftp.port}
                                        onChange={e => setCfg({
                                            ...cfg,
                                            sftp: {...cfg.sftp, port: Number(e.target.value) || 22}
                                        })}
                                        className={inputCls}
                                    />
                                </Field>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="用户名">
                                    <input
                                        value={cfg.sftp.username}
                                        onChange={e => setCfg({...cfg, sftp: {...cfg.sftp, username: e.target.value}})}
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label="认证方式">
                                    <select
                                        value={cfg.sftp.authType}
                                        onChange={e => setCfg({
                                            ...cfg,
                                            sftp: {
                                                ...cfg.sftp,
                                                authType: e.target.value as CloudSyncConfig['sftp']['authType']
                                            }
                                        })}
                                        className={inputCls}
                                    >
                                        <option value="password">密码</option>
                                        <option value="key">SSH 密钥</option>
                                    </select>
                                </Field>
                            </div>

                            {cfg.sftp.authType === 'password' ? (
                                <SecretField
                                    label="密码"
                                    value={sftpPassword}
                                    saved={!!cfg.sftp.passwordSecretId}
                                    onChange={setSftpPassword}
                                />
                            ) : (
                                <>
                                    <Field label="私钥路径">
                                        <input
                                            value={cfg.sftp.privateKeyPath || ''}
                                            onChange={e => setCfg({
                                                ...cfg,
                                                sftp: {...cfg.sftp, privateKeyPath: e.target.value}
                                            })}
                                            placeholder="~/.ssh/id_ed25519"
                                            className={inputCls + ' font-mono'}
                                        />
                                    </Field>
                                    <SecretField
                                        label="私钥口令（可选）"
                                        value={sftpPassphrase}
                                        saved={!!cfg.sftp.passphraseSecretId}
                                        onChange={setSftpPassphrase}
                                    />
                                </>
                            )}

                            <Field label="远程根目录">
                                <input
                                    value={cfg.sftp.remoteDir}
                                    onChange={e => setCfg({...cfg, sftp: {...cfg.sftp, remoteDir: e.target.value}})}
                                    placeholder="/home/user/backup"
                                    className={inputCls + ' font-mono'}
                                />
                                <p className="text-[10px] text-[#636366] mt-1">
                                    实际存储位置：<span
                                    className="font-mono">{(cfg.sftp.remoteDir || '/').replace(/\/+$/, '')}/{CLOUD_ROOT_DIR}</span>
                                </p>
                            </Field>
                        </div>
                    )}

                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#3a3a3c]">
                        <p className="text-[10px] text-[#636366]">
                            {cfg.lastSyncAt
                                ? `上次同步：${new Date(cfg.lastSyncAt).toLocaleString()}${cfg.lastSyncMessage ? ` · ${cfg.lastSyncMessage}` : ''}`
                                : '尚未同步过'}
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={handleTest}
                                disabled={testing || saving}
                                className="px-3 py-1.5 rounded-md bg-[#3a3a3c] text-white text-[12px] hover:bg-[#3a3a3c]/80 transition-colors disabled:opacity-50"
                            >
                                {testing ? '测试中…' : '测试连接'}
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving || testing}
                                className="px-3 py-1.5 rounded-md bg-[#0a84ff] text-white text-[12px] font-medium hover:bg-[#0a84ff]/90 transition-colors disabled:opacity-50"
                            >
                                {saving ? '保存中…' : '保存'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

const inputCls = 'w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors';

function Field({label, children}: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="block text-[12px] text-[#98989d] mb-1.5">{label}</label>
            {children}
        </div>
    );
}

/**
 * 密文输入框：未改动时显示「已保存」占位符，聚焦编辑后才提交明文。
 * 清空输入框并保存 = 删除该凭据。
 */
function SecretField({
                         label,
                         value,
                         saved,
                         onChange,
                         placeholder,
                     }: {
    label: string;
    value: string | undefined;
    saved: boolean;
    onChange: (v: string | undefined) => void;
    placeholder?: string;
}) {
    const editing = value !== undefined;
    return (
        <div>
            <div className="flex items-center justify-between mb-1.5">
                <label className="text-[12px] text-[#98989d]">{label}</label>
                {saved && !editing && (
                    <button onClick={() => onChange('')}
                            className="text-[10px] text-[#ff453a] hover:underline">清除</button>
                )}
                {editing && (
                    <button onClick={() => onChange(undefined)}
                            className="text-[10px] text-[#98989d] hover:underline">取消修改</button>
                )}
            </div>
            <input
                type="password"
                value={editing ? value : ''}
                onChange={e => onChange(e.target.value)}
                placeholder={saved && !editing ? SAVED_PLACEHOLDER : (placeholder || '')}
                className={inputCls + ' font-mono'}
            />
        </div>
    );
}
