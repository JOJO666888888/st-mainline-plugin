/**
 * tests/llm.test.ts — callLLM / callLLMWithRetry 用例
 *
 * 全部通过注入 fake fetch（opts.fetchImpl）覆盖，不真实发包：
 *   - callLLM 成功解析 choices[0].message.content
 *   - HTTP 非 2xx 抛 LLM_HTTP_ERROR
 *   - 超时抛 LLM_TIMEOUT（fake timers + 触发 abort 的 fake fetch）
 *   - 网络错误抛 LLM_NETWORK_ERROR
 *   - 空 content 抛 LLM_EMPTY_RESPONSE
 *   - callLLMWithRetry 首次网络失败重试后成功
 *   - callLLMWithRetry 对 HTTP 4xx 不重试、直接抛出
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  callLLM,
  callLLMWithRetry,
  LLMError,
  LLMRequestMessage,
} from '../src/core/llm';

/** 测试环境无宿主 → loadSettings() 返回默认配置（baseURL=https://api.openai.com/v1） */

const MSG: LLMRequestMessage[] = [{ role: 'user', content: '你好' }];

/** 构造一个「成功」的 fake Response */
function okRes(content: string): any {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
}

/** 构造一个「HTTP 非 2xx」的 fake Response */
function httpErrorRes(status: number, statusText: string): any {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => `service error ${status}`,
  };
}

/** 注意超时场景会在真实计时器上遗留定时器，统一清理 */
afterEach(() => {
  vi.useRealTimers();
});

describe('callLLM', () => {
  it('成功解析 choices[0].message.content 并返回字符串', async () => {
    const mock = vi.fn().mockResolvedValue(okRes('你好，我是助手。'));
    const result = await callLLM(MSG, {
      fetchImpl: mock as unknown as typeof fetch,
      signal: new AbortController().signal,
    });
    expect(result).toBe('你好，我是助手。');
    // 校验请求地址与请求体字段
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual(MSG);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(2000);
  });

  it('HTTP 非 2xx 抛 LLM_HTTP_ERROR', async () => {
    const mock = vi.fn().mockResolvedValue(httpErrorRes(400, 'Bad Request'));
    await expect(
      callLLM(MSG, {
        fetchImpl: mock as unknown as typeof fetch,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'LLM_HTTP_ERROR' });
  });

  it('网络错误抛 LLM_NETWORK_ERROR', async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      callLLM(MSG, {
        fetchImpl: mock as unknown as typeof fetch,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'LLM_NETWORK_ERROR' });
  });

  it('超时抛 LLM_TIMEOUT（fast-forward 计时器触发 abort）', async () => {
    vi.useFakeTimers();
    // fake fetch：始终 pending，仅在被 abort 时拒绝，模拟长时间未响应的请求
    const mock = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const promise = callLLM(MSG, { fetchImpl: mock as unknown as typeof fetch });
    // 立即登记处理器，避免在推进计时器期间产生「未处理拒绝」警告
    promise.catch(() => undefined);
    // 推进超过默认 120s 超时
    await vi.advanceTimersByTimeAsync(121000);
    await expect(promise).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
  });

  it('响应 JSON 解析异常抛 LLM_INVALID_RESPONSE', async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
      text: async () => 'not-json',
    });
    await expect(
      callLLM(MSG, {
        fetchImpl: mock as unknown as typeof fetch,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('内容为空抛 LLM_EMPTY_RESPONSE', async () => {
    const mock = vi.fn().mockResolvedValue(okRes(''));
    await expect(
      callLLM(MSG, {
        fetchImpl: mock as unknown as typeof fetch,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'LLM_EMPTY_RESPONSE' });
  });
});

describe('callLLMWithRetry', () => {
  it('首次网络失败重试后成功，且退避后第二次调用返回内容', async () => {
    vi.useFakeTimers();
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed')) // 第一次网络失败
      .mockResolvedValueOnce(okRes('重试成功')); // 第二次成功

    const promise = callLLMWithRetry(MSG, { fetchImpl: mock as unknown as typeof fetch }, 2);
    // 放行首次调用的拒绝并进入 1s 退避
    await vi.advanceTimersByTimeAsync(0);
    // 推进超过 1s 退避，完成第二次成功调用
    await vi.advanceTimersByTimeAsync(1500);

    await expect(promise).resolves.toBe('重试成功');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('HTTP 4xx 不重试，直接抛出 LLM_HTTP_ERROR', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(httpErrorRes(400, 'Bad Request')); // 4xx：不可重试
    const err = await callLLMWithRetry(MSG, {
      fetchImpl: mock as unknown as typeof fetch,
      signal: new AbortController().signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).code).toBe('LLM_HTTP_ERROR');
    expect(mock).toHaveBeenCalledTimes(1); // 未发起第二次请求
  });
});