/**
 * 商店筛选栏纯函数（与 UI 解耦，可被 node 环境测试直接驱动）。
 *
 * 背景（plan-14.0 收敛项）：「未筛选」基准不能硬编码 'relevance'——应用层默认排序 id 是
 * 'relevance'，但部分源并无此排序（SkillsMP 只有 stars/updated；Coze、百炼同理），此时
 * 显示层兜底为该源首个选项。若基准写死 'relevance'，用户在这些源上选回首选项（= 回到
 * 该源默认序，与显示一致）会被误判为「有筛选」，「清除筛选」按钮常驻；而点清除后 sort
 * 变成下拉里不存在的 'relevance'，显示又兜底回首选项——视觉上排序没变、按钮却消失。
 * 正确语义：「未筛选」= 排序处于该源默认选项（sortOptions[0]，与下拉显示值一致）。
 */
import type {SortOption} from './electron';

/**
 * 排序下拉的显示值：sort 在该源选项集内原样返回；不在（如应用层默认 'relevance'
 * 落在无此排序的源上）时回退为首个选项。仅作显示层兜底，不改写 sort 状态，
 * 未知值由各 adapter 自行解释为「默认序」。
 */
export function resolveSortDisplayValue(sort: string, sortOptions: SortOption[]): string {
    return sortOptions.some(o => o.id === sort) ? sort : (sortOptions[0]?.id ?? sort);
}

/**
 * 是否存在生效筛选（驱动「清除筛选」按钮显隐）。
 * 判定基准：排序偏离该源默认选项（sortOptions[0]），或来源过滤非「全部」。
 * sortOptions 为空时无排序维度，退化为仅看 sourceFilter（此时 displaySort === sort 原值，
 * 与 'relevance' 基准的旧语义等价）。
 */
export function hasActiveStoreFilters(sort: string, sortOptions: SortOption[], sourceFilter: string): boolean {
    const defaultSortId = sortOptions[0]?.id ?? 'relevance';
    const displaySort = resolveSortDisplayValue(sort, sortOptions);
    return displaySort !== defaultSortId || sourceFilter !== 'all';
}
