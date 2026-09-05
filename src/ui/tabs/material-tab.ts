/**
 * src/ui/tabs/material-tab.ts — 「材料包」面板页签（Task 2/7）
 *
 * 面板功能：一个「读取当前角色卡」按钮；读取成功后按素材分区展示
 * （名称/描述/性格/场景/开场白/世界书列表），每区带 token 估算与展开/折叠，
 * 世界书条目用 <details> 折叠；读取失败时显示醒目的红色错误文案。
 *
 * 关键约定：本模块没有任何 LLM 生成逻辑，读取失败时仅展示错误提示，
 * 天然满足“失败不触发生成请求”。样式内联/前缀 stml-，不引外部 CSS。
 */
import { registerTab } from './types';
import {
  readCurrentCharacterMaterial,
  estimateTokens,
  CharacterMaterial,
  CharacterWorldbookEntry,
} from '../../core/material-pack';
import {
  bindEntrySelection,
  setEntrySelected,
  isEntrySelected,
  setAllEntriesSelected,
  countSelected,
} from '../../shared/material-selection';

/** 注入的面板样式唯一 id，避免重复插入 */
const STYLE_ID = 'stml-material-style';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .stml-material { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-material button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-material button:hover { background: #35353f; }
    .stml-material .stml-meta { margin-top: 8px; font-size: 12px; color: #9a9aa4; }
    .stml-material .stml-error { margin-top: 8px; color: #ff5c5c; font-weight: 600; }
    .stml-material .stml-hint { margin-top: 8px; color: #b0b0ba; }
    .stml-material .stml-section {
      margin-top: 12px; padding: 8px 10px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(255,255,255,0.02);
    }
    .stml-material details > summary { cursor: pointer; list-style: none; }
    .stml-material details > summary::-webkit-details-marker { display: none; }
    .stml-material .stml-label { font-weight: 600; }
    .stml-material .stml-tokens { color: #7fb3d5; font-size: 12px; margin-left: 6px; }
    .stml-material .stml-content {
      margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: rgba(0,0,0,0.25);
      white-space: pre-wrap; word-break: break-word; font-size: 12px;
    }
    .stml-material .stml-empty { color: #8a8a94; font-style: italic; }
    .stml-material .stml-omitted { color: #d9a451; font-size: 12px; }
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

/**
 * 渲染一个带 token 估算与展开/折叠的素材分区。
 * 无内容时显示“（空）”。
 */
function buildSection(
  doc: Document,
  title: string,
  content: string,
  tokenEstimate: number,
): HTMLElement {
  const section = el(doc, 'details', 'stml-section');
  const summary = el(doc, 'summary');
  const label = el(doc, 'span', 'stml-label');
  label.textContent = title;
  summary.appendChild(label);
  const tokens = el(doc, 'span', 'stml-tokens');
  tokens.textContent = `≈ ${tokenEstimate} token`;
  summary.appendChild(tokens);

  const body = el(doc, 'div', 'stml-content');
  if (content) {
    body.textContent = content;
  } else {
    body.textContent = '';
    body.appendChild(el(doc, 'span', 'stml-empty')).textContent = '（空）';
  }
  section.appendChild(summary);
  section.appendChild(body);
  return section;
}

/**
 * 渲染世界书条目列表：每条一个 <details>，标题为 #uid + comment + token 估算，
 * 内容为条目正文；被裁剪（content 为空但 comment 保留）时显示"已略去"。
 *
 * 1.13+ 主流写法把主要内容集中写在世界书，因此每条提供「注入主线设计」勾选框，
 * 用户可挑选哪些条目真正进入后续生成（选择状态存 shared/material-selection）。
 * @param onChanged 勾选变化后回调（用于刷新选择计数视图）
 */
function buildWorldbookSection(
  doc: Document,
  material: CharacterMaterial,
  onChanged: () => void,
): HTMLElement {
  const section = el(doc, 'div', 'stml-section');
  const title = el(doc, 'div', 'stml-label');
  const wbTokens = material.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
  title.textContent = `世界书（${material.worldbookEntries.length} 条）`;
  const tokens = el(doc, 'span', 'stml-tokens');
  tokens.textContent = `≈ ${wbTokens} token`;
  title.appendChild(tokens);
  section.appendChild(title);

  if (material.worldbookEntries.length === 0) {
    const empty = el(doc, 'div', 'stml-empty');
    empty.textContent = '（无世界书条目）';
    section.appendChild(empty);
    return section;
  }

  // 选择控制区：已选计数 + 全选 / 全不选
  const selectBar = el(doc, 'div', 'stml-meta');
  const countSpan = el(doc, 'span');
  const refreshCount = () => {
    countSpan.textContent = `已选 ${countSelected(material.worldbookEntries)}/${material.worldbookEntries.length} 条（未勾选的内容不会注入主线设计）`;
  };
  refreshCount();
  selectBar.appendChild(countSpan);

  const makeToggleAll = (on: boolean) => {
    const btn = el(doc, 'button');
    btn.textContent = on ? '全选' : '全不选';
    btn.style.marginLeft = '8px';
    btn.style.padding = '2px 8px';
    btn.addEventListener('click', () => {
      setAllEntriesSelected(material.worldbookEntries, on);
      refreshCount();
      onChanged();
    });
    return btn;
  };
  selectBar.appendChild(makeToggleAll(true));
  selectBar.appendChild(makeToggleAll(false));
  section.appendChild(selectBar);

  for (const entry of material.worldbookEntries) {
    const row = el(doc, 'div');
    row.style.display = 'flex';
    row.style.alignItems = 'flex-start';
    row.style.gap = '6px';

    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isEntrySelected(entry);
    checkbox.style.marginTop = '2px';
    checkbox.addEventListener('change', () => {
      setEntrySelected(entry, checkbox.checked);
      refreshCount();
      onChanged();
    });

    const details = el(doc, 'details');
    const summary = el(doc, 'summary');
    const heading = el(doc, 'span', 'stml-label');
    heading.textContent = `#${String(entry.uid)} ${entry.comment || '（无注释）'}`;
    summary.appendChild(heading);
    const et = el(doc, 'span', 'stml-tokens');
    et.textContent = `≈ ${entry.tokenEstimate} token`;
    summary.appendChild(et);
    details.appendChild(summary);

    if (entry.content) {
      const body = el(doc, 'div', 'stml-content');
      body.textContent = entry.content;
      details.appendChild(body);
    } else {
      const omitted = el(doc, 'div', 'stml-omitted');
      omitted.textContent = '已略去（超出材料包预算）';
      details.appendChild(omitted);
    }
    row.appendChild(checkbox);
    row.appendChild(details);
    section.appendChild(row);
  }
  return section;
}

/**
 * 渲染读取成功的材料包分区。名称直接作为标题展示，其余用分区折叠。
 * @param onChanged 世界书勾选变化后回调（用于整体刷新选择计数）
 */
function renderMaterial(
  doc: Document,
  material: CharacterMaterial,
  onChanged: () => void,
): HTMLElement {
  const root = el(doc, 'div');
  const heading = el(doc, 'div', 'stml-label');
  heading.textContent = `当前角色：${material.name || '（未命名）'}`;
  root.appendChild(heading);

  root.appendChild(
    buildSection(doc, '描述', material.description, estimateTokens(material.description)),
  );
  root.appendChild(
    buildSection(doc, '性格', material.personality, estimateTokens(material.personality)),
  );
  root.appendChild(
    buildSection(doc, '场景', material.scenario, estimateTokens(material.scenario)),
  );
  root.appendChild(
    buildSection(doc, '开场白', material.firstMessage, estimateTokens(material.firstMessage)),
  );
  root.appendChild(buildWorldbookSection(doc, material, onChanged));
  return root;
}

/**
 * 挂载材料包页签。
 * 面板固定：按钮 + 提示区 + 结果区；读取失败仅展示黄色/红色错误，不触发生成。
 * 读取成功后绑定世界书条目选择（shared/material-selection），勾选的条目才会
 * 进入「主线设计」生成。
 */
export function mountMaterialTab(container: HTMLElement): void {
  const doc = container.ownerDocument ?? document;
  ensureStyle(doc);

  const root = el(doc, 'div', 'stml-material');
  const bar = el(doc, 'div');
  const readBtn = el(doc, 'button');
  readBtn.textContent = '读取当前角色卡';
  bar.appendChild(readBtn);
  root.appendChild(bar);

  const status = el(doc, 'div');
  root.appendChild(status);

  const result = el(doc, 'div');
  root.appendChild(result);

  const hint = el(doc, 'div', 'stml-hint');
  hint.textContent = '读取角色卡人设与世界观材料包供「主线设计」使用；世界书条目可勾选注入，读取失败仅提示，不会发起任何生成请求。';
  root.appendChild(hint);

  // 本次读取到的材料包缓存，供勾选变化后整体刷新视图
  let lastMaterial: CharacterMaterial | null = null;

  const refreshView = (): void => {
    result.textContent = '';
    if (!lastMaterial) return;
    const meta = el(doc, 'div', 'stml-meta');
    const total = estimateTokens(lastMaterial.name) +
      estimateTokens(lastMaterial.description) + estimateTokens(lastMaterial.personality) +
      estimateTokens(lastMaterial.scenario) + estimateTokens(lastMaterial.firstMessage) +
      lastMaterial.worldbookEntries.reduce((s, e) => s + e.tokenEstimate, 0);
    meta.textContent = `材料包合计约 ${total} token；勾选变化会实时反映到「设计」页签的生成内容。`;
    result.appendChild(meta);
    result.appendChild(renderMaterial(doc, lastMaterial, refreshView));
  };

  const renderError = (message: string): void => {
    status.textContent = '';
    const err = el(doc, 'div', 'stml-error');
    err.textContent = `读取失败：${message}`;
    status.appendChild(err);
    result.textContent = '';
    lastMaterial = null;
  };

  readBtn.addEventListener('click', () => {
    status.textContent = '';
    result.textContent = '';
    const loading = el(doc, 'div', 'stml-hint');
    loading.textContent = '正在读取角色卡材料…';
    status.appendChild(loading);

    // 异步读取；完成后再渲染或报错（绝不在失败路径触发生成请求）
    void readCurrentCharacterMaterial().then((res) => {
      status.textContent = '';
      if ('error' in res) {
        renderError(res.error);
        console.warn(`[主线设计] 材料包读取失败：${res.error}`);
        return;
      }
      // 绑定世界书条目选择（默认全选），供「设计」页签过滤注入内容
      if (res.worldbookEntries.length > 0) {
        bindEntrySelection(res.worldbookEntries);
      }
      lastMaterial = res;
      refreshView();
    });
  });

  container.replaceChildren(root);
}

/** 注册材料包页签 */
registerTab({ id: 'material', title: '材料包', mount: mountMaterialTab });