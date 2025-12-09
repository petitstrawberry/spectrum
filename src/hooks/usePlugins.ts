/**
 * usePlugins - AudioUnit plugin management hook for Spectrum v2
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getAvailablePlugins,
  addPluginToBus,
  removePluginFromBus,
  openPluginUI,
  closePluginUI,
  type PluginInfoDto,
} from '../lib/api';

// =============================================================================
// Types
// =============================================================================

export interface PluginDescriptor {
  id: string;
  name: string;
  manufacturer: string;
  category: string;
}

export interface PluginInstance {
  id: string;
  pluginId: string;
  name: string;
  enabled: boolean;
}

// =============================================================================
// Hook
// =============================================================================

export interface UsePluginsReturn {
  availablePlugins: PluginDescriptor[];
  isLoading: boolean;
  error: string | null;
  
  // Plugin management
  addPlugin: (busHandle: number, pluginId: string) => Promise<string | null>;
  removePlugin: (busHandle: number, instanceId: string) => Promise<boolean>;
  
  // UI controls
  openUi: (instanceId: string) => Promise<void>;
  closeUi: (instanceId: string) => Promise<void>;
  
  // Refresh
  refresh: () => Promise<void>;
}

export function usePlugins(): UsePluginsReturn {
  const [availablePlugins, setAvailablePlugins] = useState<PluginDescriptor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const refresh = useCallback(async () => {
    try {
      const plugins = await getAvailablePlugins();
      setAvailablePlugins(plugins.map((p: PluginInfoDto) => ({
        id: p.plugin_id,
        name: p.name,
        manufacturer: p.manufacturer,
        category: p.category,
      })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch plugins');
    }
  }, []);
  
  // Initial fetch
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await refresh();
      setIsLoading(false);
    };
    init();
  }, [refresh]);
  
  const addPlugin = useCallback(async (busHandle: number, pluginId: string): Promise<string | null> => {
    try {
      const instanceId = await addPluginToBus(busHandle, pluginId);
      return instanceId;
    } catch (e) {
      console.error('Failed to add plugin:', e);
      return null;
    }
  }, []);
  
  const removePlugin = useCallback(async (busHandle: number, instanceId: string): Promise<boolean> => {
    try {
      await removePluginFromBus(busHandle, instanceId);
      return true;
    } catch (e) {
      console.error('Failed to remove plugin:', e);
      return false;
    }
  }, []);
  
  const openUi = useCallback(async (instanceId: string): Promise<void> => {
    try {
      await openPluginUI(instanceId);
    } catch (e) {
      console.error('Failed to open plugin UI:', e);
    }
  }, []);
  
  const closeUi = useCallback(async (instanceId: string): Promise<void> => {
    try {
      await closePluginUI(instanceId);
    } catch (e) {
      console.error('Failed to close plugin UI:', e);
    }
  }, []);
  
  return {
    availablePlugins,
    isLoading,
    error,
    addPlugin,
    removePlugin,
    openUi,
    closeUi,
    refresh,
  };
}
