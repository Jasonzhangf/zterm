import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from '../lib/types';

export interface ShortcutFrequencyMap {
  [shortcutId: string]: number;
}

/**
 * 排序分值：historical * 0.8 + recent * 0.2
 * historical: 长期累积计数，不清零，缓慢衰减（每天 *0.95）
 * recent:     10分钟滑动窗口，窗口过期后清零
 */
const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const HISTORICAL_WEIGHT = 0.8;
const RECENT_WEIGHT = 0.2;
const HISTORICAL_DECAY = 0.95; // 每次窗口滚动时对 historical 乘以衰减因子

interface StoredFrequency {
  historical: ShortcutFrequencyMap;   // 长期累积
  recentWindowStart: number;          // 当前 recent 窗口起点
  recent: ShortcutFrequencyMap;       // 10分钟窗口内计数
  lastDecayAt: number;                // 上次衰减时间
}

function loadFromStorage(): StoredFrequency {
  const empty: StoredFrequency = { historical: {}, recentWindowStart: Date.now(), recent: {}, lastDecayAt: Date.now() };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SHORTCUT_FREQUENCY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredFrequency>;
    if (parsed && typeof parsed === 'object') {
      return {
        historical: (typeof parsed.historical === 'object' && parsed.historical) ? parsed.historical : {},
        recentWindowStart: typeof parsed.recentWindowStart === 'number' ? parsed.recentWindowStart : Date.now(),
        recent: (typeof parsed.recent === 'object' && parsed.recent) ? parsed.recent : {},
        lastDecayAt: typeof parsed.lastDecayAt === 'number' ? parsed.lastDecayAt : Date.now(),
      };
    }
  } catch {
    // ignore
  }
  return empty;
}

function persistToStorage(data: StoredFrequency) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEYS.SHORTCUT_FREQUENCY, JSON.stringify(data));
  }
}

/**
 * 计算排序权重分值
 * score = historical * 0.8 + recent * 0.2
 */
export function computeShortcutScore(id: string, freq: StoredFrequency): number {
  return (freq.historical[id] || 0) * HISTORICAL_WEIGHT + (freq.recent[id] || 0) * RECENT_WEIGHT;
}

export function useShortcutFrequencyStorage() {
  const [data, setData] = useState<StoredFrequency>(loadFromStorage);

  useEffect(() => {
    const loaded = loadFromStorage();
    // 如果 recent 窗口过期，做一次衰减 + 清零
    const now = Date.now();
    let needsUpdate = false;
    if (now - loaded.recentWindowStart > RECENT_WINDOW_MS) {
      // 衰减 historical（最多每天衰减一次）
      if (now - loaded.lastDecayAt > 24 * 60 * 60 * 1000) {
        const decayed: ShortcutFrequencyMap = {};
        for (const [k, v] of Object.entries(loaded.historical)) {
          const nv = v * HISTORICAL_DECAY;
          if (nv > 0.1) decayed[k] = nv;
        }
        loaded.historical = decayed;
        loaded.lastDecayAt = now;
      }
      loaded.recentWindowStart = now;
      loaded.recent = {};
      needsUpdate = true;
    }
    if (needsUpdate || loaded.recentWindowStart !== data.recentWindowStart) {
      setData(loaded);
      persistToStorage(loaded);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const recordShortcutUse = useCallback((shortcutId: string) => {
    setData((prev) => {
      const now = Date.now();
      let historical = prev.historical;
      let recent = prev.recent;
      let recentWindowStart = prev.recentWindowStart;
      let lastDecayAt = prev.lastDecayAt;

      // 累加 historical
      historical = { ...historical, [shortcutId]: (historical[shortcutId] || 0) + 1 };

      // recent 窗口滚动
      if (now - recentWindowStart > RECENT_WINDOW_MS) {
        // 衰减 historical
        if (now - lastDecayAt > 24 * 60 * 60 * 1000) {
          const decayed: ShortcutFrequencyMap = {};
          for (const [k, v] of Object.entries(historical)) {
            const nv = v * HISTORICAL_DECAY;
            if (nv > 0.1) decayed[k] = nv;
          }
          historical = decayed;
          lastDecayAt = now;
        }
        recentWindowStart = now;
        recent = { [shortcutId]: 1 };
      } else {
        recent = { ...recent, [shortcutId]: (recent[shortcutId] || 0) + 1 };
      }

      const next: StoredFrequency = { historical, recentWindowStart, recent, lastDecayAt };
      persistToStorage(next);
      return next;
    });
  }, []);

  /**
   * 返回含权重的排序分值映射
   */
  const getFrequencyMap = useCallback((): ShortcutFrequencyMap => {
    const result: ShortcutFrequencyMap = {};
    for (const id of new Set([...Object.keys(data.historical), ...Object.keys(data.recent)])) {
      result[id] = computeShortcutScore(id, data);
    }
    return result;
  }, [data]);

  return { recordShortcutUse, getFrequencyMap };
}
