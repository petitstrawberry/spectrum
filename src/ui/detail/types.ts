export interface PluginInstance {
  id: string;
  pluginId: string;
  name: string;
  manufacturer: string;
  enabled: boolean;
}

export interface BusInfo {
  id: string;
  handle: number;
  label: string;
  busId?: string;
  channelCount: number;
  plugins?: PluginInstance[];
}
