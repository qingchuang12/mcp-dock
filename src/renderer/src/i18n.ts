import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Resource } from 'i18next';

// 语言持久化策略：
// - 用户曾在设置中选择过语言（localStorage 存在 'language' 键，值为 'en' 或 'zh'）→ 保持该选择；
// - 从未选择过（无 'language' 键）→ 首次启动跟随系统语言（navigator.language），
//   匹配到中文系（zh/zh-CN 等）则用 'zh'，否则回退 'en'。
const savedLanguage = localStorage.getItem('language');
const systemLng = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
const initialLng = savedLanguage === 'zh' || savedLanguage === 'en' ? savedLanguage : systemLng;

// 初始语言同步 import，确保首屏立刻有翻译可用（不闪烁）；其余语言在切换时惰性加载。
import en from './locales/en.json';
import zh from './locales/zh.json';

const resources: Resource = {
    en: { translation: en },
    zh: { translation: zh },
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: initialLng,
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false,
        },
    });

/**
 * 切换语言时按需加载目标语言包（若尚未加载），避免初始就把全部 locale 打进首屏。
 * @returns 加载完成后的语言码
 */
export async function ensureLanguageLoaded(lang: string): Promise<string> {
    const lng = lang === 'zh' ? 'zh' : 'en';
    if (!i18n.hasResourceBundle(lng, 'translation')) {
        const mod = lng === 'zh'
            ? await import('./locales/zh.json')
            : await import('./locales/en.json');
        i18n.addResourceBundle(lng, 'translation', mod.default, true, true);
    }
    return lng;
}

export default i18n;
