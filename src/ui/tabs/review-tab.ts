/**
 * src/ui/tabs/review-tab.ts — 「审视」页签（Task 7/7）
 *
 * 面板功能（只读，不改写任何数据）：
 *   1. 打开页签：loadDesignFromChat 载入本聊天已保存的主线设计；无设计 → 空态提示。
 *   2. 卷号下拉选择（默认第 1 卷）；「运行审视」读取宿主 ctx.chat → runDeviationReview
 *      → 渲染报告（总体 + 逐卷 verdict 徽标：符合=绿 / 偏离=橙 / 信息不足=灰 + note）。
 *   3. 运行中 loading；错误红字展示；报告区标注「本次为只读审视，未写入任何聊天数据」。
 *
 * 硬性约束：所有宿主访问判空；UI 文案中文；样式前缀 stml-；绝不写数据。
 */
import { registerTab } from './types';
import { getHostContext } from '../../host/host-compat';
import { loadDesignFromChat } from '../../core/persistence';
import { runDeviationReview, type DeviationReviewReport, type VerdictName } from '../../core/review';
import type { MainlineDesign } from '../../core/mainline-schema';

/** 注入的面板样式唯一 id，避免重复插入 */
const STYLE_ID = 'stml-review-style';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .stml-review { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-review select {
      padding: 4px 8px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; font-size: 13px;
    }
    .stml-review button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-review button:hover { background: #35353f; }
    .stml-review button:disabled { opacity: 0.5; cursor: not-allowed; }
    .stml-review .stml-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .stml-review .stml-status { margin-top: 8px; font-size: 13px; }
    .stml-review .stml-error { margin-top: 8px; color: #ff5c5c; font-weight: 600; white-space: pre-wrap; }
    .stml-review .stml-empty { color: #8a8a94; font-style: italic; margin-top: 8px; }
    .stml-review .stml-report { margin-top: 10px; }
    .stml-review .stml-overall {
      padding: 8px 10px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(255,255,255,0.02); font-size: 13px; white-space: pre-wrap;
    }
    .stml-review .stml-badge {
      display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px;
      margin-right: 6px; color: #fff;
    }
    .stml-review .stml-badge-ok { background: #2f6f47; }
    .stml-review .stml-badge-off { background: #a86a24; }
    .stml-review .stml-badge-none { background: #5a5a62; }
    .stml-review .stml-verdict { margin-top: 6px; font-size: 12.5px; color: #c8c8d0; }
    .stml-review .stml-verdict-title { font-weight: 600; color: #e8e8ec; }
    .stml-review .stml-verdict-note { margin-top: 2px; color: #a0a0ac; white-space: pre-wrap; }
    .stml-review .stml-readonly {
      margin-top: 10px; font-size: 12px; color: #8a8a94;
    }
    .stml-review .stml-note { margin-top: 6px; color: #b0b0ba; font-size: 12px; }
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

/** verdict 徽标类名 */
function badgeClass(v: VerdictName): string {
  if (v === '符合') return 'stml-badge-ok';
  if (v === '偏离') return 'stml-badge-off';
  return 'stml-badge-none';
}

/** 渲染逐卷 verdict 行列 */
function renderVerdict(doc: Document, v: DeviationReviewReport['verdicts'][number]): HTMLElement {
  const box = el(doc, 'div', 'stml-verdict');
  const badge = el(doc, 'span', `stml-badge ${badgeClass(v.verdict)}`);
  badge.textContent = v.verdict;
  const title = el(doc, 'span', 'stml-verdict-title');
  const volLabel = v.volumeTitle ? `《${v.volumeTitle}》` : `第 ${v.volumeIndex + 1} 卷`;
  title.textContent = `第 ${v.volumeIndex + 1} 卷 ${volLabel}`;
  box.appendChild(badge);
  box.appendChild(title);
  if (v.note) {
    const note = el(doc, 'div', 'stml-verdict-note');
    note.textContent = v.note;
    box.appendChild(note);
  }
  return box;
}

/**
 * 审视页签挂载入口。
 */
export function mountReviewTab(container: HTMLElement): void {
  const doc = container.ownerDocument ?? document;
  ensureStyle(doc);
  const ctx = getHostContext() as any;

  const root = el(doc, 'div', 'stml-review');
  const status = el(doc, 'div', 'stml-status');
  const reportBox = el(doc, 'div', 'stml-report');

  // 载入设计；无设计则空态
  const design = loadDesignFromChat(ctx);

  if (!design) {
    const empty = el(doc, 'div', 'stml-empty');
    empty.textContent = '请先在「设计」页签生成并保存主线，再进行偏差审视。';
    root.appendChild(empty);
    container.replaceChildren(root);
    return;
  }

  // ---- 顶部操作行：卷选择 + 运行审视 ----
  const bar = el(doc, 'div', 'stml-bar');
  const label = doc.createElement('span');
  label.textContent = '审视卷：';
  bar.appendChild(label);
  const select = el(doc, 'select') as HTMLSelectElement;
  design.volumes.forEach((v, i) => {
    const opt = doc.createElement('option');
    opt.value = String(i);
    opt.textContent = `第 ${i + 1} 卷《${v.title || ''}》`;
    select.appendChild(opt);
  });
  select.value = '0'; // 默认第一卷
  bar.appendChild(select);
  const runBtn = el(doc, 'button') as HTMLButtonElement;
  runBtn.type = 'button';
  runBtn.textContent = '运行审视';
  bar.appendChild(runBtn);
  root.appendChild(bar);

  root.appendChild(status);
  root.appendChild(reportBox);

  // ---- 底部只读说明 ----
  const readonly = el(doc, 'div', 'stml-readonly');
  readonly.textContent = '本次为只读审视，未写入任何聊天数据，也不修改主线设计。';
  root.appendChild(readonly);

  // ---- 渲染报告 ----
  function renderReport(report: DeviationReviewReport): void {
    reportBox.replaceChildren();
    const overall = el(doc, 'div', 'stml-overall');
    overall.textContent = report.overall || '（模型未给出总体判断）';
    reportBox.appendChild(overall);
    for (const v of report.verdicts) {
      reportBox.appendChild(renderVerdict(doc, v));
    }
  }

  // ---- 运行审视 ----
  runBtn.addEventListener('click', () => {
    const volumeIndex = Number(select.value || '0');
    status.classList.remove('stml-error');
    status.textContent = '正在审视最近正文与主线设计的贴合情况…';
    runBtn.disabled = true;
    reportBox.replaceChildren();
    void runDeviationReview(design, ctx?.chat, { volumeIndex })
      .then((report) => {
        status.textContent = '';
        renderReport(report);
      })
      .catch((err) => {
        status.classList.add('stml-error');
        status.textContent = `审视失败：${err instanceof Error ? err.message : String(err)}`;
        console.warn('[主线设计] 偏差审视失败', err);
      })
      .finally(() => {
        runBtn.disabled = false;
      });
  });

  container.replaceChildren(root);
}

/** 注册「审视」页签 */
registerTab({ id: 'review', title: '审视', mount: mountReviewTab });