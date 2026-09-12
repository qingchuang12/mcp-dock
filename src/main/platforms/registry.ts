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
import {npmAdapter} from './npm';
import {cozeAdapter} from './coze';

const adapters: Partial<Record<Exclude<SupportedPlatform, 'unknown'>, PlatformAdapter>> = {
    modelscope: modelscopeAdapter,
    skillhub: skillhubAdapter,
    skillsmp: skillsmpAdapter,
    clawhub: clawhubAdapter,
    bailian: bailianAdapter,
    // 虾评（Coze）Skill 平台源：直连公开分页接口，匿名可读列表
    coze: cozeAdapter,
    // safeskill：该站点未开放技能列表接口（官方文档声明的 /v1/search 线上未部署，实测
    // /v1/search nginx 404、/api/v1/search 应用层 404，2026-09-10），无可用 adapter。
    // 显式不注册 → getAdapter() 返回 null → 上层如实报「不支持」，
    // 不再复用 skillhub 数据串出结果（旧占位映射会把别家数据当 SafeSkill 结果返回）。
    // 2026-09-12：该源已从 SKILL_PLATFORM_TYPES 下线（不再可新建）；此处仍不注册，
    // 使存量连接的查询走 unsupported 分支如实提示，而非退化成通用错误态。
    // npm Registry：MCP 服务器发现源（独立 adapter，完全不影响 modelscope 逻辑）
    npm: npmAdapter,
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
        if (!a) continue; // Partial 后允许缺键（如 safeskill 显式不注册）
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
