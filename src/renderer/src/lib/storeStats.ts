// 商店「全部」总数缓存：localStorage 持久化，TTL=1天。
// 仅缓存当前数据源的全部条目数（非筛选后结果数），在源切换按钮左侧展示。

const TTL = 24 * 60 * 60 * 1000;
const PREFIX = 'store:total:';

type ResourceType = 'mcp' | 'skills';

interface CacheEntry {
  ts: number;
  total: number;
}

function key(resourceType: ResourceType, sourceKey: string): string {
  return `${PREFIX}${resourceType}:${sourceKey}`;
}

export function getTotalCache(resourceType: ResourceType, sourceKey: string): number | null {
  try {
    const raw = localStorage.getItem(key(resourceType, sourceKey));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (typeof entry.total !== 'number' || typeof entry.ts !== 'number') return null;
    if (Date.now() - entry.ts > TTL) return null;
    return entry.total;
  } catch {
    return null;
  }
}

export function setTotalCache(resourceType: ResourceType, sourceKey: string, total: number): void {
  try {
    const entry: CacheEntry = { ts: Date.now(), total };
    localStorage.setItem(key(resourceType, sourceKey), JSON.stringify(entry));
  } catch {
    // 隐私模式/配额异常时静默失败，不影响列表展示
  }
}

export function clearTotalCache(resourceType: ResourceType, sourceKey: string): void {
  try {
    localStorage.removeItem(key(resourceType, sourceKey));
  } catch {
    // 忽略
  }
}
