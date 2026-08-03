import {useEffect, useState} from 'react';
import {useElectronAPI} from './electron';

/**
 * 判断当前是否运行在 macOS。
 * macOS 使用 hiddenInset 标题栏，页面头部需兼作拖拽区并为左上角交通灯预留空间。
 */
export function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  const api = useElectronAPI();
  useEffect(() => {
    let mounted = true;
    api.system.getPlatform().then(p => {
      if (mounted) setIsMac(p === 'darwin');
    }).catch(() => {
      if (mounted) setIsMac(false);
    });
    return () => { mounted = false; };
  }, [api]);
  return isMac;
}
