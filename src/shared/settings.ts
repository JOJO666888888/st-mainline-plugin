/**
 * src/shared/settings.ts — 插件设置读写（共享基础，Task 2/3 及后续任务复用）
 *
 * 存储位置：SillyTavern extensionSettings[SETTING_NAMESPACE]，经 saveSettingsDebounced 持久化。
 * 所有宿主访问必须判空，未就绪时返回默认设置且不抛错。
 */
import { getHostContext } from '../host/host-compat';

/** 与 src/index.ts 导出的命名空间保持一致 */
export const SETTING_NAMESPACE = 'st_mainline';

export interface MainlinePluginSettings {
  /** 是否启用插件面板 */
  enabled: boolean;
  // ---- LLM API（Task 3 使用）----
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  apiTemperature: number;
  apiMaxTokens: number;
  // ---- 材料包（Task 2 使用）----
  materialTokenBudget: number;
  // ---- 后继任务字段在此追加 ----
  /** 是否写回角色卡扩展字段（Task 5，默认关闭） */
  writeBackToCharacter: boolean;
  /** 偏差审视尾部楼层数（Task 7） */
  reviewTailFloors: number;
}

export const DEFAULT_SETTINGS: MainlinePluginSettings = {
  enabled: true,
  apiBaseUrl: 'https://api.openai.com/v1',
  apiModel: 'gpt-4o-mini',
  apiKey: '',
  apiTemperature: 0.7,
  apiMaxTokens: 2000,
  materialTokenBudget: 3000,
  writeBackToCharacter: false,
  reviewTailFloors: 12,
};

/** 读取设置：逐字段回填默认值，保证结构完整。 */
export function loadSettings(): MainlinePluginSettings {
  const ctx = getHostContext() as { extensionSettings?: Record<string, unknown> } | undefined;
  const raw = ctx?.extensionSettings?.[SETTING_NAMESPACE];
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  const merged: MainlinePluginSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MainlinePluginSettings)[]) {
    const value = (raw as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/** 保存设置：写入 extensionSettings 并触发防抖保存；无宿主时静默失败。 */
export function saveSettings(settings: MainlinePluginSettings): void {
  const ctx = getHostContext() as
    | { extensionSettings?: Record<string, unknown>; saveSettingsDebounced?: () => void }
    | undefined;
  if (!ctx) return;
  if (!ctx.extensionSettings) ctx.extensionSettings = {};
  ctx.extensionSettings[SETTING_NAMESPACE] = { ...settings };
  ctx.saveSettingsDebounced?.();
}