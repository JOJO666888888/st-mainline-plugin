/**
 * src/ui/tabs/api-tab.ts — 「API 配置」页签
 *
 * 提供 LLM API 配置表单：baseURL / model / apiKey(password) / temperature /
 * maxTokens，以及「保存设置」「测试连接」「恢复默认」三个按钮。
 *
 * 数据读写全部走 loadSettings() / saveSettings()，不直接碰 window；保存时
 * 校验 baseURL / model 必填（空则提示并拒绝保存）。UI 文案为中文。
 */
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  MainlinePluginSettings,
} from '../../shared/settings';
import { testConnection } from '../../core/llm';
import { registerTab } from './types';

/** 保存一行表单标签 + 输入控件 */
interface FieldSpec {
  key: 'apiBaseUrl' | 'apiModel' | 'apiKey' | 'apiTemperature' | 'apiMaxTokens';
  label: string;
  type: 'text' | 'password' | 'range';
  step?: string;
  min?: string;
  max?: string;
  hint?: string;
}

/** 表单字段定义（顺序即渲染顺序） */
const FIELD_SPECS: FieldSpec[] = [
  { key: 'apiBaseUrl', label: '接口地址 Base URL', type: 'text', hint: '例如 https://api.openai.com/v1' },
  { key: 'apiModel', label: '模型 Model', type: 'text', hint: '例如 gpt-4o-mini' },
  { key: 'apiKey', label: 'API Key', type: 'password', hint: '留空则由服务端决定' },
  { key: 'apiTemperature', label: '温度 Temperature', type: 'range', min: '0', max: '1', step: '0.1', hint: '0（稳重）～ 1（天马行空）' },
  { key: 'apiMaxTokens', label: '最大 Token 数', type: 'text', hint: '单次回复的最大 token 上限' },
];

/** 组装表单 DOM。formInputs 以 key 为键登记各输入控件 */
function buildForm(formEl: HTMLElement): Map<string, HTMLInputElement> {
  const inputs = new Map<string, HTMLInputElement>();

  for (const spec of FIELD_SPECS) {
    const row = document.createElement('label');
    row.style.display = 'block';
    row.style.marginBottom = '10px';
    row.style.fontSize = '13px';

    const caption = document.createElement('span');
    caption.textContent = spec.label;
    caption.style.display = 'block';
    caption.style.marginBottom = '4px';
    caption.style.fontWeight = 'bold';
    row.appendChild(caption);

    const input = document.createElement('input');
    input.type = spec.type;
    if (spec.step) input.step = spec.step;
    if (spec.min) input.min = spec.min;
    if (spec.max) input.max = spec.max;
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '6px 8px';
    input.style.borderRadius = '4px';
    input.style.border = '1px solid #3a3a40';
    input.style.background = 'rgba(0,0,0,0.25)';
    input.style.color = '#e8e8ec';
    row.appendChild(input);

    if (spec.hint) {
      const hint = document.createElement('span');
      hint.textContent = spec.hint;
      hint.style.display = 'block';
      hint.style.fontSize = '12px';
      hint.style.opacity = '0.65';
      hint.style.marginTop = '2px';
      row.appendChild(hint);
    }

    formEl.appendChild(row);
    inputs.set(spec.key, input);
  }
  return inputs;
}

/** 用设置对象回填表单控件 */
function fillForm(inputs: Map<string, HTMLInputElement>, s: MainlinePluginSettings): void {
  inputs.get('apiBaseUrl')!.value = s.apiBaseUrl;
  inputs.get('apiModel')!.value = s.apiModel;
  inputs.get('apiKey')!.value = s.apiKey;
  inputs.get('apiTemperature')!.value = String(s.apiTemperature);
  inputs.get('apiMaxTokens')!.value = String(s.apiMaxTokens);
}

/** 收集表单值并校验必填；不合法时返回 null 并提示 */
function collectForm(
  inputs: Map<string, HTMLInputElement>,
  feedback: HTMLDivElement,
): MainlinePluginSettings | null {
  const baseUrl = inputs.get('apiBaseUrl')!.value.trim();
  const model = inputs.get('apiModel')!.value.trim();

  if (!baseUrl) {
    feedback.textContent = '请先填写「接口地址 Base URL」。';
    feedback.style.color = '#e5484d';
    return null;
  }
  if (!model) {
    feedback.textContent = '请先填写「模型 Model」。';
    feedback.style.color = '#e5484d';
    return null;
  }

  const current = loadSettings();
  return {
    ...current,
    apiBaseUrl: baseUrl,
    apiModel: model,
    apiKey: inputs.get('apiKey')!.value,
    apiTemperature: clampTemperature(parseFloat(inputs.get('apiTemperature')!.value)),
    apiMaxTokens: Math.max(1, Math.round(parseInt(inputs.get('apiMaxTokens')!.value, 10) || 0)),
  };
}

/** 温度限制在 [0,1] 且为 0.1 步进 */
function clampTemperature(v: number): number {
  if (Number.isNaN(v)) return DEFAULT_SETTINGS.apiTemperature;
  return Math.min(1, Math.max(0, Math.round(v * 10) / 10));
}

/** 给按钮设置通用样式 */
function styleButton(btn: HTMLButtonElement): void {
  btn.style.padding = '6px 12px';
  btn.style.cursor = 'pointer';
  btn.style.borderRadius = '4px';
  btn.style.border = '1px solid #3a3a40';
  btn.style.background = 'rgba(255,255,255,0.08)';
  btn.style.color = '#e8e8ec';
}

/**
 * 「API 配置」页签挂载入口：渲染表单并把「保存设置 / 测试连接 / 恢复默认」
 * 三个按钮的事件接好。返回清理函数（此实现无资源需要清理，仅做占位）。
 */
export function mountApiTab(container: HTMLElement): void {
  container.textContent = '';

  // 表单容器
  const formEl = document.createElement('form');
  formEl.style.display = 'flex';
  formEl.style.flexDirection = 'column';
  formEl.style.gap = '4px';
  container.appendChild(formEl);

  // 反馈区（保存 / 测试连接结果展示）
  const feedback = document.createElement('div');
  feedback.style.marginTop = '8px';
  feedback.style.fontSize = '13px';
  feedback.style.minHeight = '18px';
  container.appendChild(feedback);

  const inputs = buildForm(formEl);
  fillForm(inputs, loadSettings());

  // 按钮行
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.marginTop = '8px';
  container.appendChild(actions);

  // 保存设置
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = '保存设置';
  styleButton(saveBtn);
  saveBtn.addEventListener('click', () => {
    const next = collectForm(inputs, feedback);
    if (!next) return;
    saveSettings(next);
    feedback.textContent = '设置已保存。';
    feedback.style.color = '#46a758';
  });
  actions.appendChild(saveBtn);

  // 测试连接
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.textContent = '测试连接';
  styleButton(testBtn);
  testBtn.addEventListener('click', async () => {
    // 测试前先按当前表单校验必填项（仅提示，不落盘）
    const next = collectForm(inputs, feedback);
    if (!next) return;
    feedback.textContent = '正在测试连接…';
    feedback.style.color = '#8a8a92';
    const result = await testConnection();
    if (result.ok) {
      feedback.textContent = `连接成功，当前模型：${result.model}。`;
      feedback.style.color = '#46a758';
    } else {
      feedback.textContent = `连接失败：${result.message}`;
      feedback.style.color = '#e5484d';
    }
  });
  actions.appendChild(testBtn);

  // 恢复默认
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = '恢复默认';
  styleButton(resetBtn);
  resetBtn.addEventListener('click', () => {
    // 恢复默认仅回填表单，不自动落盘，由用户按「保存设置」确认
    fillForm(inputs, DEFAULT_SETTINGS);
    feedback.textContent = '已恢复默认值，点击「保存设置」生效。';
    feedback.style.color = '#8a8a92';
  });
  actions.appendChild(resetBtn);

  // 阻止表单原生提交（避免刷新页面）
  formEl.addEventListener('submit', (e) => e.preventDefault());
}

// 注册页签（id 用 'api'，与面板约定一致）
registerTab({ id: 'api', title: 'API 配置', mount: mountApiTab });