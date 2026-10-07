/**
 * Kiểm tra VPĐT tự động – nhận dữ liệu từ Chrome extension, ghi vào Google Sheet
 * và lưu file văn bản vào Google Drive của tài khoản triển khai script.
 *
 * Cách cài (xem README.md trong repo):
 *  1. Đăng nhập Google bằng tài khoản sẽ lưu dữ liệu (vd. thoang9741@gmail.com).
 *  2. Tạo Google Sheet mới (sheets.new) → Tiện ích mở rộng → Apps Script.
 *  3. Dán toàn bộ file này vào Code.gs, đổi TOKEN bên dưới, bấm Lưu.
 *  4. Triển khai → Tùy chọn triển khai mới → Loại: Ứng dụng web
 *     - Thực thi dưới dạng: Tôi
 *     - Người có quyền truy cập: Bất kỳ ai
 *  5. Copy "URL ứng dụng web" và TOKEN vào phần Cài đặt của extension.
 */

// Mã bảo mật – phải trùng với ô "Mã bảo mật" trong Cài đặt của extension.
const TOKEN = 'doi-ma-nay-thanh-chuoi-bi-mat';

// Thư mục gốc trên Google Drive để lưu file văn bản.
const ROOT_FOLDER = 'VPĐT - Văn bản';

const SHEET_NAMES = {
  den: 'Văn bản đến',
  di: 'Văn bản đi',
  noi_bo: 'Văn bản nội bộ'
};
const TRIAGE_SHEET = 'Rà soát danh sách';

const DOC_HEADERS = [
  'Thời gian xuất', 'Số ký hiệu', 'Ngày văn bản', 'Cơ quan/Phòng ban ban hành', 'Loại văn bản',
  'Trích yếu', 'Độ khẩn', 'Nơi nhận', 'Người ký', 'Tóm tắt', 'Nội dung chính', 'Nhiệm vụ / thời hạn',
  'Hạn xử lý', 'Mức ưu tiên', 'Hướng xử lý', 'Ý kiến xử lý', 'Lưu ý', 'File trên Drive', 'Liên kết VPĐT', 'Model AI'
];
const TRIAGE_HEADERS = [
  'Thời gian xuất', 'Sổ văn bản', 'STT ưu tiên', 'Số ký hiệu', 'Trích yếu', 'Nơi ban hành',
  'Mức ưu tiên', 'Hướng xử lý', 'Ý kiến sơ bộ'
];

function doGet() {
  return json_({ ok: true, message: 'VPĐT export đang hoạt động.' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (TOKEN && req.token !== TOKEN) return json_({ ok: false, error: 'Sai mã bảo mật (TOKEN).' });
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      switch (req.action) {
        case 'ping': {
          const ss = spreadsheet_();
          return json_({ ok: true, name: ss.getName(), sheetUrl: ss.getUrl(), user: Session.getEffectiveUser().getEmail() });
        }
        case 'document':
          return json_(saveDocument_(req));
        case 'triage':
          return json_(saveTriage_(req));
        default:
          return json_({ ok: false, error: 'Lệnh không hợp lệ: ' + req.action });
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function saveDocument_(req) {
  const loai = SHEET_NAMES[req.loai] ? req.loai : 'den';
  const r = req.record || {};
  const ss = spreadsheet_();
  const sheet = sheet_(ss, SHEET_NAMES[loai], DOC_HEADERS);

  const links = [];
  if (req.files && req.files.length) {
    const folder = subFolder_(subFolder_(rootFolder_(), SHEET_NAMES[loai]), safeName_(r.so_ky_hieu || req.title || 'Khong-so'));
    req.files.forEach(function (f) {
      const existing = folder.getFilesByName(f.name);
      const file = existing.hasNext()
        ? existing.next()
        : folder.createFile(Utilities.newBlob(Utilities.base64Decode(f.base64), f.mime || 'application/octet-stream', f.name));
      links.push(f.name + ': ' + file.getUrl());
    });
  }

  const row = [
    new Date(), r.so_ky_hieu, r.ngay_van_ban, r.co_quan_ban_hanh, r.loai_van_ban,
    r.trich_yeu || req.title, r.do_khan, r.noi_nhan, r.nguoi_ky, r.tom_tat,
    list_(r.noi_dung_chinh), tasks_(r.nhiem_vu), r.han_xu_ly, r.muc_do_uu_tien, r.huong_xu_ly,
    r.y_kien_xu_ly, r.luu_y, links.join('\n'), req.url, req.model
  ].map(cell_);

  // Cập nhật dòng cũ nếu đã có cùng số ký hiệu, ngược lại thêm dòng mới.
  let rowIndex = -1;
  let updated = false;
  if (r.so_ky_hieu && sheet.getLastRow() > 1) {
    const keys = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === String(r.so_ky_hieu).trim()) {
        rowIndex = i + 2;
        break;
      }
    }
  }
  if (rowIndex > 0) {
    updated = true;
    if (!links.length) row[17] = sheet.getRange(rowIndex, 18).getValue();
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
    rowIndex = sheet.getLastRow();
  }
  return {
    ok: true,
    updated: updated,
    sheetName: sheet.getName(),
    row: rowIndex,
    sheetUrl: ss.getUrl() + '#gid=' + sheet.getSheetId(),
    files: links
  };
}

function saveTriage_(req) {
  const ss = spreadsheet_();
  const sheet = sheet_(ss, TRIAGE_SHEET, TRIAGE_HEADERS);
  const now = new Date();
  const label = SHEET_NAMES[req.loai] || '';
  const rows = (req.items || []).map(function (v, i) {
    return [now, label, v.stt || i + 1, v.so_ky_hieu, v.trich_yeu, v.noi_ban_hanh, v.muc_do_uu_tien, v.huong_xu_ly, v.y_kien_so_bo].map(cell_);
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, TRIAGE_HEADERS.length).setValues(rows);
  return { ok: true, sheetName: sheet.getName(), count: rows.length, sheetUrl: ss.getUrl() + '#gid=' + sheet.getSheetId() };
}

// ---------- Tiện ích ----------
function spreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  // Script độc lập (không gắn với Sheet): tự tạo Sheet và ghi nhớ ID.
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('VPĐT - Tổng hợp văn bản');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function sheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#dbe6fb');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm');
    const blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('Trang tính1');
    if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  }
  return sh;
}

function rootFolder_() {
  const it = DriveApp.getFoldersByName(ROOT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER);
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function safeName_(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 100) || 'Khong-so';
}

function list_(arr) {
  return Array.isArray(arr) ? arr.map(function (x) { return '• ' + x; }).join('\n') : arr || '';
}

function tasks_(arr) {
  if (!Array.isArray(arr)) return arr || '';
  return arr.map(function (t) {
    if (typeof t === 'string') return '• ' + t;
    return '• ' + [t.viec, t.han ? 'Hạn: ' + t.han : '', t.don_vi_de_xuat ? '→ ' + t.don_vi_de_xuat : ''].filter(String).join(' · ');
  }).join('\n');
}

// Chặn chèn công thức (giá trị bắt đầu bằng = + - @ sẽ được thêm dấu ').
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date || typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
