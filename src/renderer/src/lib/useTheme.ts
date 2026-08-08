import {useEffect} from 'react';
import {useStore, type ThemeMode} from '../store/useStore';
import {getElectronAPI} from './electron';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 把用户选择的主题解析为实际生效的 light/dark（auto 跟随系统） */
export function getEffectiveTheme(theme: ThemeMode): 'light' | 'dark' {
    if (theme === 'auto') {
        return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
    }
    return theme;
}

/**
 * 根据 theme 在 <html> 上切换 dark 类（Tailwind darkMode: 'class'）。
 * auto 模式下监听系统配色变化实时跟随：
 *  - 渲染进程 matchMedia 的 change（兜底）
 *  - 主进程 nativeTheme IPC 桥接（更可靠，Electron 下 matchMedia 偶发不触发时使用）
 */
export function useApplyTheme(): void {
    const theme = useStore((s) => s.theme);

    useEffect(() => {
        const apply = (systemDark?: boolean) => {
            let effective: 'light' | 'dark';
            if (theme === 'auto') {
                const dark = systemDark ?? window.matchMedia(DARK_QUERY).matches;
                effective = dark ? 'dark' : 'light';
            } else {
                effective = theme;
            }
            const root = document.documentElement;
            root.classList.toggle('dark', effective === 'dark');
            root.style.colorScheme = effective;
        };

        apply();

        if (theme !== 'auto') return;
        const mq = window.matchMedia(DARK_QUERY);
        const onMqChange = () => apply();
        mq.addEventListener('change', onMqChange);

        // 主进程 nativeTheme 桥接：系统主题变化时推送 shouldUseDarkColors
        const unsub = getElectronAPI()?.theme?.onSystemThemeChange((dark) => apply(dark));

        return () => {
            mq.removeEventListener('change', onMqChange);
            unsub?.();
        };
    }, [theme]);
}
