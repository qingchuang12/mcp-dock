/**
 * 直连来源浏览器
 * 选中某 API 直连后，以其绑定令牌 + Base URL 搜索对应平台 skill，
 * 点击可将解析出的源安装到客户端（复用 installFromDiscovered）。
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {
    type ApiConnection,
    type DirectSearchDiagnostics,
    type PlatformPageInfo,
    type PlatformSkillListItem,
    type SkillClientType,
    useElectronAPI,
} from '../lib/electron';
import {PLATFORM_META} from '../../../shared/platform-constants';
import {toast} from './Toast';

/** 每页条数 */
const PAGE_SIZE = 20;

/** 支持接收 Skills 的客户端（须与主进程 SKILL_SUPPORTED_CLIENTS 保持一致） */
const SKILL_CLIENTS = [
    'cursor',
    'claude-code',
    'gemini-cli',
    'codex-cli',
    'opencode',
    'agent-skills',
    'codebuddy',
    'workbuddy',
    'qoder',
    'marscode',
];

export default function PlatformConnectionBrowser({
                                                      connection,
                                                      query,
                                                  }: {
    connection?: ApiConnection;
    query: string;
}) {
    const api = useElectronAPI();
    const [items, setItems] = useState<PlatformSkillListItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [installing, setInstalling] = useState<string | null>(null);
    const [diag, setDiag] = useState<DirectSearchDiagnostics | null>(null);
    const [unsupported, setUnsupported] = useState(false);
    const [showDiag, setShowDiag] = useState(false);
    const [page, setPage] = useState(1);
    const [pageInfo, setPageInfo] = useState<PlatformPageInfo | null>(null);
    /** 防止乱序响应覆盖新结果（快速输入 / 连续翻页时） */
    const reqSeq = useRef(0);

    // 当前来源标识（API 直连）
    const sourceId = connection?.id ?? '';
    const platformType = connection?.platformType ?? 'custom';
    const sourceName = connection?.name ?? '';

    const search = useCallback(async (id: string, q: string, p: number) => {
        const seq = ++reqSeq.current;
        setLoading(true);
        try {
            const res = await api.apiConnections.searchPlatformPaged(id, q, p, PAGE_SIZE);
            if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃本次结果
            setItems(res.items);
            setPageInfo(res.pageInfo);
            setUnsupported(!!res.unsupported);
            // 无结果时取回主进程记录的端点探测链路，向用户解释具体原因
            if (res.items.length === 0) {
                const d = await api.apiConnections.searchDiagnostics(id).catch(() => null);
                if (seq !== reqSeq.current) return;
                setDiag(d);
                console.warn('[direct-search] no results, diagnostics =', d);
            } else {
                setDiag(null);
            }
        } catch (e: any) {
            if (seq !== reqSeq.current) return;
            console.error('search platform failed', e);
            toast.error(e?.message || '搜索失败');
            setItems([]);
            setPageInfo(null);
            const d = await api.apiConnections.searchDiagnostics(id).catch(() => null);
            if (seq === reqSeq.current) setDiag(d);
        } finally {
            if (seq === reqSeq.current) setLoading(false);
        }
    }, [api, connection]);

    // 关键词或来源变化时回到第 1 页，避免停留在越界页导致空列表
    useEffect(() => {
        setPage(1);
    }, [query, sourceId]);

    useEffect(() => {
        // 首页/输入中做防抖；翻页立即请求（用户已明确点击）
        const delay = page === 1 ? 400 : 0;
        const timer = setTimeout(() => search(sourceId, query, page), delay);
        return () => clearTimeout(timer);
    }, [query, page, sourceId, search]);

    const goToPage = useCallback((p: number) => {
        if (p < 1) return;
        setPage(p);
    }, []);

    const handleAdd = async (item: PlatformSkillListItem) => {
        setInstalling(item.id);
        try {
            const resolved: any = await api.apiConnections.resolveSkill(connection!.id, item.sourceUrl);
            if (!resolved?.success || !resolved.skills?.length) {
                toast.error(resolved?.error || '无法解析该 skill 源');
                return;
            }
            const clients = (await api.clients.getAll())
                .filter(c => SKILL_CLIENTS.includes(c.id) && c.installed)
                .map(c => c.id as SkillClientType);
            if (clients.length === 0) {
                toast.error('未检测到已安装的客户端，请先在设置中配置');
                return;
            }
            const r = await api.skills.installFromDiscovered(resolved.skills[0], clients);
            if (r.success) toast.success(`已安装 ${item.name}`);
            else toast.error(r.error || '安装失败');
        } catch (e: any) {
            toast.error(e?.message || '安装失败');
        } finally {
            setInstalling(null);
        }
    };

    return (
        <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
        <span className="text-[12px] text-[#98989d]">
          直连来源：<span className="text-white">{sourceName}</span>
          <span
              className="ml-1 px-1.5 py-0.5 rounded bg-[#0a84ff]/15 text-[#0a84ff] text-[10px]">{PLATFORM_META[platformType]?.label ?? platformType}</span>
        </span>
                {query && (
                    <span className="text-[11px] text-[#636366]">关键词：<span className="text-[#98989d]">{query}</span></span>
                )}
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-10">
                    <div className="w-7 h-7 border-2 border-[#3a3a3c] border-t-[#0a84ff] rounded-full animate-spin"/>
                </div>
            ) : items.length === 0 ? (
                <div className="py-8 px-4 text-center">
                    <div
                        className={`w-10 h-10 mx-auto mb-3 rounded-full flex items-center justify-center ${unsupported ? 'bg-[#0a84ff]/15' : 'bg-[#ff9f0a]/15'}`}>
                        <span
                            className={`text-[18px] leading-none ${unsupported ? 'text-[#0a84ff]' : 'text-[#ff9f0a]'}`}>!</span>
                    </div>
                    <p className="text-[12px] text-[#98989d] max-w-md mx-auto">
                        {unsupported
                            ? `「${sourceName}」是 SPA 站点，未开放公开的 skills 列表接口，无法在此直接浏览。如需安装其技能，请用「粘贴 GitHub 仓库链接」方式导入。`
                            : (diag?.hint || (page > 1 ? `第 ${page} 页没有更多技能了。` : '暂无结果。'))}
                    </p>

                    {page > 1 && (
                        <button
                            onClick={() => goToPage(1)}
                            className="mt-3 px-2.5 py-1 rounded bg-[#0a84ff] text-white text-[11px] font-medium hover:bg-[#0a84ff]/90 cursor-pointer transition-colors"
                        >
                            返回第 1 页
                        </button>
                    )}

                    {diag && diag.attempts.length > 0 && (
                        <>
                            <button
                                onClick={() => setShowDiag(v => !v)}
                                className="mt-3 text-[11px] text-[#0a84ff] hover:underline cursor-pointer"
                            >
                                {showDiag ? '收起调用链路' : `查看调用链路（${diag.attempts.length} 个端点，耗时 ${diag.totalDurationMs}ms）`}
                            </button>

                            {showDiag && (
                                <div
                                    className="mt-3 text-left rounded-md bg-[#1c1c1e] border border-[#3a3a3c] overflow-hidden">
                                    <div className="px-3 py-2 border-b border-[#3a3a3c] text-[10px] text-[#636366]">
                                        平台 {diag.platform} · Base {diag.baseUrl} ·
                                        令牌 {diag.authorized ? '已附带' : '未附带'}
                                    </div>
                                    {diag.attempts.map((a, i) => (
                                        <div key={i} className="px-3 py-2 border-b border-[#3a3a3c] last:border-0">
                                            <div className="flex items-start gap-2">
                                                <span
                                                    className={a.ok ? 'text-[#34c759]' : 'text-[#ff3b30]'}>{a.ok ? '✓' : '✗'}</span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[10px] text-[#98989d] break-all">{a.url}</div>
                                                    <div className="text-[10px] text-[#636366] mt-0.5">
                                                        {a.status ? `HTTP ${a.status}` : a.errorCode || '—'}
                                                        {a.contentType ? ` · ${a.contentType.split(';')[0]}` : ''}
                                                        {typeof a.bytes === 'number' ? ` · ${a.bytes}B` : ''}
                                                        {` · ${a.durationMs}ms`}
                                                        {a.reason ? ` · ${a.reason}` : ''}
                                                    </div>
                                                    {a.message && (
                                                        <div
                                                            className="text-[10px] text-[#ff9f0a] mt-0.5">{a.message}</div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3">
                        {items.map(it => (
                            <div key={it.id} className="p-3 rounded-md bg-[#3a3a3c]/40">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <h4 className="text-[12px] font-medium text-white truncate">{it.name}</h4>
                                        <p className="text-[11px] text-[#98989d] mt-1 line-clamp-2">{it.description}</p>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between mt-3">
                                    <span
                                        className="text-[10px] text-[#636366] truncate max-w-[60%]">{it.sourceUrl}</span>
                                    <button
                                        disabled={installing === it.id}
                                        onClick={() => handleAdd(it)}
                                        className="px-2.5 py-1 rounded bg-[#0a84ff] text-white text-[11px] font-medium hover:bg-[#0a84ff]/90 transition-colors disabled:opacity-50"
                                    >
                                        {installing === it.id ? '安装中…' : '添加'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* 分页：有 total 时显示精确页码，否则按 hasMore 提供上一页/下一页 */}
                    {pageInfo && (pageInfo.hasMore || page > 1) && (
                        <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#3a3a3c]">
            <span className="text-[11px] text-[#636366]">
              {pageInfo.total !== null
                  ? `${(page - 1) * pageInfo.pageSize + 1}-${(page - 1) * pageInfo.pageSize + items.length} / ${pageInfo.total}`
                  : `第 ${page} 页 · ${items.length} 条`}
            </span>

                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => goToPage(page - 1)}
                                    disabled={page === 1 || loading}
                                    className="p-1 rounded text-[#98989d] hover:text-white hover:bg-[#3a3a3c] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#98989d] disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    aria-label="上一页"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M15.75 19.5L8.25 12l7.5-7.5"/>
                                    </svg>
                                </button>

                                <span className="text-[11px] text-[#98989d] min-w-[60px] text-center">
                {pageInfo.totalPages !== null ? `${page} / ${pageInfo.totalPages}` : `${page}`}
              </span>

                                <button
                                    onClick={() => goToPage(page + 1)}
                                    disabled={!pageInfo.hasMore || loading}
                                    className="p-1 rounded text-[#98989d] hover:text-white hover:bg-[#3a3a3c] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#98989d] disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    aria-label="下一页"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                         strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round"
                                              d="M8.25 4.5l7.5 7.5-7.5 7.5"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
