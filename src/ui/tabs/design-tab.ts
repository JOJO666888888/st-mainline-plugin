/**
 * src/ui/tabs/design-tab.ts — 「设计」页签（Task 5/7）
 *
 * 面板功能：主线设计的「生成 → 双视图审阅 → 校验 → 保存」闭环。
 *   1. 打开页签若本聊天已有保存的主线设计则自动载入；否则空态提示。
 *   2. 「生成主线」：读取材料包（trim 到 settings.materialTokenBudget）→ generateMainline；
 *      材料包读取失败显示红色错误且绝不下发生成请求；生成中显示 loading 文案；
 *      成功进入审阅双视图；失败显示错误明细 + 「修改后重试」。
 *   3. 双视图：切换「可读文档 / JSON」。JSON 视图用 <textarea> 可编辑，点击「校验」
 *      逐条红字展示错误并阻止保存；可读视图由 renderDesignDoc 实时渲染。
 *   4. 「保存到当前聊天」：校验通过才保存并 toast；失败列出错误拒绝保存。
 *   5. 「写回角色卡」复选框：勾选状态存 settings.writeBackToCharacter；保存时若勾选
 *      且校验通过则调用 writeBackToCharacter 并提示成功/失败。
 *
 * 硬性约束：所有宿主访问判空；UI 文案中文；样式前缀 stml-；不引外部 CSS。
 */
import { registerTab } from './types';
import { getHostContext } from '../../host/host-compat';
import { loadSettings, saveSettings } from '../../shared/settings';
import {
  readCurrentCharacterMaterial,
  trimMaterialToBudget,
  type CharacterMaterial,
} from '../../core/material-pack';
import { generateMainline, MainlineGenerationError } from '../../core/mainline-generator';
import { filterBySelection } from '../../shared/material-selection';
import { validateMainlineDesign, type MainlineValidationResult } from '../../core/mainline-schema';
import { renderDesignDoc } from '../../core/design-doc';
import {
  saveDesignToChat,
  loadDesignFromChat,
  writeBackToCharacter,
} from '../../core/persistence';
import type { MainlineDesign } from '../../core/mainline-schema';

/** 注入的面板样式唯一 id，避免重复插入 */
const STYLE_ID = 'stml-design-style';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .stml-design { font-family: inherit; font-size: 13px; color: #e8e8ec; line-height: 1.5; }
    .stml-design button {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #4a4a52;
      background: #2a2a32; color: #e8e8ec; cursor: pointer; font-size: 13px;
    }
    .stml-design button:hover { background: #35353f; }
    .stml-design button:disabled { opacity: 0.5; cursor: not-allowed; }
    .stml-design .stml-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .stml-design .stml-meta { margin-top: 8px; font-size: 12px; color: #9a9aa4; }
    .stml-design .stml-status { margin-top: 8px; font-size: 13px; }
    .stml-design .stml-error { margin-top: 8px; color: #ff5c5c; font-weight: 600; white-space: pre-wrap; }
    .stml-design .stml-error-list { margin-top: 6px; color: #ff5c5c; font-size: 12px; }
    .stml-design .stml-error-list li { margin-left: 16px; }
    .stml-design .stml-hint { margin-top: 8px; color: #b0b0ba; font-size: 12px; }
    .stml-design .stml-empty { color: #8a8a94; font-style: italic; margin-top: 8px; }
    .stml-design .stml-doc {
      margin-top: 8px; padding: 10px 12px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(255,255,255,0.02); white-space: pre-wrap; word-break: break-word;
      max-height: 60vh; overflow-y: auto; font-size: 12.5px;
    }
    .stml-design .stml-json {
      margin-top: 8px; width: 100%; box-sizing: border-box; min-height: 260px;
      padding: 8px 10px; border: 1px solid #3a3a40; border-radius: 6px;
      background: rgba(0,0,0,0.25); color: #e8e8ec; font-family: monospace; font-size: 12px;
      resize: vertical; white-space: pre-wrap; word-break: break-word;
    }
    .stml-design .stml-check { display: flex; align-items: center; gap: 6px; font-size: 12.5px; margin-top: 8px; }
    .stml-design .stml-toast {
      position: fixed; z-index: 100000; right: 24px; top: 24px; padding: 8px 14px;
      border-radius: 6px; font-size: 13px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    }
    .stml-design .stml-toast.stml-ok { background: #2f6f47; }
    .stml-design .stml-toast.stml-bad { background: #7f3338; }
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

/** 解析文本为 JSON；返回 { ok:true, value } 或 { ok:false, message } */
interface ParseResult {
  ok: boolean;
  value?: unknown;
  message?: string;
}
function parseJson(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: 'JSON 内容为空，无法校验。' };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    return { ok: false, message: `JSON 语法错误：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 设计页签挂载入口：内部状态 + DOM 引用 + 各动作统一在此组织。
 */
export function mountDesignTab(container: HTMLElement): void {
  const doc = container.ownerDocument ?? document;
  ensureStyle(doc);
  const ctx = getHostContext() as any;

  const root = el(doc, 'div', 'stml-design');

  // ---- 顶部按钮行：生成主线 / 视图切换 ----
  const bar = el(doc, 'div', 'stml-bar');
  const generateBtn = el(doc, 'button') as HTMLButtonElement;
  generateBtn.textContent = '生成主线';
  generateBtn.type = 'button';
  const viewToggleBtn = el(doc, 'button') as HTMLButtonElement;
  viewToggleBtn.type = 'button';
  viewToggleBtn.textContent = '切换到 JSON';
  // 有可编辑内容前禁用视图切换
  viewToggleBtn.disabled = true;
  bar.appendChild(generateBtn);
  bar.appendChild(viewToggleBtn);
  root.appendChild(bar);

  // ---- 状态 / 错误区 ----
  const status = el(doc, 'div', 'stml-status');
  root.appendChild(status);

  // ---- 校验开关区（写回角色卡复选框） ----
  const checkRow = el(doc, 'label', 'stml-check');
  const wbCheck = el(doc, 'input') as HTMLInputElement;
  wbCheck.type = 'checkbox';
  wbCheck.checked = !!loadSettings().writeBackToCharacter;
  const wbLabel = el(doc, 'span');
  wbLabel.textContent = '保存时写回角色卡（扩展字段）';
  checkRow.appendChild(wbCheck);
  checkRow.appendChild(wbLabel);
  root.appendChild(checkRow);

  // ---- 主内容区（可读文档 / JSON textarea / 校验错误列表） ----
  const content = el(doc, 'div');
  root.appendChild(content);

  // ---- 底部操作行：校验 / 保存 ----
  const actions = el(doc, 'div', 'stml-bar');
  const validateBtn = el(doc, 'button') as HTMLButtonElement;
  validateBtn.type = 'button';
  validateBtn.textContent = '校验';
  validateBtn.disabled = true;
  const saveBtn = el(doc, 'button') as HTMLButtonElement;
  saveBtn.type = 'button';
  saveBtn.textContent = '保存到当前聊天';
  saveBtn.disabled = true;
  actions.appendChild(validateBtn);
  actions.appendChild(saveBtn);
  root.appendChild(actions);

  // ---- 底部说明 ----
  const hint = el(doc, 'div', 'stml-hint');
  hint.textContent =
    '把角色卡材料包交给 LLM 生成长期主线；可在「可读文档 / JSON」双视图间切换，' +
    'JSON 视图可手改，必须先通过校验才能保存到当前聊天。';
  root.appendChild(hint);

  // ---- 内部状态 ----
  /** 权威改编源：textarea 里的 JSON 文本（任何改动都从这里读取） */
  const textarea = el(doc, 'textarea', 'stml-json') as HTMLTextAreaElement;
  textarea.style.display = 'none';
  content.appendChild(textarea);
  /** 可读文档容器 */
  const docView = el(doc, 'div', 'stml-doc');
  content.appendChild(docView);
  /** 校验错误列表容器 */
  const errorBox = el(doc, 'div', 'stml-error-list');
  errorBox.style.display = 'none';
  content.appendChild(errorBox);

  let design: MainlineDesign | null = null; // 最近一次成功通过校验的设计（用于可读视图兜底）
  let lastErrors: MainlineValidationResult['errors'] = [];
  let viewIsDoc = true;

  // ---- 小工具 ----
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

  function clearErrors(): void {
    lastErrors = [];
    errorBox.replaceChildren();
    errorBox.style.display = 'none';
  }

  function showErrors(errors: MainlineValidationResult['errors']): void {
    lastErrors = errors;
    errorBox.replaceChildren();
    if (errors.length === 0) {
      errorBox.style.display = 'none';
      return;
    }
    const list = doc.createElement('ul');
    for (const e of errors) {
      const li = doc.createElement('li');
      li.textContent = `${e.path}：${e.message}`;
      list.appendChild(li);
    }
    errorBox.appendChild(list);
    errorBox.style.display = '';
  }

  /** 权威文本：textarea 当前值 */
  function currentText(): string {
    return textarea.value;
  }

  /** 解析 + 校验当前文本；返回校验结果，解析失败时给出占位错误 */
  function parseAndValidate(): { ok: boolean; design?: MainlineDesign; errors: MainlineValidationResult['errors'] } {
    const parsed = parseJson(currentText());
    if (!parsed.ok) {
      return { ok: false, errors: [{ path: '$', message: parsed.message ?? 'JSON 解析失败' }] };
    }
    const vr = validateMainlineDesign(parsed.value);
    return { ok: vr.ok, design: vr.ok ? (parsed.value as MainlineDesign) : undefined, errors: vr.errors };
  }

  /** 渲染当前视图（doc / json） */
  function renderView(): void {
    if (viewIsDoc) {
      docView.style.display = '';
      clearErrors();
      // 可读视图：优先用最近一次有效 design，否则实时尝试解析显示
      if (design) {
        docView.textContent = renderDesignDoc(design);
      } else {
        const parsed = parseJson(currentText());
        if (parsed.ok) {
          const vr = validateMainlineDesign(parsed.value);
          if (vr.ok) docView.textContent = renderDesignDoc(parsed.value as MainlineDesign);
          else docView.textContent = '（设计尚未通过校验，无法生成可读文档）';
        } else {
          docView.textContent = '（JSON 为空或格式有误，请切到 JSON 视图检查）';
        }
      }
    } else {
      docView.style.display = 'none';
    }
  }

  /** 把某个设计载入状态（生成成功 / 载入聊天 / 手改重试后统一使用） */
  function adoptDesign(d: MainlineDesign | null, jsonText: string): void {
    design = d;
    textarea.value = jsonText;
    clearErrors();
    viewToggleBtn.disabled = false;
    validateBtn.disabled = false;
    saveBtn.disabled = false;
    renderView();
  }

  // ---- 视图切换 ----
  viewToggleBtn.addEventListener('click', () => {
    viewIsDoc = !viewIsDoc;
    viewToggleBtn.textContent = viewIsDoc ? '切换到 JSON' : '切换到可读文档';
    // 切到 JSON 前把当前 docView 内容还原为 textarea 权威文本（doc 视图改动会丢失，回到 JSON 从 textarea 重读）
    renderView();
  });

  // ---- 校验 ----
  validateBtn.addEventListener('click', () => {
    const r = parseAndValidate();
    if (r.ok && r.design) {
      design = r.design;
      showErrors([]);
      showToast('校验通过，可以保存。', true);
      status.textContent = '';
    } else {
      showErrors(r.errors);
      status.textContent = '设计未通过校验，已阻止保存，请修正后重试。';
      // 可读视图实时解析到合法设计则更新 design，方便审阅
      const parsed = parseJson(currentText());
      if (parsed.ok && validateMainlineDesign(parsed.value).ok) {
        design = parsed.value as MainlineDesign;
      }
    }
  });

  // ---- 保存到当前聊天 ----
  saveBtn.addEventListener('click', () => {
    clearErrors();
    const r = parseAndValidate();
    if (!r.ok || !r.design) {
      showErrors(r.errors);
      status.textContent = '保存中止：设计未通过校验。';
      return;
    }
    const designToSave = r.design;
    const saved = saveDesignToChat(ctx, designToSave);
    if (!saved) {
      showToast('保存失败：宿主上下文不可用。', false);
      status.textContent = '保存失败：未能写入当前聊天（宿主不可用）。';
      return;
    }
    // 仅当用户勾选「写回角色卡」时才调用写回
    let wbMsg = '';
    if (wbCheck.checked) {
      const wb = writeBackToCharacter(ctx, designToSave);
      wbMsg = wb ? '；已写回角色卡' : '；写回角色卡失败（无当前角色或宿主不支持）';
    }
    showToast(`已保存到当前聊天${wbMsg || ''}。`, true);
    status.textContent = `已保存到当前聊天${wbMsg || ''}。`;
    design = designToSave;
  });

  // ---- 写回复选框状态持久化 ----
  wbCheck.addEventListener('change', () => {
    const next = loadSettings();
    next.writeBackToCharacter = wbCheck.checked;
    saveSettings(next);
  });

  // ---- 生成主线 ----
  generateBtn.addEventListener('click', () => {
    clearErrors();
    status.textContent = '正在读取材料包…';
    generateBtn.disabled = true;
    const settings = loadSettings();
    void readCurrentCharacterMaterial().then(async (res) => {
      if ('error' in res) {
        // 材料包读取失败：红色错误展示，绝不下发生成请求
        status.classList.add('stml-error');
        status.textContent = `材料包读取失败：${res.error}`;
        console.warn(`[主线设计] 材料包读取失败：${res.error}`);
        generateBtn.disabled = false;
        return;
      }
      status.classList.remove('stml-error');
      status.textContent = `正在生成主线设计（材料 ${settings.materialTokenBudget} token 预算内）…`;
      let material: CharacterMaterial;
      try {
        // 裁剪到预算后交给生成器
        material = trimMaterialToBudget(res as CharacterMaterial, settings.materialTokenBudget);
        // 世界书条目按「材料包」页签勾选过滤：未勾选的内容不注入主线设计
        material.worldbookEntries = filterBySelection(material.worldbookEntries);
      } catch (e) {
        status.classList.add('stml-error');
        status.textContent = `材料裁减失败：${e instanceof Error ? e.message : String(e)}`;
        generateBtn.disabled = false;
        return;
      }
      try {
        const { design: d } = await generateMainline(material);
        status.classList.remove('stml-error');
        adoptDesign(d, JSON.stringify(d, null, 2));
        status.textContent = '生成成功。请审阅（可切到 JSON 手改）并通过「校验」后保存。';
      } catch (e) {
        generateBtn.disabled = false;
        status.classList.add('stml-error');
        if (e instanceof MainlineGenerationError) {
          const missingText = e.missingFields.length
            ? e.missingFields.map((g) => `${g.path}(缺:${g.fields.join(',')})`).join('，')
            : '';
          status.textContent = `生成失败：${e.message}${missingText ? `\n缺失/问题分组：${missingText}` : ''}`;
          // 「修改后重试」：把失败的最后产物（lastRaw）放到 JSON 视图供手动修正后「校验→保存」
          adoptDesign(null, e.lastRaw || '');
          viewIsDoc = false;
          viewToggleBtn.textContent = '切换到可读文档';
          renderView();
          status.textContent =
            `${status.textContent}\n已把上次输出载入 JSON 视图，请手动修改后点「校验」重试，或在生成前重新生成。`;
        } else {
          status.textContent = `生成失败：${e instanceof Error ? e.message : String(e)}`;
        }
        console.warn('[主线设计] 主线生成失败', e);
      }
    });
  });

  // ---- 打开页签：若本聊天已有保存的主线设计则自动载入，否则空态提示 ----
  const loaded = loadDesignFromChat(ctx);
  if (loaded) {
    status.textContent = '已载入本聊天保存的主线设计，可在下方审阅或重新生成。';
    adoptDesign(loaded, JSON.stringify(loaded, null, 2));
  } else {
    const empty = el(doc, 'div', 'stml-empty');
    empty.textContent = '当前聊天还没有保存的主线设计。点击「生成主线」基于角色卡材料包设计，或切到「JSON」视图粘贴现有设计后校验保存。';
    content.appendChild(empty);
  }

  container.replaceChildren(root);
}

/** 注册「设计」页签 */
registerTab({ id: 'design', title: '设计', mount: mountDesignTab });