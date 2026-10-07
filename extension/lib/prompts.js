// Câu lệnh (prompt) gửi cho DeepSeek theo quy trình kiểm tra và xử lý văn bản:
//   Văn bản đến (VB đã nhận) / Văn bản đi (VB phát hành) / Văn bản nội bộ (VB nội bộ đã nhận)
//   -> Đọc nội dung file + file đi kèm -> Tóm tắt nội dung -> Đưa ra ý kiến xử lý.

export const LOAI_LABEL = {
  den: 'Văn bản đến',
  di: 'Văn bản đi',
  noi_bo: 'Văn bản nội bộ'
};

const LOAI_GUIDE = {
  den: `Đây là VĂN BẢN ĐẾN (do cơ quan, đơn vị bên ngoài gửi đến, mục "VB đã nhận").
Ý kiến xử lý là bút phê giao việc: nêu rõ đơn vị CHỦ TRÌ, đơn vị PHỐI HỢP, việc cần làm và thời hạn.`,
  di: `Đây là VĂN BẢN ĐI (do chính đơn vị mình soạn thảo và đã phát hành, mục "VB phát hành"), lãnh đạo đã ký.
Không giao xử lý lại văn bản; ý kiến xử lý tập trung vào việc THEO DÕI, ĐÔN ĐỐC thực hiện và phản hồi của nơi nhận:
nêu đơn vị soạn thảo/đầu mối theo dõi, các mốc thời hạn cam kết, việc cần báo cáo lại (nếu có). Văn bản chỉ mang tính thông báo thì đề xuất "Lưu, để biết".`,
  noi_bo: `Đây là VĂN BẢN NỘI BỘ (quyết định, thông báo, tờ trình... do các phòng/ban trong đơn vị ban hành, mục "VB nội bộ đã nhận").
Ý kiến xử lý: với văn bản đề nghị/tờ trình thì nêu đồng ý/không đồng ý/yêu cầu làm rõ và giao đơn vị thực hiện;
với quyết định/thông báo thì nêu đơn vị triển khai thực hiện hoặc "Để biết, thực hiện".`
};

function orgBlock(s) {
  const depts = (s.departments || '')
    .split(/\n|;/)
    .map((x) => x.trim())
    .filter(Boolean);
  return [
    `Đơn vị: ${s.orgName || '(chưa cấu hình)'}`,
    `Người xử lý: ${s.userRole || '(chưa cấu hình)'}`,
    depts.length ? `Các phòng/ban/người nhận có thể giao việc hoặc sao gửi:\n- ${depts.join('\n- ')}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

export function analyzeMessages(s, doc) {
  const loai = LOAI_GUIDE[doc.loai] ? doc.loai : 'den';
  const system = `Bạn là trợ lý văn thư - thư ký lãnh đạo, chuyên đọc và xử lý văn bản hành chính Việt Nam trên hệ thống Văn phòng điện tử.
Nhiệm vụ: đọc kỹ văn bản (kể cả các file đính kèm), tóm tắt chính xác, trung thực, không bịa thông tin; xác định yêu cầu, thời hạn và đề xuất ý kiến xử lý (bút phê) ngắn gọn theo văn phong hành chính.

${LOAI_GUIDE[loai]}

${orgBlock(s)}

Quy tắc soạn "y_kien_xu_ly":
- Viết 1-3 câu, văn phong bút phê của lãnh đạo, phù hợp với loại sổ văn bản ở trên.
- Chỉ dùng tên đơn vị trong danh sách trên khi phù hợp; nếu không chắc thì chọn đơn vị gần nhất và ghi chú trong "luu_y".
- Văn bản chỉ để biết thì đề xuất dạng "Để biết" hoặc "Lưu, để biết"; giấy mời thì nêu rõ ai dự / cử ai dự.
- Ví dụ: "P. TCLĐ phối hợp P. HCTH, CSKD triển khai thực hiện và báo cáo đúng thời hạn. Sao gửi Chủ tịch, Ban điều hành, Ban KSNB."
${s.customInstructions ? '\nYêu cầu bổ sung của người dùng:\n' + s.customInstructions : ''}

Chỉ trả về MỘT đối tượng JSON hợp lệ (không kèm giải thích), đúng cấu trúc:
{
  "so_ky_hieu": "số/ký hiệu văn bản",
  "ngay_van_ban": "dd/mm/yyyy hoặc rỗng",
  "co_quan_ban_hanh": "cơ quan/phòng ban ban hành hoặc soạn thảo",
  "noi_nhan": "nơi nhận chính (nếu có)",
  "nguoi_ky": "người ký (nếu có)",
  "loai_van_ban": "Công văn | Quyết định | Giấy mời | Thông báo | Kế hoạch | ...",
  "trich_yeu": "trích yếu ngắn",
  "do_khan": "Thường | Khẩn | Thượng khẩn | Hỏa tốc",
  "tom_tat": "tóm tắt 3-6 câu nội dung chính của văn bản và các file đính kèm",
  "noi_dung_chinh": ["các ý chính / yêu cầu cụ thể"],
  "nhiem_vu": [{"viec": "việc phải làm", "han": "thời hạn hoặc rỗng", "don_vi_de_xuat": "đơn vị nên giao"}],
  "han_xu_ly": "thời hạn quan trọng nhất hoặc rỗng",
  "file_dinh_kem": [{"ten": "tên file", "tom_tat": "1-2 câu"}],
  "muc_do_uu_tien": "Cao | Trung bình | Thấp",
  "huong_xu_ly": "Để biết | Giao thực hiện | Theo dõi, đôn đốc | Cử người dự họp | Trình ký | Lưu",
  "y_kien_xu_ly": "ý kiến xử lý đề xuất",
  "luu_y": "điểm cần lưu ý, rủi ro, hoặc thông tin còn thiếu"
}`;

  const parts = [`# Sổ văn bản\n${LOAI_LABEL[loai]}${doc.breadcrumb ? ` (${doc.breadcrumb})` : ''}`];
  if (doc.docTitle) parts.push(`# Tiêu đề văn bản đang xem\n${doc.docTitle}`);
  if (doc.pageText) parts.push(`# Thông tin hiển thị trên màn hình (siêu dữ liệu, lịch sử xử lý)\n${doc.pageText}`);
  for (const f of doc.files) {
    parts.push(`# Nội dung file: ${f.name}${f.warning ? ` (lưu ý: ${f.warning})` : ''}\n${f.text}`);
  }
  if (!doc.files.length && doc.viewerText) {
    parts.push(`# Nội dung đang hiển thị trong trình xem file\n${doc.viewerText}`);
  }

  let user = parts.join('\n\n');
  const max = Number(s.maxChars) || 60000;
  if (user.length > max) user = user.slice(0, max) + '\n…[nội dung đã được cắt bớt do quá dài]';

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Hãy đọc văn bản dưới đây và trả về JSON theo yêu cầu.\n\n${user}` }
  ];
}

export function triageMessages(s, rows, loai = 'den') {
  if (!LOAI_GUIDE[loai]) loai = 'den';
  const system = `Bạn là trợ lý văn thư - thư ký lãnh đạo trên hệ thống Văn phòng điện tử.
Người dùng cung cấp danh sách ${LOAI_LABEL[loai].toLowerCase()} đang hiển thị (mỗi dòng gồm số ký hiệu/trích yếu/ngày, ngày nhận hoặc ngày khởi tạo, nơi ban hành, loại văn bản, lãnh đạo ký, độ khẩn...).
${LOAI_GUIDE[loai]}
Hãy phân loại, sắp xếp theo mức độ ưu tiên (Hỏa tốc/Khẩn, có thời hạn gần, giấy mời họp lên đầu) và đề xuất hướng xử lý sơ bộ cho từng văn bản dựa trên trích yếu.

${orgBlock(s)}
${s.customInstructions ? '\nYêu cầu bổ sung:\n' + s.customInstructions : ''}

Chỉ trả về JSON hợp lệ dạng:
{
  "tong_quan": "nhận xét chung 1-3 câu",
  "van_ban": [
    {"stt": 1, "so_ky_hieu": "", "trich_yeu": "", "noi_ban_hanh": "", "muc_do_uu_tien": "Cao | Trung bình | Thấp", "huong_xu_ly": "Để biết | Giao thực hiện | Theo dõi, đôn đốc | Cử người dự họp | Trình ký | Lưu", "y_kien_so_bo": "ý kiến xử lý ngắn"}
  ]
}
Danh sách "van_ban" đã được sắp xếp từ ưu tiên cao xuống thấp.`;

  const lines = rows.map((r, i) => {
    const cells = r.headers.length === r.cells.length ? r.cells.map((c, j) => `${r.headers[j]}: ${c}`) : r.cells;
    return `${i + 1}. ${cells.join(' | ').replace(/\n+/g, ' ')}`;
  });
  let user = lines.join('\n');
  const max = Number(s.maxChars) || 60000;
  if (user.length > max) user = user.slice(0, max);
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Danh sách văn bản:\n${user}\n\nTrả về JSON theo yêu cầu.` }
  ];
}

// Báo cáo tổng hợp sau khi kiểm tra tự động nhiều văn bản.
export function reportMessages(s, items) {
  const system = `Bạn là trợ lý văn thư - thư ký lãnh đạo trên hệ thống Văn phòng điện tử.
Người dùng vừa kiểm tra tự động các văn bản chưa đọc ở các sổ: Văn bản đến (VB đã nhận), Văn bản đi (VB phát hành), Văn bản nội bộ (VB nội bộ đã nhận).
Dựa trên bản tóm tắt và ý kiến xử lý đề xuất của từng văn bản, hãy lập báo cáo tổng hợp ngắn gọn cho lãnh đạo.

${orgBlock(s)}
${s.customInstructions ? '\nYêu cầu bổ sung:\n' + s.customInstructions : ''}

Chỉ trả về JSON hợp lệ dạng:
{
  "tong_quan": "2-4 câu nhận xét chung về các văn bản đã kiểm tra",
  "can_xu_ly_ngay": [{"so_ky_hieu": "", "so_van_ban": "Văn bản đến | Văn bản đi | Văn bản nội bộ", "ly_do": "vì sao cần ưu tiên", "han": ""}],
  "khuyen_nghi": ["khuyến nghị hành động cụ thể cho lãnh đạo, sắp xếp theo mức độ quan trọng"],
  "theo_so": {"den": "nhận xét ngắn về văn bản đến", "di": "nhận xét ngắn về văn bản đi", "noi_bo": "nhận xét ngắn về văn bản nội bộ"},
  "moc_thoi_han": [{"han": "dd/mm/yyyy", "viec": "", "so_ky_hieu": ""}]
}`;
  const lines = items.map((it, i) => {
    const r = it.result || {};
    return [
      `${i + 1}. [${LOAI_LABEL[it.loai] || ''}] ${r.so_ky_hieu || it.key}: ${r.trich_yeu || it.title || ''}`,
      r.do_khan && `   Độ khẩn: ${r.do_khan}`,
      r.han_xu_ly && `   Hạn: ${r.han_xu_ly}`,
      r.muc_do_uu_tien && `   Ưu tiên: ${r.muc_do_uu_tien}`,
      r.tom_tat && `   Tóm tắt: ${r.tom_tat}`,
      r.y_kien_xu_ly && `   Ý kiến đề xuất: ${r.y_kien_xu_ly}`
    ]
      .filter(Boolean)
      .join('\n');
  });
  let user = lines.join('\n');
  const max = Number(s.maxChars) || 60000;
  if (user.length > max) user = user.slice(0, max);
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Danh sách văn bản đã kiểm tra:\n${user}\n\nTrả về JSON theo yêu cầu.` }
  ];
}
