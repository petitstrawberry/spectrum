/**
 * Hooks barrel export for Spectrum v2
 */

export { useGraph, type UseGraphReturn } from './useGraph';
export { useMeters, type UseMetersReturn, type MeterData, type NodeMeter } from './useMeters';
export { useDevices, type UseDevicesReturn, type InputDevice, type OutputDevice, type PrismStatus } from './useDevices';
export { usePlugins, type UsePluginsReturn, type PluginDescriptor, type PluginInstance } from './usePlugins';
export { useAudio, type UseAudioReturn, type SystemStatus } from './useAudio';
