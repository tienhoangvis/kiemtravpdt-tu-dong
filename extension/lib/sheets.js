// Gửi kết quả sang Google Apps Script web app để ghi Google Sheet và lưu file vào Google Drive.

export class SheetError extends Error {}

export async function postToSheet(settings, payload, { timeoutMs = 120000 } = {}) {
  const url = (settings.sheetUrl || '').trim();
  if (!url) throw new SheetError('Chưa cấu hình "URL ứng dụng web Google Apps Script" trong Cài đặt.');
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    throw new SheetError('URL Google Apps Script không hợp lệ (phải bắt đầu bằng https://script.google.com/).');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // text/plain để Apps Script nhận được mà không cần preflight CORS.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: settings.sheetToken || '', ...payload }),
      redirect: 'follow',
      signal: ctrl.signal
    });
  } catch (e) {
    throw new SheetError(ctrl.signal.aborted ? 'Quá thời gian chờ Google Apps Script.' : 'Không kết nối được Google Apps Script: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new SheetError(
      'Google Apps Script không trả về dữ liệu hợp lệ. Kiểm tra lại: đã triển khai "Ứng dụng web", ' +
        '"Người có quyền truy cập: Bất kỳ ai" và dùng đúng URL kết thúc bằng /exec.'
    );
  }
  if (!data.ok) throw new SheetError('Google Sheet: ' + (data.error || 'lỗi không rõ'));
  return data;
}
