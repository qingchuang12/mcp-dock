import {useMemo} from "react";
import {useTranslation} from "react-i18next";
import type {ApiConnection} from "../lib/electron";
import type {DataSource} from "../api/registry";
import type {StoreResourceType} from "./storeTypes";

interface UseStoreAttributionParams {
    resourceType: StoreResourceType;
    dataSource: DataSource;
    selectedMcpConn: ApiConnection | null;
    selectedConn: ApiConnection | null;
}

export function useStoreAttribution(params: UseStoreAttributionParams): string {
    const {t} = useTranslation();
    const {resourceType, dataSource, selectedMcpConn, selectedConn} = params;

    return useMemo(() => {
        if (resourceType === "mcp") {
            if (selectedMcpConn) {
                return `MCP servers from ${selectedMcpConn.name || selectedMcpConn.baseUrl}`;
            }
            return dataSource === "official"
                ? t("store.attributionOfficial")
                : t("store.attributionSmithery");
        }
        if (selectedConn) {
            return `Skills from ${selectedConn.name || selectedConn.baseUrl}`;
        }
        return t("store.attributionSkills") || "Data from GitHub repositories";
    }, [resourceType, dataSource, selectedMcpConn, selectedConn, t]);
}
