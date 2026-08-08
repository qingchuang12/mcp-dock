import {PLATFORM_META, type PlatformType} from '../../../shared/platform-constants';

/**
 * 返回平台类型的展示文案。
 * 品牌名（ModelScope / Smithery 等）为专有名词，保持原样；
 * 仅 `custom`（自定义）需要跟随语言切换，走翻译键。
 */
export function platformLabel(t: (key: string) => string, type: PlatformType): string {
    if (type === 'custom') return t('platformCustom');
    return PLATFORM_META[type]?.label ?? String(type);
}
