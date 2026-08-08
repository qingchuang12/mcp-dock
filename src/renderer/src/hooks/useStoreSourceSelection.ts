import {useEffect, useState} from 'react';
import {useStore} from '../store/useStore';
import {useElectronAPI} from '../lib/electron';
import type {ApiConnection} from '../lib/electron';
import type {DataSource} from '../api/registry';
import {BUILTIN_SKILL_SOURCE_IDS} from '../../../shared/platform-constants';

export interface StoreSourceSelection {
    /** MCP 源管理里已启用的连接（下拉用） */
    mcpSources: ApiConnection[];
    /** Skill 源管理里已启用的连接（下拉用） */
    connections: ApiConnection[];
    /** 当前选中的 MCP 平台连接 ID；为 null 时走内置源（official/smithery） */
    mcpConnId: string | null;
    /** 当前内置 MCP 源类型（official/smithery） */
    dataSource: DataSource;
    /** 当前选中的 Skill 源 ID（可能为内置 github 或某直连源） */
    selectedSkillSourceId: string | null;
    /** 由 selectedSkillSourceId 解析出的实际连接（含 github 内置） */
    selectedConn: ApiConnection | null;
    /** 是否为平台直连 Skill 源（非 GitHub Registry 内置） */
    isDirectSkillSource: boolean;
    /** 下拉当前高亮值：保证「下拉显示 = 实际加载的数据」 */
    selectedMcpSourceId: string;
    setMcpConnId: (id: string | null) => void;
    setDataSource: (ds: DataSource) => void;
    setSelectedSkillSourceId: (id: string | null) => void;
}

/**
 * 收口商店的「数据源选择」逻辑：加载 MCP / Skill 源管理列表，并在未显式选择时
 * 按「默认源 → dataSource 对应内置源 → 列表首条」回退，避免出现
 * 「下拉显示与实际加载数据不一致」「返回后数据源被误改」等问题。
 *
 * 仅负责 selection 状态，不发起任何列表数据查询（那由 useMcpData / useSkillsData 负责）。
 */
export function useStoreSourceSelection(): StoreSourceSelection {
    const {
        mcpConnId,
        setMcpConnId,
        dataSource,
        setDataSource,
        selectedSkillSourceId,
        setSelectedSkillSourceId,
    } = useStore();
    const api = useElectronAPI();

    const [connections, setConnections] = useState<ApiConnection[]>([]);
    const [mcpSources, setMcpSources] = useState<ApiConnection[]>([]);

    // 加载 Skill 源管理列表（仅保留启用项）
    useEffect(() => {
        api.apiConnections
            .list('skill')
            .then(list => setConnections(list.filter(c => c.enabled ?? true)))
            .catch(() => setConnections([]));
    }, [api]);

    // 加载 MCP 源管理列表（仅保留启用项）
    useEffect(() => {
        api.apiConnections
            .list('mcp')
            .then(list => setMcpSources(list.filter(c => c.enabled ?? true)))
            .catch(() => setMcpSources([]));
    }, [api]);

    // 默认来源选择：用户已显式选择时保持不变；未选择时优先用「设为默认」的源，
    // 回退内置 GitHub Registry，再回退到列表第一条。
    // 必须等 connections 列表加载完成（length>0）后再判断，否则来源列表刷新/详情页返回瞬间
    // connections 为空会把用户已选的源误判为失效，从而被覆盖成默认源，导致"返回后数据源变化"。
    useEffect(() => {
        if (connections.length === 0) return;
        const stillValid = selectedSkillSourceId && connections.some(c => c.id === selectedSkillSourceId);
        if (!stillValid) {
            const def = connections.find(c => c.isDefault && (c.kind ?? 'skill') === 'skill');
            const gh = connections.find(c => c.id === BUILTIN_SKILL_SOURCE_IDS.github);
            const fallback = (def || gh || connections[0])?.id ?? null;
            setSelectedSkillSourceId(fallback);
        }
    }, [connections, selectedSkillSourceId, setSelectedSkillSourceId]);

    // MCP 默认源同步：等 mcpSources 加载完成后，若当前 mcpConnId/dataSource 未指向有效源，
    // 按「默认源 → dataSource 对应内置源 → 首条」回退并设置，保证下拉显示与实际数据一致，
    // 避免持久化选择指向已删除源时出现「下拉与实际不符」的异常。
    useEffect(() => {
        if (mcpSources.length === 0) return;
        const isValid = mcpConnId
            ? mcpSources.some(c => c.id === mcpConnId)
            : mcpSources.some(c => c.platformType === dataSource);
        if (isValid) return;
        const def = mcpSources.find(c => c.isDefault && (c.kind ?? 'mcp') === 'mcp');
        const byDataSource = mcpSources.find(c => c.platformType === dataSource);
        const fallback = def || byDataSource || mcpSources[0];
        if (!fallback) return;
        if (fallback.platformType === 'official' || fallback.platformType === 'smithery') {
            setDataSource(fallback.platformType);
            setMcpConnId(null);
        } else {
            setMcpConnId(fallback.id);
        }
    }, [mcpSources, mcpConnId, dataSource, setDataSource, setMcpConnId]);

    const selectedConn = connections.find(c => c.id === selectedSkillSourceId) || null;
    const isDirectSkillSource = !!selectedConn && selectedConn.platformType !== 'github';

    // 下拉当前值：以「实际生效的来源」为准，保证下拉显示 = 实际加载的数据。
    // 优先级：用户已选平台连接(mcpConnId) → dataSource 对应的内置源 → 列表首条。
    const selectedMcpSourceId =
        mcpConnId ??
        mcpSources.find(c => c.platformType === dataSource)?.id ??
        mcpSources[0]?.id ??
        '';

    return {
        mcpSources,
        connections,
        mcpConnId,
        dataSource,
        selectedSkillSourceId,
        selectedConn,
        isDirectSkillSource,
        selectedMcpSourceId,
        setMcpConnId,
        setDataSource,
        setSelectedSkillSourceId,
    };
}
