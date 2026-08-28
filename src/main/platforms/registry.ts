/**
 * 平台适配器注册表：统一注册与调度各 PlatformAdapter。
 *
 * resolver 的 facade 通过本注册表访问平台能力，新增平台只需在下面注册，
 * 无需改动 if/switch 分支。支持按 SupportedPlatform 查询、列出全部、按名称模糊匹配。
 */
import type {PlatformAdapter, PlatformFacets, SupportedPlatform} from './types';
import {skillhubAdapter} from './skillhub';
import {clawhubAdapter} from './clawhub';
import {skillsmpAdapter} from './skillsmp';
import {bailianAdapter} from './bailian';
import {modelscopeAdapter} from './modelscope';

const adapters: Record<Exclude<SupportedPlatform, 'unknown'>, PlatformAdapter> = {
    modelscope: modelscopeAdapter,
    skillhub: skillhubAdapter,
    skillsmp: skillsmpAdapter,
    clawhub: clawhubAdapter,
    bailian: bailianAdapter,
    // safeskill 暂无独立 adapter，暂复用 skillhub 形态（前向兼容占位）
    safeskill: skillhubAdapter,
};

export function getAdapter(platform: SupportedPlatform): PlatformAdapter | null {
    if (platform === 'unknown') return null;
    return adapters[platform] || null;
}

export function listAdapters(): PlatformAdapter[] {
    const seen = new Set<string>();
    const out: PlatformAdapter[] = [];
    for (const k of Object.keys(adapters) as Exclude<SupportedPlatform, 'unknown'>[]) {
        const a = adapters[k];
        if (!seen.has(a.id)) {
            seen.add(a.id);
            out.push(a);
        }
    }
    return out;
}

export function platformName(platform: SupportedPlatform): string {
    return getAdapter(platform)?.name || platform;
}

/** 获取平台分类/排序/来源等面元数据（无 adapter 或 adapter 未实现时返回空 facets）。 */
export async function getFacets(platform: SupportedPlatform, resourceType?: 'mcp' | 'skills'): Promise<PlatformFacets> {
    const adapter = getAdapter(platform);
    if (!adapter || !adapter.getFacets) {
        return {categories: [], sortOptions: [], supportsSubcategories: false};
    }
    return adapter.getFacets(resourceType);
}
