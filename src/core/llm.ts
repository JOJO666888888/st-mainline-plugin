/**
 * src/core/llm.ts — LLM API 配置与调用（OpenAI 兼容）
 *
 * 本模块负责：
 *   - 从 loadSettings() 读取 baseURL / model / key / temperature / maxTokens；
 *   - 向 {baseURL}/chat/completions 发起 OpenAI 兼容的 chat 请求；
 *   - 错误归一化：网络错误 / 超时 / HTTP 非 2xx / JSON 异常 / 空内容
 *     统一转为带错误码（LLMError.code）的中文 Error；
 *   - callLLMWithRetry 对「传输类错误」（超时、网络）自动重试（指数退避），
 *     对模型拒绝 / 4xx 等业务错误不做重试；
 *   - testConnection 用最小请求验证配置可用性。
 *
 * 可测试性：全部网络逻辑走可注入的 fetch（opts.fetchImpl 或模块级 defaultFetch），
 * 单测可注入 fake fetch 而不真实发包。
 */
import { loadSettings } from '../shared/settings';

/** 默认请求超时（毫秒）：120 秒 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 重试基础间隔（毫秒）：1 秒起，指数退避 */
const RETRY_BASE_DELAY_MS = 1000;

/** 错误码集合，供上层区分错误类型 */
export type LLMErrorCode =
  | 'LLM_TIMEOUT' // 请求超时（AbortError）
  | 'LLM_NETWORK_ERROR' // 网络层错误（连接失败、DNS、socket 等）
  | 'LLM_HTTP_ERROR' // HTTP 非 2xx
  | 'LLM_INVALID_RESPONSE' // 响应 JSON 解析异常
  | 'LLM_EMPTY_RESPONSE'; // 返回内容为空

/** 带错误码的中文错误，便于 UI 与重试逻辑区分 */
export class LLMError extends Error {
  code: LLMErrorCode;
  constructor(code: LLMErrorCode, message: string) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
  }
}

/** OpenAI 兼容 chat 消息角色 */
export type LLMRole = 'system' | 'user' | 'assistant';

/** 一次对话的消息 */
export interface LLMRequestMessage {
  role: LLMRole;
  content: string;
}

/** callLLM 的调用选项 */
export interface CallLLMOptions {
  /** 温度：覆盖设置项（0-1，步进 0.1） */
  temperature?: number;
  /** 最大 token：覆盖设置项 */
  maxTokens?: number;
  /** 外部 AbortSignal：一旦触发即中断请求；未提供时使用内置 120s 超时 */
  signal?: AbortSignal;
  /** 可注入的 fetch 实现，便于单测不真实发包 */
  fetchImpl?: typeof fetch;
}

/** 模块级可替换的 fetch 实现（默认用全局 fetch；无全局 fetch 时抛网络错误） */
export let defaultFetch: typeof fetch =
  typeof (globalThis as any).fetch === 'function'
    ? (globalThis as any).fetch
    : (() => {
        throw new LLMError('LLM_NETWORK_ERROR', '当前环境没有可用的 fetch 实现');
      }) as unknown as typeof fetch;

/** 校验并取回当前生效的 fetch 实现 */
function resolveFetch(impl?: typeof fetch): typeof fetch {
  const f = impl ?? defaultFetch;
  if (typeof f !== 'function') {
    throw new LLMError('LLM_NETWORK_ERROR', '当前环境没有可用的 fetch 实现');
  }
  return f;
}

/** 判断是否为「可重试」的传输类错误（超时 / 网络） */
function isRetryableCode(code: LLMErrorCode): boolean {
  return code === 'LLM_TIMEOUT' || code === 'LLM_NETWORK_ERROR';
}

/** 判断一个异常是否属于可重试的传输类错误 */
function isRetryableError(err: unknown): boolean {
  return err instanceof LLMError && isRetryableCode(err.code);
}

/** 休眠工具（供重试退避使用） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 调用 OpenAI 兼容的 LLM 接口，返回模型回答文本。
 *
 * 配置全部来自 loadSettings()：baseURL、model、apiKey、apiTemperature、
 * apiMaxTokens（后两者可被 opts 覆盖）。
 *
 * @throws {LLMError} 携带 LLMErrorCode 的中文错误：
 *   - LLM_TIMEOUT      超时
 *   - LLM_NETWORK_ERROR 网络错误
 *   - LLM_HTTP_ERROR    HTTP 非 2xx
 *   - LLM_INVALID_RESPONSE 响应不是合法 JSON
 *   - LLM_EMPTY_RESPONSE   返回内容为空
 */
export async function callLLM(
  messages: LLMRequestMessage[],
  opts: CallLLMOptions = {},
): Promise<string> {
  const settings = loadSettings();
  const baseURL = (settings.apiBaseUrl || '').replace(/\/+$/, '');
  const url = `${baseURL}/chat/completions`;
  const model = settings.apiModel;
  const temperature = opts.temperature ?? settings.apiTemperature;
  const maxTokens = opts.maxTokens ?? settings.apiMaxTokens;

  const fetchImpl = resolveFetch(opts.fetchImpl);

  // 超时控制：外部 signal 优先；否则内置 AbortController + 默认超时
  const useExternalSignal = opts.signal != null;
  const controller = new AbortController();
  const signal = useExternalSignal ? opts.signal as AbortSignal : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!useExternalSignal) {
    timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // key 为空时也照常发送，由服务端决定校验策略
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal,
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await (res as Response).text?.()) ?? '';
      } catch {
        // 读取失败不影响错误码判断
      }
      const trim = detail.trim().slice(0, 200);
      throw new LLMError(
        'LLM_HTTP_ERROR',
        `接口返回异常（HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}）` +
          (trim ? `：${trim}` : ''),
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (e) {
      throw new LLMError('LLM_INVALID_RESPONSE', '接口响应不是合法的 JSON');
    }

    const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
      ?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LLMError('LLM_EMPTY_RESPONSE', '模型返回的内容为空');
    }
    return content;
  } catch (err) {
    // 已归一化的业务错误（HTTP / JSON / 空内容）原样抛出；
    // 其余（fetch 的 AbortError、TypeError 等）一律归为传输类错误。
    if (err instanceof LLMError) throw err;
    // 我们的超时计时器触发的中止 → 超时；其余 → 网络错误
    const abortedByUs = signal.aborted && !useExternalSignal;
    if (abortedByUs) {
      throw new LLMError('LLM_TIMEOUT', '请求超时（120 秒内未返回）');
    }
    throw new LLMError('LLM_NETWORK_ERROR', '网络错误：无法连接到 LLM 服务');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 带重试的 LLM 调用。
 *
 * 仅对「传输类错误」（超时 / 网络）自动重试，间隔 1s 起指数退避；
 * 模型返回 4xx / 其他业务错误（HTTP / JSON / 空内容）时不重试，直接抛出。
 */
export async function callLLMWithRetry(
  messages: LLMRequestMessage[],
  opts: CallLLMOptions = {},
  retries = 2,
): Promise<string> {
  let attempt = 0;
  for (;;) {
    try {
      return await callLLM(messages, opts);
    } catch (err) {
      if (!isRetryableError(err) || attempt >= retries) {
        throw err;
      }
      attempt += 1;
      // 指数退避：1s、2s、4s……
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }
  }
}

/**
 * 测试连接：用最小请求（"ping"）验证当前配置是否可用。
 *
 * 成功返回 { ok: true, model: 当前配置的模型 }；
 * 失败返回 { ok: false, message: 中文错误说明 }。
 */
export async function testConnection(): Promise<
  { ok: true; model: string } | { ok: false; message: string }
> {
  try {
    await callLLM([{ role: 'user', content: 'ping' }], { temperature: 0, maxTokens: 1 });
    return { ok: true, model: loadSettings().apiModel };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

/** 把未知异常整理成中文说明文案 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}