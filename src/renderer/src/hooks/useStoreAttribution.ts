import {useMemo} from "react";
import {useTranslation} from "react-i18next";
import type {ApiConnection} from "../lib/electron";
import type {StoreResourceType} from "./storeTypes";

interface UseStoreAttributionParams {
    resourceType: StoreResourceType;
    selectedMcpConn: ApiConnection | null;
    selectedConn: ApiConnection | null;
}

export function useStoreAttribution(params: UseStoreAttributionParams): string {
    const {t} = useTranslation();
    const {resourceType, selectedMcpConn, selectedConn} = params;

    return useMemo(() => {
        if (resourceType === "mcp") {
            if (selectedMcpConn) {
                return t("store.attributionFromMcp", {name: selectedMcpConn.name || selectedMcpConn.baseUrl});
            }
            return t("store.attributionSmithery");
        }
        if (selectedConn) {
            return t("store.attributionFromSkills", {name: selectedConn.name || selectedConn.baseUrl});
        }
        return t("store.attributionSkills");
    }, [resourceType, selectedMcpConn, selectedConn, t]);
}
