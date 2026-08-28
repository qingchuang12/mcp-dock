/**
 * 商店网格列表 - 统一渲染 MCP Server 卡片或 Skill 卡片
 */

import {memo, useMemo} from "react";
import type {DataSource, ServerListItem, SkillListItem} from "../../api/registry";
import ServerCard from "../ServerCard";
import SkillCard from "../SkillCard";

interface StoreGridProps {
    resourceType: "mcp" | "skills";
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
            return (items as ServerListItem[]).map((server) => (
                <ServerCard
                    key={server.id}
                    server={server}
                    dataSource={dataSource}
                    isInstalled={installedServerIds.has(server.id)}
                    platformConnId={mcpConnId}
                />
            ));
        }
        return (items as SkillListItem[]).map((skill) => (
            <SkillCard
                key={skill.id}
                skill={skill}
                isInstalled={installedSkillIds.has(skill.name)}
                connectionId={isDirectSkillSource ? selectedSkillSourceId ?? undefined : undefined}
                sourceUrl={isDirectSkillSource ? (skill.repository?.url || skill.authorUrl || undefined) : undefined}
            />
        ));
    }, [resourceType, items, dataSource, installedServerIds, installedSkillIds, mcpConnId, isDirectSkillSource, selectedSkillSourceId]);

    return (
        <div className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {gridItems}
            </div>
        </div>
    );
});

export default StoreGrid;
