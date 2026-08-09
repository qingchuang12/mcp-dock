import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Resource } from 'i18next';

// 仅在启动时静态加载「当前语言」的 locale，另一个语言在用户切换时再动态 import，
// 避免把两份完整 JSON 都打进首屏 bundle（减小首屏解析/执行体积）。
const savedLanguage = localStorage.getItem('language') || 'en';
const initialLng = savedLanguage === 'zh' ? 'zh' : 'en';

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
