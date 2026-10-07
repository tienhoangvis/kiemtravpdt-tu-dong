// Gọi DeepSeek Chat Completions API (tương thích định dạng OpenAI).

export class DeepSeekError extends Error {}

const STATUS_HINTS = {
  400: 'Yêu cầu không hợp lệ (kiểm tra tên model).',
  401: 'API key không đúng. Kiểm tra lại trong phần Cài đặt.',
  402: 'Tài khoản DeepSeek hết số dư. Vui lòng nạp thêm tại platform.deepseek.com.',
  422: 'Tham số không hợp lệ.',
  429: 'Gửi yêu cầu quá nhanh, vui lòng thử lại sau ít giây.',
  500: 'Máy chủ DeepSeek gặp lỗi, thử lại sau.',
  503: 'Máy chủ DeepSeek đang quá tải, thử lại sau.'
};

export async function chat(settings, messages, { json = true, signal, timeoutMs = 180000 } = {}) {
  if (!settings.apiKey) throw new DeepSeekError('Chưa nhập DeepSeek API key. Mở Cài đặt để nhập.');
  const base = (settings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const body = {
    model: settings.model || 'deepseek-chat',
    messages,
    temperature: Number(settings.temperature ?? 0.3),
    stream: false
  };
  if (json) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DeepSeekError('Quá thời gian chờ phản hồi từ DeepSeek.')), timeoutMs);
  signal?.addEventListener('abort', () => ctrl.abort(signal.reason));

  try {
    let res = await post(base, settings.apiKey, body, ctrl.signal);
    // Một số model (vd. deepseek-reasoner) không hỗ trợ response_format -> thử lại không dùng.
    if (res.status === 400 && json) {
      delete body.response_format;
      res = await post(base, settings.apiKey, body, ctrl.signal);
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.error?.message || '';
      } catch (_) {}
      throw new DeepSeekError(`DeepSeek lỗi ${res.status}: ${STATUS_HINTS[res.status] || ''} ${detail}`.trim());
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { content, usage: data.usage, model: data.model };
  } catch (e) {
    if (e?.name === 'AbortError' || ctrl.signal.aborted) {
      throw ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new DeepSeekError('Đã huỷ.');
    }
    if (e instanceof DeepSeekError) throw e;
    throw new DeepSeekError('Không kết nối được DeepSeek: ' + (e?.message || e));
  } finally {
    clearTimeout(timer);
  }
}

function post(base, apiKey, body, signal) {
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });
}

// Lấy JSON từ câu trả lời (chịu được trường hợp model bọc trong ```json ... ```).
export function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch (_) {}
  }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch (_) {}
  }
  return null;
}
