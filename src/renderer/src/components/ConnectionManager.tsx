/**
 * API 直连管理卡片
 * 展示所有连接（状态点/名称/平台/详情），支持新增/编辑/删除、启用/禁用、搜索筛选、导出配置、一键默认直连。
 * 每条连接绑定一个令牌（tokenId），并明示关联说明。
 */
import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {type ApiConnection, type PlatformType, type TokenMeta, useElectronAPI} from '../lib/electron';
import {BUILTIN_SKILL_SOURCE_IDS, PLATFORM_META, SKILL_PLATFORM_TYPES} from '../../../shared/platform-constants';
import {useStore} from '../store/useStore';
import Modal from './Modal';
import {toast} from './Toast';

const STATUS_META: Record<ApiConnection['status'], { dot: string; text: string }> = {
    active: {dot: 'bg-[#34c759]', text: 'text-[#34c759]'},
    unverified: {dot: 'bg-[#98989d]', text: 'text-[#98989d]'},
    error: {dot: 'bg-[#ff3b30]', text: 'text-[#ff3b30]'},
    token_revoked: {dot: 'bg-[#ff9f0a]', text: 'text-[#ff9f0a]'},
};

const STATUS_LABEL_KEY: Record<ApiConnection['status'], string> = {
    active: 'statusActive',
    unverified: 'statusUnverified',
    error: 'statusError',
    token_revoked: 'statusTokenRevoked',
};

/** 内置 Skill 源的固定 id（GitHub Registry / ClawHub），用于判断是否缺失、是否需要展示「恢复内置源」 */
const BUILTIN_SKILL_IDS: string[] = [BUILTIN_SKILL_SOURCE_IDS.github, BUILTIN_SKILL_SOURCE_IDS.clawhub];

interface Props {
    /** 源列表变化后通知外部（Store 下拉需要重新拉取） */
    onChanged?: () => void;
}

export default function ConnectionManager({onChanged}: Props) {
    const {t} = useTranslation();
    const api = useElectronAPI();
    const tokens = useStore(s => s.tokens);
    const [conns, setConns] = useState<ApiConnection[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');

    const [showEdit, setShowEdit] = useState(false);
    const [editing, setEditing] = useState<Partial<ApiConnection> | null>(null);

    const load = async () => {
        try {
            setConns(await api.apiConnections.list('skill'));
        } catch (e) {
            console.error('load connections failed', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [api]);

    /** 数据变更后统一刷新并通知外部 */
    const reload = async () => {
        await load();
        onChanged?.();
    };

    const tokenById = useMemo(() => {
        const m = new Map<string, TokenMeta>();
        tokens.forEach(t => m.set(t.id, t));
        return m;
    }, [tokens]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return conns;
        return conns.filter(c =>
            c.name.toLowerCase().includes(q) ||
            PLATFORM_META[c.platformType].label.toLowerCase().includes(q) ||
            (c.detail || '').toLowerCase().includes(q)
        );
    }, [conns, query]);

    const openCreate = () => {
        setEditing({
            name: '',
            platformType: 'modelscope',
            baseUrl: PLATFORM_META.modelscope.defaultBaseUrl,
            tokenId: undefined,
            customHeaders: {},
            detail: '',
            kind: 'skill',
            enabled: true
        });
        setShowEdit(true);
    };

    const openEdit = (c: ApiConnection) => {
        setEditing({...c});
        setShowEdit(true);
    };

    const handleSave = async () => {
        if (!editing || !editing.name?.trim()) {
            toast.error(t('skillSource.nameRequired'));
            return;
        }
        try {
            if (editing.id) await api.apiConnections.update(editing as ApiConnection);
            else await api.apiConnections.create(editing as Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'>);
            toast.success(t('skillSource.saved'));
            setShowEdit(false);
            await reload();
        } catch (e: any) {
            toast.error(e?.message || t('skillSource.opFailed'));
        }
    };

    const handleDelete = async (id: string) => {
        await api.apiConnections.delete(id);
        toast.success(t('skillSource.deleted'));
        await reload();
    };

    const handleVerify = async (id: string) => {
        const c = await api.apiConnections.verify(id);
        setConns(prev => prev.map(x => x.id === id ? c : x));
        if (c.status === 'active') toast.success(c.lastVerifyMessage || t('skillSource.connSuccess'));
        else if (c.status === 'token_revoked') toast.error(c.lastVerifyMessage || t('skillSource.tokenInvalid'));
        else toast.error(c.lastVerifyMessage || t('skillSource.connFailed'));
    };

    const handleToggleEnabled = async (c: ApiConnection) => {
        const next = !(c.enabled ?? true);
        try {
            const updated = await api.apiConnections.setEnabled(c.id, next);
            setConns(prev => prev.map(x => x.id === c.id ? {...x, enabled: updated.enabled} : x));
            toast.success(next ? t('skillSource.enabled', {name: c.name}) : t('skillSource.disabled', {name: c.name}));
            onChanged?.();
        } catch (e: any) {
            toast.error(e?.message || t('skillSource.opFailed'));
        }
    };

    const handleSetDefault = async (id: string) => {
        try {
            const updated = await api.apiConnections.setDefault(id);
            setConns(prev => prev.map(x => ({...x, isDefault: x.id === updated.id})));
            toast.success(t('skillSource.setDefaultToast', {name: updated.name}));
        } catch (e: any) {
            toast.error(e?.message || t('skillSource.setDefaultFailed'));
        }
    };

    const handleExport = async (id?: string) => {
        const cfg = await api.apiConnections.export(id);
        const blob = new Blob([cfg], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = id ? 'connection.json' : 'connections.json';
        a.click();
        URL.revokeObjectURL(url);
        toast.success(t('skillSource.exported'));
    };

    const handleRestoreBuiltin = async () => {
        try {
            await api.apiConnections.restoreBuiltinSkill();
            toast.success(t('skillSource.restored'));
            await reload();
        } catch (e: any) {
            toast.error(e?.message || t('skillSource.restoreFailed'));
        }
    };

    const missingBuiltin = BUILTIN_SKILL_IDS.some(id => !conns.some(c => c.id === id));

    return (
        <div className="card p-4">
            <div className="flex items-center justify-between mb-1">
                <h2 className="text-[13px] font-semibold text-white">{t('skillSource.title')}</h2>
                <div className="flex items-center gap-2">
                    {missingBuiltin && (
                        <button
                            onClick={handleRestoreBuiltin}
                            className="px-2.5 py-1 rounded-md bg-[#3a3a3c] text-white text-[12px] hover:bg-[#3a3a3c]/80 transition-colors"
                        >
                            {t('skillSource.restoreBuiltin')}
                        </button>
                    )}
                    <button
                        onClick={openCreate}
                        className="px-2.5 py-1 rounded-md bg-[#0a84ff] text-white text-[12px] font-medium hover:bg-[#0a84ff]/90 transition-colors"
                    >
                        {t('skillSource.newSource')}
                    </button>
                </div>
            </div>
            <p className="text-[12px] text-[#98989d] mb-3">
                {t('skillSource.desc')}
            </p>

            {/* 搜索框 */}
            <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('skillSource.search')}
                className="w-full px-3 py-2 mb-3 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
            />

            {loading ? (
                <div className="space-y-2">
                    {[0, 1].map(i => <div key={i} className="h-16 rounded-md bg-[#3a3a3c]/40 animate-pulse"/>)}
                </div>
            ) : filtered.length === 0 ? (
                <div className="text-[12px] text-[#636366] py-3 text-center">
                    {conns.length === 0 ? t('skillSource.emptyNoSource') : t('skillSource.emptyNoMatch')}
                </div>
            ) : (
                <div className="space-y-2">
                    {filtered.map(c => {
                        const st = STATUS_META[c.status];
                        const statusLabel = t(`skillSource.${STATUS_LABEL_KEY[c.status]}`);
                        const tk = c.tokenId ? tokenById.get(c.tokenId) : undefined;
                        const enabled = c.enabled ?? true;
                        const isBuiltin = BUILTIN_SKILL_IDS.includes(c.id);
                        return (
                            <div key={c.id} className={`p-3 rounded-md bg-[#3a3a3c]/40 ${enabled ? '' : 'opacity-50'}`}>
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className={`w-2.5 h-2.5 rounded-full ${st.dot} flex-shrink-0`}
                                              title={statusLabel}/>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className="text-[12px] font-medium text-white truncate">{c.name}</span>
                                                <span
                                                    className="text-[10px] px-1.5 py-0.5 rounded bg-[#0a84ff]/15 text-[#0a84ff] flex-shrink-0">
                          {PLATFORM_META[c.platformType].label}
                        </span>
                                                {c.isDefault && (
                                                    <span
                                                        className="text-[10px] px-1.5 py-0.5 rounded bg-[#ff9f0a]/15 text-[#ff9f0a] flex-shrink-0">{t('skillSource.default')}</span>
                                                )}
                                                {isBuiltin && (
                                                    <span
                                                        className="text-[10px] px-1.5 py-0.5 rounded bg-[#98989d]/15 text-[#98989d] flex-shrink-0">{t('skillSource.builtin')}</span>
                                                )}
                                                {!enabled && (
                                                    <span
                                                        className="text-[10px] px-1.5 py-0.5 rounded bg-[#ff9f0a]/15 text-[#ff9f0a] flex-shrink-0">{t('skillSource.disabledBadge')}</span>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-[#636366] mt-0.5 truncate">{c.baseUrl}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 flex-shrink-0">
                                        {/* 启用/禁用开关 */}
                                        <button
                                            title={enabled ? t('skillSource.disableTitle') : t('skillSource.enableTitle')}
                                            onClick={() => handleToggleEnabled(c)}
                                            className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 mr-1 ${enabled ? 'bg-[#34c759]' : 'bg-[#3a3a3c]'}`}
                                        >
                      <span
                          className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${enabled ? 'left-[16px]' : 'left-[2px]'}`}
                      />
                                        </button>
                                        <IconBtn title={t('skillSource.testConn')} onClick={() => handleVerify(c.id)}>
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                                 stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
                                            </svg>
                                        </IconBtn>
                                        <IconBtn title={t('skillSource.export')} onClick={() => handleExport(c.id)}>
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                                 stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/>
                                            </svg>
                                        </IconBtn>
                                        {!c.isDefault && (
                                            <IconBtn title={t('skillSource.setDefault')}
                                                     onClick={() => handleSetDefault(c.id)}>
                                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                                     stroke="currentColor" strokeWidth={2}>
                                                    <path strokeLinecap="round" strokeLinejoin="round"
                                                          d="M11.48 3.5l2.29 4.64 5.12.74-3.7 3.61.87 5.1-4.58-2.41-4.58 2.41.87-5.1-3.7-3.61 5.12-.74L11.48 3.5z"/>
                                                </svg>
                                            </IconBtn>
                                        )}
                                        <IconBtn title={t('skillSource.edit')} onClick={() => openEdit(c)}>
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                                 stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
                                            </svg>
                                        </IconBtn>
                                        <IconBtn title={t('skillSource.delete')} danger
                                                 onClick={() => handleDelete(c.id)}>
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"
                                                 stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round"
                                                      d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>
                                            </svg>
                                        </IconBtn>
                                    </div>
                                </div>
                                {/* 关联说明副文本 */}
                                <div className="mt-2 flex items-start gap-1.5">
                                    <svg className="w-3 h-3 text-[#636366] mt-0.5 flex-shrink-0" fill="none"
                                         viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M13.19 8.688a4.5 4.5 0 011.242 7.247l-4.44 4.439a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.79-6.061a4.5 4.5 0 00-6.364 6.364"/>
                                    </svg>
                                    <p className="text-[10px] text-[#636366] leading-relaxed">
                                        {t('skillSource.tokenBound')}
                                        {tk
                                            ? <span
                                                className="text-[#98989d]"> {tk.name}（{t('skillSource.scope')} {tk.scopes.join(', ')} · {t('skillSource.expiry')} {tk.expiresAt ? new Date(tk.expiresAt).toLocaleDateString() : t('skillSource.noExpiry')} · {tk.revoked ? t('skillSource.revoked') : t('skillSource.normal')}）</span>
                                            : <span className="text-[#ff9f0a]"> {t('skillSource.noToken')}</span>}
                                    </p>
                                </div>
                                {c.detail &&
                                    <p className="text-[10px] text-[#636366] mt-1 truncate">{t('skillSource.detailPrefix')}{c.detail}</p>}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 编辑/新建弹窗 */}
            <Modal isOpen={showEdit} onClose={() => setShowEdit(false)}
                   title={editing?.id ? t('skillSource.editTitle') : t('skillSource.createTitle')}>
                {editing && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-[12px] text-[#98989d] mb-1.5">{t('skillSource.name')}</label>
                            <input
                                value={editing.name || ''}
                                onChange={e => setEditing({...editing, name: e.target.value})}
                                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
                            />
                        </div>
                        <div>
                            <label
                                className="block text-[12px] text-[#98989d] mb-1.5">{t('skillSource.platformType')}</label>
                            {SKILL_PLATFORM_TYPES.includes(editing.platformType as PlatformType) ? (
                                <select
                                    value={editing.platformType}
                                    onChange={e => {
                                        const p = e.target.value as PlatformType;
                                        setEditing({
                                            ...editing,
                                            platformType: p,
                                            baseUrl: PLATFORM_META[p].defaultBaseUrl || editing.baseUrl || ''
                                        });
                                    }}
                                    className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
                                >
                                    {SKILL_PLATFORM_TYPES.map(k => (
                                        <option key={k} value={k}>{PLATFORM_META[k].label}</option>
                                    ))}
                                </select>
                            ) : (
                                <div
                                    className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px]">
                                    {PLATFORM_META[editing.platformType as PlatformType]?.label || editing.platformType}
                                </div>
                            )}
                        </div>
                        <div>
                            <label className="block text-[12px] text-[#98989d] mb-1.5">Base URL</label>
                            <input
                                value={editing.baseUrl || ''}
                                onChange={e => setEditing({...editing, baseUrl: e.target.value})}
                                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] font-mono focus:border-[#0a84ff] transition-colors"
                            />
                        </div>
                        <div>
                            <label
                                className="block text-[12px] text-[#98989d] mb-1.5">{t('skillSource.bindToken')}</label>
                            <select
                                value={editing.tokenId || ''}
                                onChange={e => setEditing({...editing, tokenId: e.target.value || undefined})}
                                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
                            >
                                <option value="">{t('skillSource.unbound')}</option>
                                {tokens.map(tok => (
                                    <option key={tok.id} value={tok.id}
                                            disabled={tok.revoked}>{tok.name}{tok.revoked ? `（${t('skillSource.revoked')}）` : ''}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label
                                className="block text-[12px] text-[#98989d] mb-1.5">{t('skillSource.detailOptional')}</label>
                            <input
                                value={editing.detail || ''}
                                onChange={e => setEditing({...editing, detail: e.target.value})}
                                placeholder={t('skillSource.detailPlaceholder')}
                                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
                            />
                        </div>
                        <div className="flex items-center justify-between">
                            <label className="text-[12px] text-[#98989d]">{t('skillSource.enableSource')}</label>
                            <button
                                onClick={() => setEditing({...editing, enabled: !(editing.enabled ?? true)})}
                                className={`relative w-9 h-5 rounded-full transition-colors ${(editing.enabled ?? true) ? 'bg-[#34c759]' : 'bg-[#3a3a3c]'}`}
                            >
                <span
                    className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-all ${(editing.enabled ?? true) ? 'left-[18px]' : 'left-[2px]'}`}
                />
                            </button>
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <button onClick={() => setShowEdit(false)}
                                    className="px-3 py-1.5 rounded-md bg-[#3a3a3c] text-white text-[12px] hover:bg-[#3a3a3c]/80 transition-colors">{t('common.cancel')}
                            </button>
                            <button onClick={handleSave}
                                    className="px-3 py-1.5 rounded-md bg-[#0a84ff] text-white text-[12px] font-medium hover:bg-[#0a84ff]/90 transition-colors">{t('common.save')}
                            </button>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}

function IconBtn({children, onClick, title, danger, disabled}: {
    children: React.ReactNode;
    onClick: () => void;
    title: string;
    danger?: boolean;
    disabled?: boolean
}) {
    return (
        <button
            title={title}
            onClick={disabled ? () => {
            } : onClick}
            disabled={disabled}
            className={`p-1.5 rounded transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : danger ? 'text-[#98989d] hover:text-[#ff3b30] hover:bg-[#ff3b30]/10' : 'text-[#98989d] hover:text-white hover:bg-[#3a3a3c]'}`}
        >
            {children}
        </button>
    );
}
