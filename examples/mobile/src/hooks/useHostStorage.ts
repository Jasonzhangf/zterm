/**
 * useHostStorage - 主机配置管理
 * 使用 localStorage 持久化
 */

import { useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS, type Host } from '../lib/types';
import { buildStoredHost, getResolvedSessionName, normalizeHost } from '../lib/connection-target';

// 默认空主机列表（用户需要手动添加）
const DEFAULT_HOSTS: Host[] = [];

export function useHostStorage() {
  const [hosts, setHosts] = useState<Host[]>(DEFAULT_HOSTS);
  const [isLoaded, setIsLoaded] = useState(false);

  // 从 localStorage 加载
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.HOSTS);
      if (stored) {
        const parsed = JSON.parse(stored);
        // 确保是数组
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map((item) => normalizeHost(item))
            .filter((item): item is Host => item !== null);
          setHosts(normalized);
          localStorage.setItem(STORAGE_KEYS.HOSTS, JSON.stringify(normalized));
        }
      }
    } catch (error) {
      console.error('[useHostStorage] Failed to load hosts:', error);
    }
    setIsLoaded(true);
  }, []);

  // 保存到 localStorage
  const saveHosts = useCallback((newHosts: Host[]) => {
    setHosts(newHosts);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.HOSTS, JSON.stringify(newHosts));
    }
  }, []);

  // 添加主机
  const addHost = useCallback((host: Omit<Host, 'id' | 'createdAt'>) => {
    const newHost = buildStoredHost(host);
    const newHosts = [...hosts, newHost];
    saveHosts(newHosts);
    return newHost;
  }, [hosts, saveHosts]);

  // 更新主机
  const updateHost = useCallback((id: string, updates: Partial<Omit<Host, 'id'>>) => {
    const newHosts = hosts.map(h => 
      h.id === id ? { ...h, ...updates } : h
    );
    saveHosts(newHosts);
  }, [hosts, saveHosts]);

  const upsertHost = useCallback((host: Omit<Host, 'id' | 'createdAt'>) => {
    const targetSessionName = getResolvedSessionName(host);
    const existing = hosts.find((item) =>
      item.bridgeHost === host.bridgeHost &&
      item.bridgePort === host.bridgePort &&
      getResolvedSessionName(item) === targetSessionName,
    );

    if (existing) {
      const nextHost: Host = {
        ...existing,
        ...host,
      };
      const newHosts = hosts.map((item) => (item.id === existing.id ? nextHost : item));
      saveHosts(newHosts);
      return nextHost;
    }

    const newHost = buildStoredHost(host);
    const newHosts = [...hosts, newHost];
    saveHosts(newHosts);
    return newHost;
  }, [hosts, saveHosts]);

  // 删除主机
  const deleteHost = useCallback((id: string) => {
    const newHosts = hosts.filter(h => h.id !== id);
    saveHosts(newHosts);
  }, [hosts, saveHosts]);

  // 获取主机
  const getHost = useCallback((id: string) => {
    return hosts.find(h => h.id === id);
  }, [hosts]);

  // 置顶主机
  const pinnedHosts = hosts.filter(h => h.pinned);

  // 最近连接主机
  const recentHosts = [...hosts]
    .filter(h => h.lastConnected)
    .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0))
    .slice(0, 3);

  return {
    hosts,
    isLoaded,
    addHost,
    upsertHost,
    updateHost,
    deleteHost,
    getHost,
    pinnedHosts,
    recentHosts,
  };
}
