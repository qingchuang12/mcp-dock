/**
 * 商店网格列表 - 统一渲染 MCP Server 卡片或 Skill 卡片
 */

import {memo, useMemo} from "react";
import type {DataSource, ServerListItem, SkillListItem} from "../api/registry";
import ServerCard from "../components/ServerCard";
import SkillCard from "../components/SkillCard";

interface StoreGridProps {
    resourceType: "mcp" | "skills";
    currentPage: number;
    items: (ServerListItem | SkillListItem)[];
    dataSource: DataSource;
    installedServerIds: Set<string>;
    installedSkillIds: Set<string>;
    mcpConnId: string | null;
    isDirectSkillSource: boolean;
    selectedSkillSourceId: string | null;
}

const StoreGrid = memo(function StoreGrid({
    resourceType,
    currentPage,
    items,
    dataSource,
    installedServerIds,
    installedSkillIds,
    mcpConnId,
    isDirectSkillSource,
    selectedSkillSourceId,
}: StoreGridProps) {
    const gridItems = useMemo(() => {
        if (resourceType === "mcp") {
            return (items as ServerListItem[]).map((server, index) => (
                <ServerCard
                    key={`${currentPage}-${index}-${server.id}`}
                    server={server}
                    dataSource={dataSource}
                    isInstalled={installedServerIds.has(server.id)}
                    platformConnId={mcpConnId}
                />
            ));
        }
        return (items as SkillListItem[]).map((skill, index) => (
            <SkillCard
                key={`${currentPage}-${index}-${skill.id}`}
                skill={skill}
                isInstalled={installedSkillIds.has(skill.name)}
                connectionId={isDirectSkillSource ? selectedSkillSourceId ?? undefined : undefined}
                sourceUrl={isDirectSkillSource ? (skill.repository?.url || skill.authorUrl || undefined) : undefined}
            />
        ));
    }, [resourceType, currentPage, items, dataSource, installedServerIds, installedSkillIds, mcpConnId, isDirectSkillSource, selectedSkillSourceId]);

    return (
        <div className="p-4">
            <div key={`grid-${resourceType}-${currentPage}`} className="grid grid-cols-2 gap-3">
                {gridItems}
            </div>
        </div>
    );
});

export default StoreGrid;