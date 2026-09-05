/**
 * src/ui/panel.ts — 面板渲染层
 *
 * 读取 tabs registry（各功能模块 import 时自行 registerTab），渲染页签栏 + 内容区，
 * 点击页签切换对应 mount()。面板尺寸与样式集中到这里管理。
 */
import { getTabs } from './tabs/types';

/**
 * 把页签面板挂载到 panelRoot（#st-mainline-panel）内。
 * 幂等：重复调用先清空内容再重建。
 */
export function mountPanel(panelRoot: HTMLElement): void {
  panelRoot.replaceChildren();

  const defs = getTabs();
  if (!defs.length) {
    const empty = document.createElement('div');
    empty.textContent = '暂无功能页签';
    empty.style.padding = '8px';
    empty.style.color = '#9a9aa0';
    panelRoot.appendChild(empty);
    return;
  }

  // 页签栏
  const bar = document.createElement('div');
  bar.style.display = 'flex';
  bar.style.flexWrap = 'wrap';
  bar.style.gap = '4px';
  bar.style.marginBottom = '10px';

  // 内容区
  const content = document.createElement('div');
  content.style.maxHeight = '70vh';
  content.style.overflowY = 'auto';

  let activeId = defs[0].id;

  const buttons = new Map<string, HTMLButtonElement>();
  for (const def of defs) {
    const btn = document.createElement('button');
    btn.textContent = def.title;
    btn.style.padding = '3px 8px';
    btn.style.cursor = 'pointer';
    btn.style.borderRadius = '4px';
    btn.style.border = '1px solid #4a4a52';
    btn.style.background = 'transparent';
    btn.style.color = '#e8e8ec';
    btn.addEventListener('click', () => switchTo(def.id));
    bar.appendChild(btn);
    buttons.set(def.id, btn);
  }
  panelRoot.appendChild(bar);
  panelRoot.appendChild(content);

  const cleanups = new Map<string, (() => void) | void>();

  function switchTo(id: string): void {
    for (const [tabId, btn] of buttons) {
      btn.style.background = tabId === id ? '#3a6ea5' : 'transparent';
      btn.style.color = tabId === id ? '#fff' : '#e8e8ec';
    }
    content.replaceChildren();
    // 切换前清理上一页签挂载产生的副作用
    if (activeId !== id) {
      const prev = cleanups.get(activeId);
      if (typeof prev === 'function') prev();
    }
    activeId = id;
    const def = defs.find((it) => it.id === id);
    if (!def) return;
    try {
      const cleanup = def.mount(content);
      cleanups.set(id, cleanup);
    } catch (error) {
      const errBox = document.createElement('div');
      errBox.style.color = '#e06666';
      errBox.style.padding = '8px';
      errBox.style.whiteSpace = 'pre-wrap';
      errBox.textContent = `页签「${def.title}」加载失败：\n${error instanceof Error ? error.message : String(error)}`;
      content.appendChild(errBox);
    }
  }

  switchTo(activeId);
}