/**
 * 插件系统 barrel 导出
 */

export { pluginManager, getPluginManager, PluginManagerImpl } from './manager.js';
export { pluginMarket, getPluginMarket, PluginMarket } from './market.js';
export { PluginPermissionError, hasPermission, assertPermission } from './permissions.js';
export { buildPluginContext } from './host-api.js';
export type { PluginActivationContext, PluginModule, PluginRuntime } from './types.js';
export {
  getMcpToolDefinitions,
  getMcpToolHandler,
  getDeviceProfiles,
  getQuickButtons,
  getUiEntries,
  getOutputFilters,
  getIpcHandler,
  setIpcEventSink,
  emitPluginEvent,
  addUserInputListener,
  notifyUserInput,
  addSuggestionProvider,
  getSuggestionProviders,
} from './registry.js';
export type { UserInputEvent, SuggestionProvider, SuggestionContext } from './registry.js';
