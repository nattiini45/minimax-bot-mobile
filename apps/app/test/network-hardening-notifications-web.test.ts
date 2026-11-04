import { existsSync, statSync } from 'node:fs';
import { resolve } from 'metro-resolver';
let mockSDKLoaded = false;
jest.mock('expo-notifications', () => { mockSDKLoaded = true; return {}; });
function resolveNotification(platform: string): string {
  const context: Parameters<typeof resolve>[0] = {
    allowHaste: false, customResolverOptions: {}, disableHierarchicalLookup: true,
    extraNodeModules: null, dev: false, getPackage: () => null, nodeModulesPaths: [],
    resolveAsset: () => null, redirectModulePath: path => path,
    resolveHasteModule: () => null, resolveHastePackage: () => null,
    unstable_conditionNames: [], unstable_conditionsByPlatform: {}, unstable_enablePackageExports: true,
    unstable_incrementalResolution: false, unstable_logWarning: message => { throw new Error(message); },
    originModulePath: __filename, sourceExts: ['ts', 'tsx', 'js'], assetExts: new Set(),
    preferNativePlatform: platform !== 'web', getPackageForModule: () => null,
    doesFileExist: existsSync, mainFields: ['react-native', 'browser', 'main'],
    fileSystemLookup: (file: string) => {
      try { const stat = statSync(file); return { exists: true, realPath: file, type: stat.isDirectory() ? 'd' : 'f' }; }
      catch { return { exists: false }; }
    },
  };
  const result = resolve(context, '../src/native/notifications', platform);
  if (result.type !== 'sourceFile') throw new Error('Expected a notification source module');
  return result.filePath;
}
test('Metro selects a separate web module while Android and iOS keep the native implementation', () => {
  expect(resolveNotification('web')).toMatch(/notifications\.web\.ts$/);
  expect(resolveNotification('android')).toMatch(/notifications\.ts$/);
  expect(resolveNotification('ios')).toMatch(/notifications\.ts$/);
});
test('the resolved web module has API parity and no SDK evaluation or notification side effects', async () => {
  const notifications = require(resolveNotification('web')) as typeof import('../src/native/notifications');
  const listener = jest.fn();
  notifications.configureNotifications();
  expect(await notifications.requestNotificationPermission()).toBe(false);
  await notifications.notify('Generic title', 'bot:b');
  const remove = notifications.onNotificationOpened(listener);
  remove();
  expect(listener).not.toHaveBeenCalled();
  expect(mockSDKLoaded).toBe(false);
  expect(Object.keys(notifications).sort()).toEqual(['configureNotifications', 'notify', 'onNotificationOpened', 'requestNotificationPermission']);
});
