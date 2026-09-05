/**
 * src/ui/tabs/handoff-tab.ts — 「转交」面板页签（Task 6/7）
 *
 * 面板功能：把用户审阅确认后的主线设计渲染成立纲指令文本，供复制 / 导出，
 * 交给 shujuku continuation 作为续写任务的初始要求。
 *   1. 打开页签若本聊天已有保存的主线设计则渲染到 <pre> 只读区（可滚动）；
 *      无设计时显示空态提示「请先在『设计』页签生成并保存主线」。
 *   2. 「一键复制」：优先 navigator.clipboard.writeText（try/catch），失败回退
 *      document.execCommand('copy') + 临时 textarea；成功/失败均 toast/内联提示。
 *   3. 「导出 .md」：Blob + 临时 <a download> 触发下载，文件名 buildHandoffFilename。
 *   4. 顶部与底部一行使用说明（中文）；样式前缀 stml-，不引外部 CSS。
 *
 * 硬性约束：复制/下载类操作不做任何向导吞异常，且在有浏览器环境才执行；
 * 宿主访问判空。
 */
import { registerTab } from './types';
import { getHostContext } from '../../host/host-compat';
import { loadDesignFromChat } from '../../core/persistence';
import {
  renderHandoffInstruction,
  buildHandoffFilename,
} from '../../core/handoff';

/** 注入的面板样式唯一 id，避免重复插入 */
const STYLE_ID = 'stml-handoff-style';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .stml-handoff { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-handoff button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-handoff button:hover { background: #35353f; }
    .stml-handoff button:disabled { opacity: 0.5; cursor: not-allowed; }
    .stml-handoff .stml-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .stml-handoff .stml-hint { margin-top: 8px; color: #b0b0ba; font-size: 12px; }
    .stml-handoff .stml-empty { color: #8a8a94; font-style: italic; margin-top: 8px; }
    .stml-handoff .stml-status { margin-top: 8px; font-size: 13px; }
    .stml-handoff .stml-pre {
      margin-top: 8px; padding: 10px 12px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(0,0,0,0.25); color: #e8e8ec; font-family: monospace; font-size: 12px;
      white-space: pre-wrap; word-break: break-word; overflow-y: auto; max-height: 60vh;
    }
    .stml-handoff .stml-toast {
      position: fixed; z-index: 100000; right: 24px; top: 24px; padding: 8px 14px;
      border-radius: 6px; font-size: 13px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    }
    .stml-handoff .stml-toast.stml-ok { background: #2f6f47; }
    .stml-handoff .stml-toast.stml-bad { background: #7f3338; }
  `;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** 便捷节点创建 */
function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** 复制文本：优先 Clipboard API，失败回退 execCommand；返回是否成功 */
function copyText(doc: Document, text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(doc, text),
    );
  }
  return Promise.resolve(fallbackCopy(doc, text));
}

/** execCommand('copy') 回退：临时 textarea + 选区复制 */
function fallbackCopy(doc: Document, text: string): boolean {
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    // 移出可视区但不隐藏，保证 select/execCommand 可用
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    (doc.body ?? doc.documentElement).appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = doc.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 触发下载：Blob + 临时 <a download> */
function downloadText(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body ?? document.documentElement).appendChild(a);
    a.click();
    a.remove();
    // 异步释放 object URL，避免泄漏
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 转交页签挂载入口：载入聊天里的主线设计，渲染 → 复制 / 导出。
 */
export function mountHandoffTab(container: HTMLElement): void {
  const doc = container.ownerDocument ?? document;
  ensureStyle(doc);
  const ctx = getHostContext() as any;

  const root = el(doc, 'div', 'stml-handoff');

  // ---- 顶部操作行 ----
  const bar = el(doc, 'div', 'stml-bar');
  const copyBtn = el(doc, 'button') as HTMLButtonElement;
  copyBtn.type = 'button';
  copyBtn.textContent = '一键复制';
  copyBtn.disabled = true;
  const exportBtn = el(doc, 'button') as HTMLButtonElement;
  exportBtn.type = 'button';
  exportBtn.textContent = '导出 .md';
  exportBtn.disabled = true;
  bar.appendChild(copyBtn);
  bar.appendChild(exportBtn);
  root.appendChild(bar);

  // ---- 状态 / 提示区 ----
  const status = el(doc, 'div', 'stml-status');
  root.appendChild(status);

  // ---- 只读立纲指令区 ----
  const pre = el(doc, 'pre', 'stml-pre');
  root.appendChild(pre);

  // ---- 底部使用说明 ----
  const hint = el(doc, 'div', 'stml-hint');
  hint.textContent =
    '把上面的立纲要求复制或导出为 .md，粘贴到续写推进（shujuku continuation）的' +
    '初始要求中，即可创建以该主线为主纲的续写任务。';
  root.appendChild(hint);

  /** 全局 toast（成功绿 / 失败红） */
  function showToast(message: string, ok: boolean): void {
    try {
      const t = doc.createElement('div');
      t.className = `stml-toast ${ok ? 'stml-ok' : 'stml-bad'}`;
      t.textContent = message;
      (doc.body ?? doc.documentElement).appendChild(t);
      setTimeout(() => t.remove(), 2600);
    } catch {
      /* toast 失败不影响主流程 */
    }
  }

  function enable(hasDesign: boolean): void {
    copyBtn.disabled = !hasDesign;
    exportBtn.disabled = !hasDesign;
  }

  // ---- 打开页签：若有已保存的主线设计则渲染，否则空态 ----
  const design = loadDesignFromChat(ctx);
  if (design) {
    pre.textContent = renderHandoffInstruction(design);
    status.textContent = '已就绪：下方为可直接使用的立纲要求文本。';
    enable(true);

    // ---- 一键复制 ----
    copyBtn.addEventListener('click', () => {
      const text = pre.textContent ?? '';
      showToast('正在复制…', true);
      void copyText(doc, text).then((ok) => {
        if (ok) {
          showToast('立纲要求已复制，可粘贴到续写任务的初始要求中。', true);
          status.textContent = '已复制立纲要求。';
        } else {
          showToast('复制失败：浏览器不支持自动复制，请手动全选后复制。', false);
          status.textContent = '复制失败：请手动全选下方文本后 Ctrl+C 复制。';
        }
      });
    });

    // ---- 导出 .md ----
    exportBtn.addEventListener('click', () => {
      const text = pre.textContent ?? '';
      const filename = buildHandoffFilename(design);
      const ok = downloadText(filename, text);
      if (ok) {
        showToast(`已导出 ${filename}。`, true);
        status.textContent = `已导出 ${filename}。`;
      } else {
        showToast('导出失败：浏览器不支持自动下载，请手动复制到文件。', false);
        status.textContent = '导出失败：请手动复制文本到本地文件。';
      }
    });
  } else {
    const empty = el(doc, 'div', 'stml-empty');
    empty.textContent = '当前聊天还没有保存的主线设计。请先在『设计』页签生成并保存主线。';
    root.insertBefore(empty, hint);
    status.textContent = '';
    enable(false);
  }

  container.replaceChildren(root);
}

/** 注册「转交」页签 */
registerTab({ id: 'handoff', title: '转交', mount: mountHandoffTab });