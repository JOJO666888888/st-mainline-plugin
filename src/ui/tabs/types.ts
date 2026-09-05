/**
 * src/ui/tabs/types.ts — 面板页签注册协议（共享基础，后续任务均使用）
 *
 * 每个功能页签实现自己的模块，通过 registerTab() 向面板注册；
 * 面板（index.ts）负责渲染页签栏并调用 mount() 挂载内容。
 */

export interface TabDefinition {
  /** 唯一 id，如 'material' / 'api' / 'design' / 'handoff' / 'review' */
  id: string;
  /** 页签标题（中文，短） */
  title: string;
  /** 挂载函数：把页签内容渲染进 container；返回清理函数（可选） */
  mount(container: HTMLElement): void | (() => void);
}

const registry = new Map<string, TabDefinition>();

/** 注册页签（同名覆盖，幂等）。 */
export function registerTab(def: TabDefinition): void {
  registry.set(def.id, def);
}

/** 取全部已注册页签（按注册顺序）。 */
export function getTabs(): TabDefinition[] {
  return [...registry.values()];
}