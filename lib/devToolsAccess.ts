/**
 * 开发者工具是否解锁（与设置页「连点版本」共用同一持久化键）。
 * 用于隐藏复盘、导出、审核页 trace 等，不删除任何调试能力。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const DEV_TOOLS_ENABLED_KEY = 'settings.devToolsEnabled.v1';

export async function isDevToolsUnlocked(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(DEV_TOOLS_ENABLED_KEY);
    return v === '1';
  } catch {
    return false;
  }
}
