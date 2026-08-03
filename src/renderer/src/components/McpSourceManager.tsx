/**
 * MCP 源管理卡片
 * 展示所有 MCP 数据源（状态点/名称/平台/详情），支持新增/编辑/删除、启用/禁用、
 * 连接测试、搜索筛选、导出配置、恢复内置源。
 * 布局与交互与「Skill 源管理」（ConnectionManager）保持一致。
 */
import {useEffect, useMemo, useState} from 'react';
import {type ApiConnection, type PlatformType, type TokenMeta, useElectronAPI} from '../lib/electron';
import {BUILTIN_MCP_SOURCE_IDS, MCP_PLATFORM_TYPES, PLATFORM_META} from '../../../shared/platform-constants';
import Modal from './Modal';
import {toast} from './Toast';

const STATUS_META: Record<ApiConnection['status'], { label: string; dot: string; text: string }> = {
  active: { label: '已连接', dot: 'bg-[#34c759]', text: 'text-[#34c759]' },
  unverified: { label: '未验证', dot: 'bg-[#98989d]', text: 'text-[#98989d]' },
  error: { label: '连接失败', dot: 'bg-[#ff3b30]', text: 'text-[#ff453a]' },
  token_revoked: { label: '令牌已撤销', dot: 'bg-[#ff9f0a]', text: 'text-[#ff9f0a]' },
};

const BUILTIN_IDS: string[] = [BUILTIN_MCP_SOURCE_IDS.official, BUILTIN_MCP_SOURCE_IDS.smithery];

interface Props {
  /** 源列表变化后通知外部（Store 下拉需要重新拉取） */
  onChanged?: () => void;
}

export default function McpSourceManager({ onChanged }: Props) {
  const api = useElectronAPI();
  const [conns, setConns] = useState<ApiConnection[]>([]);
  const [tokens, setTokens] = useState<TokenMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const [showEdit, setShowEdit] = useState(false);
  const [editing, setEditing] = useState<Partial<ApiConnection> | null>(null);

  const load = async () => {
    try {
      const [c, t] = await Promise.all([api.apiConnections.list('mcp'), api.apiTokens.list()]);
      setConns(c);
      setTokens(t);
    } catch (e) {
      console.error('load mcp sources failed', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [api]);

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
      platformType: 'custom',
      baseUrl: '',
      tokenId: undefined,
      customHeaders: {},
      detail: '',
      kind: 'mcp',
      enabled: true,
    });
    setShowEdit(true);
  };

  const openEdit = (c: ApiConnection) => {
    setEditing({ ...c });
    setShowEdit(true);
  };

  const handleSave = async () => {
    if (!editing || !editing.name?.trim()) { toast.error('请输入源名称'); return; }
    try {
      const payload = { ...editing, kind: 'mcp' as const };
      if (editing.id) await api.apiConnections.update(payload as ApiConnection);
      else await api.apiConnections.create(payload as Omit<ApiConnection, 'id' | 'createdAt' | 'status' | 'lastCheckedAt'>);
      toast.success('MCP 源已保存');
      setShowEdit(false);
      await reload();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    }
  };

  const handleDelete = async (id: string) => {
    await api.apiConnections.delete(id);
    toast.success('已删除 MCP 源');
    await reload();
  };

  const handleVerify = async (id: string) => {
    const c = await api.apiConnections.verify(id);
    setConns(prev => prev.map(x => x.id === id ? c : x));
    if (c.status === 'active') toast.success(c.lastVerifyMessage || '连接成功');
    else if (c.status === 'token_revoked') toast.error(c.lastVerifyMessage || '令牌无效');
    else toast.error(c.lastVerifyMessage || '连接失败');
  };

  const handleToggleEnabled = async (c: ApiConnection) => {
    const next = !(c.enabled ?? true);
    try {
      const updated = await api.apiConnections.setEnabled(c.id, next);
      setConns(prev => prev.map(x => x.id === c.id ? { ...x, enabled: updated.enabled } : x));
      toast.success(next ? `已启用「${c.name}」` : `已禁用「${c.name}」`);
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message || '操作失败');
    }
  };

  const handleExport = async (id?: string) => {
    const cfg = await api.apiConnections.export(id);
    const blob = new Blob([cfg], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = id ? 'mcp-source.json' : 'mcp-sources.json';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('配置文件已导出');
  };

  const handleRestoreBuiltin = async () => {
    try {
      await api.apiConnections.restoreBuiltinMcp();
      toast.success('已恢复内置 MCP 源');
      await reload();
    } catch (e: any) {
      toast.error(e?.message || '恢复失败');
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      const updated = await api.apiConnections.setDefault(id);
      setConns(prev => prev.map(x => ({ ...x, isDefault: x.id === updated.id })));
      toast.success(`已将「${updated.name}」设为默认来源`);
    } catch (e: any) {
      toast.error(e?.message || '设置默认失败');
    }
  };

  const missingBuiltin = BUILTIN_IDS.some(id => !conns.some(c => c.id === id));

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[13px] font-semibold text-white">MCP 源管理</h2>
        <div className="flex items-center gap-2">
          {missingBuiltin && (
            <button
              onClick={handleRestoreBuiltin}
              className="px-2.5 py-1 rounded-md bg-[#3a3a3c] text-white text-[12px] hover:bg-[#3a3a3c]/80 transition-colors"
            >
              恢复内置源
            </button>
          )}
          <button
            onClick={openCreate}
            className="px-2.5 py-1 rounded-md bg-[#0a84ff] text-white text-[12px] font-medium hover:bg-[#0a84ff]/90 transition-colors"
          >
            + 新建 MCP 源
          </button>
        </div>
      </div>
      <p className="text-[12px] text-[#98989d] mb-3">
        管理 Store 页 MCP 列表的数据来源。禁用的源不会出现在来源下拉中。导出配置不含令牌明文。
      </p>

      {/* 搜索框 */}
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="按名称 / 平台 / 详情筛选…"
        className="w-full px-3 py-2 mb-3 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
      />

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map(i => <div key={i} className="h-16 rounded-md bg-[#3a3a3c]/40 animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-[12px] text-[#636366] py-3 text-center">
          {conns.length === 0 ? '尚未配置任何 MCP 源，点击「新建 MCP 源」或「恢复内置源」' : '无匹配的 MCP 源'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(c => {
            const st = STATUS_META[c.status];
            const tk = c.tokenId ? tokenById.get(c.tokenId) : undefined;
            const enabled = c.enabled ?? true;
            const isBuiltin = BUILTIN_IDS.includes(c.id);
            return (
              <div key={c.id} className={`p-3 rounded-md bg-[#3a3a3c]/40 ${enabled ? '' : 'opacity-50'}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2.5 h-2.5 rounded-full ${st.dot} flex-shrink-0`} title={st.label} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium text-white truncate">{c.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#0a84ff]/15 text-[#0a84ff] flex-shrink-0">
                          {PLATFORM_META[c.platformType].label}
                        </span>
                        {isBuiltin && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#98989d]/15 text-[#98989d] flex-shrink-0">内置</span>
                        )}
                        {c.isDefault && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#ff9f0a]/15 text-[#ff9f0a] flex-shrink-0">默认</span>
                        )}
                        {!enabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#ff9f0a]/15 text-[#ff9f0a] flex-shrink-0">已禁用</span>
                        )}
                      </div>
                      <p className="text-[10px] text-[#636366] mt-0.5 truncate">{c.baseUrl}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* 启用/禁用开关 */}
                    <button
                      title={enabled ? '禁用此源' : '启用此源'}
                      onClick={() => handleToggleEnabled(c)}
                      className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 mr-1 ${enabled ? 'bg-[#34c759]' : 'bg-[#3a3a3c]'}`}
                    >
                      <span
                        className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${enabled ? 'left-[16px]' : 'left-[2px]'}`}
                      />
                    </button>
                    <IconBtn title="测试连接" onClick={() => handleVerify(c.id)}>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                      </svg>
                    </IconBtn>
                    <IconBtn title="导出配置" onClick={() => handleExport(c.id)}>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                    </IconBtn>
                    {!c.isDefault && (
                      <IconBtn title="设为默认源" onClick={() => handleSetDefault(c.id)}>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5l2.29 4.64 5.12.74-3.7 3.61.87 5.1-4.58-2.41-4.58 2.41.87-5.1-3.7-3.61 5.12-.74L11.48 3.5z" />
                        </svg>
                      </IconBtn>
                    )}
                    <IconBtn title="编辑" onClick={() => openEdit(c)}>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                      </svg>
                    </IconBtn>
                    <IconBtn title="删除" danger onClick={() => handleDelete(c.id)}>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </IconBtn>
                  </div>
                </div>
                {/* 关联说明副文本 */}
                <div className="mt-2 flex items-start gap-1.5">
                  <svg className="w-3 h-3 text-[#636366] mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.247l-4.44 4.439a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.79-6.061a4.5 4.5 0 00-6.364 6.364" />
                  </svg>
                  <p className="text-[10px] text-[#636366] leading-relaxed">
                    绑定令牌：
                    {tk
                      ? <span className="text-[#98989d]"> {tk.name}（范围 {tk.scopes.join(', ')} · 有效期 {tk.expiresAt ? new Date(tk.expiresAt).toLocaleDateString() : '无期限'} · {tk.revoked ? '已撤销' : '正常'}）</span>
                      : <span className="text-[#98989d]"> 未绑定令牌（公开源无需鉴权）</span>}
                  </p>
                </div>
                {c.detail && <p className="text-[10px] text-[#636366] mt-1 truncate">详情：{c.detail}</p>}
              </div>
            );
          })}
        </div>
      )}

      {/* 编辑/新建弹窗 */}
      <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title={editing?.id ? '编辑 MCP 源' : '新建 MCP 源'}>
        {editing && (
          <div className="space-y-4">
            <div>
              <label className="block text-[12px] text-[#98989d] mb-1.5">名称</label>
              <input
                value={editing.name || ''}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#98989d] mb-1.5">平台类型</label>
              <select
                value={editing.platformType}
                onChange={e => {
                  const p = e.target.value as PlatformType;
                  setEditing({ ...editing, platformType: p, baseUrl: PLATFORM_META[p].defaultBaseUrl || editing.baseUrl || '' });
                }}
                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
              >
                {MCP_PLATFORM_TYPES.map(k => (
                  <option key={k} value={k}>{PLATFORM_META[k].label}</option>
                ))}
              </select>
              <p className="text-[10px] text-[#636366] mt-1">
                Official / Smithery 使用内置抓取实现；ModelScope 等平台源与自定义源通过 Base URL 直连搜索。
              </p>
            </div>
            <div>
              <label className="block text-[12px] text-[#98989d] mb-1.5">Base URL</label>
              <input
                value={editing.baseUrl || ''}
                onChange={e => setEditing({ ...editing, baseUrl: e.target.value })}
                placeholder="https://example.com"
                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] font-mono focus:border-[#0a84ff] transition-colors"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#98989d] mb-1.5">绑定令牌</label>
              <select
                value={editing.tokenId || ''}
                onChange={e => setEditing({ ...editing, tokenId: e.target.value || undefined })}
                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
              >
                <option value="">未绑定</option>
                {tokens.map(t => (
                  <option key={t.id} value={t.id} disabled={t.revoked}>{t.name}{t.revoked ? '（已撤销）' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12px] text-[#98989d] mb-1.5">详情说明（可选）</label>
              <input
                value={editing.detail || ''}
                onChange={e => setEditing({ ...editing, detail: e.target.value })}
                placeholder="如区域、版本、备注"
                className="w-full px-3 py-2 rounded-md bg-[#1c1c1e] border border-[#3a3a3c] text-white text-[12px] focus:border-[#0a84ff] transition-colors"
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-[12px] text-[#98989d]">启用此源</label>
              <button
                onClick={() => setEditing({ ...editing, enabled: !(editing.enabled ?? true) })}
                className={`relative w-9 h-5 rounded-full transition-colors ${(editing.enabled ?? true) ? 'bg-[#34c759]' : 'bg-[#3a3a3c]'}`}
              >
                <span
                  className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-all ${(editing.enabled ?? true) ? 'left-[18px]' : 'left-[2px]'}`}
                />
              </button>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowEdit(false)} className="px-3 py-1.5 rounded-md bg-[#3a3a3c] text-white text-[12px] hover:bg-[#3a3a3c]/80 transition-colors">取消</button>
              <button onClick={handleSave} className="px-3 py-1.5 rounded-md bg-[#0a84ff] text-white text-[12px] font-medium hover:bg-[#0a84ff]/90 transition-colors">保存</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function IconBtn({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded transition-colors ${danger ? 'text-[#98989d] hover:text-[#ff453a] hover:bg-[#ff3b30]/10' : 'text-[#98989d] hover:text-white hover:bg-[#3a3a3c]'}`}
    >
      {children}
    </button>
  );
}
