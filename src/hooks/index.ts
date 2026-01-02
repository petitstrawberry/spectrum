/**
 * Hooks barrel export for Spectrum v2
 */

export { useGraph, type UseGraphReturn } from './useGraph';
export { useMeters, type UseMetersReturn, type MeterData, type NodeMeter } from './useMeters';
export { useDevices, type UseDevicesReturn, type InputDevice, type OutputDevice, type PrismStatus } from './useDevices';
export { usePlugins, type UsePluginsReturn, type PluginDescriptor, type PluginInstance } from './usePlugins';
export { useAudio, type UseAudioReturn, type SystemStatus } from './useAudio';

// Node display utilities
export {
  getPrismChannelDisplay,
  getInputDeviceDisplay,
  getSinkDeviceDisplay,
  getBusDisplay,
  getBusColor,
  getVirtualOutputDisplay,
  getNodePorts,
  getPortLabel,
  type ChannelSourceInfo,
  type DeviceInfo,
  type NodeDisplayInfo,
  type PortInfo,
  type NodePortConfig,
} from './useNodeDisplay';
export { getIconForApp, getIconForDevice } from './useIcons';
export { getColorForDevice } from './useColors';
export { useChannelColors } from './useChannelColors';
