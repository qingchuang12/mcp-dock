import {useEffect, useState} from 'react';

/**
 * 轻量防抖 hook：value 变化后延迟 delay 毫秒才同步到返回值。
 * 用于把搜索框的即时回显与服务端查询链路解耦，
 * 避免每次按键都发起并发、不可取消的服务端请求（会导致分页总页数跳动）。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}