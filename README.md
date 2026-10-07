# Kiểm tra VPĐT tự động – Chrome Extension dùng DeepSeek AI

Tiện ích Chrome giúp **đọc tự động văn bản đến** trên hệ thống Văn phòng điện tử (VPĐT),
**tóm tắt nội dung** và **đề xuất ý kiến xử lý** bằng AI của DeepSeek.

Tiện ích làm theo đúng quy trình kiểm tra và xử lý văn bản nội bộ:

1. Vào mục **Văn bản đến** → **VB đã nhận**
2. Mở văn bản, **xem nội dung file văn bản**
3. **Xem các file đi kèm** theo văn bản
4. **Tóm tắt nội dung** → **đưa ra ý kiến xử lý**

Bước 2 → 4 được tự động hoá: tiện ích lấy file PDF/DOCX mà VPĐT đang hiển thị, đọc chữ
ngay trên máy, gửi cho DeepSeek và trả về bản tóm tắt cùng ý kiến xử lý để bạn kiểm tra,
sửa và điền vào ô **"Ý kiến xử lý"**.

## Tính năng

- **Phân tích văn bản đang xem**: tóm tắt, số ký hiệu, cơ quan ban hành, độ khẩn, nội dung chính,
  nhiệm vụ & thời hạn, tóm tắt từng file đính kèm, mức độ ưu tiên, **ý kiến xử lý đề xuất**.
- **Tự thu thập file**: bắt các file PDF/DOCX/XLSX mà trình xem của VPĐT tải về (kể cả khi
  hệ thống dùng token đăng nhập), hoặc tải từ liên kết đính kèm trên trang, hoặc chọn file từ máy tính.
- **Đọc PDF/DOCX/XLSX ngay trong trình duyệt** (pdf.js) – không gửi file lên máy chủ nào khác ngoài DeepSeek
  (chỉ gửi phần chữ đã trích xuất).
- **Điền ý kiến xử lý** vào ô nhập trên VPĐT bằng 1 cú bấm (luôn kiểm tra lại trước khi gửi).
- **Chế độ tự động**: mở văn bản là tiện ích tự đọc và phân tích.
- **Rà soát danh sách**: đọc các dòng trong bảng "Chưa xử lý", sắp xếp theo mức ưu tiên
  (Hỏa tốc, có hạn, giấy mời…) và đề xuất hướng xử lý sơ bộ.
- **Lịch sử** các văn bản đã phân tích (lưu trên máy).
- Cấu hình danh sách phòng/ban, chức danh, yêu cầu riêng để AI soạn bút phê đúng văn phong đơn vị.

## Cài đặt

1. Tải mã nguồn: `git clone` repo này hoặc bấm **Code → Download ZIP** rồi giải nén.
2. Mở Chrome, vào `chrome://extensions`.
3. Bật **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
4. Bấm **Load unpacked** (Tải tiện ích đã giải nén) và chọn thư mục **`extension`** trong repo.
5. Ghim biểu tượng tiện ích lên thanh công cụ.

## Thiết lập lần đầu

1. Tạo API key tại <https://platform.deepseek.com/api_keys> (cần nạp tiền vào tài khoản DeepSeek).
2. Bấm biểu tượng tiện ích → ⚙ **Cài đặt**:
   - Dán **API key**, chọn model (`deepseek-chat` nhanh & rẻ; `deepseek-reasoner` suy luận kỹ hơn).
   - Bấm **Kiểm tra kết nối**.
   - Nhập tên đơn vị, chức danh người xử lý, **danh sách phòng/ban** (mỗi dòng một đơn vị).
   - Bấm **Lưu cài đặt**.
3. Mở trang VPĐT, bấm biểu tượng tiện ích → **Bật trên trang này** → đồng ý cấp quyền.
   Sau đó **tải lại trang (F5)** để tiện ích thu thập file ngay từ đầu.

## Sử dụng

1. Bấm biểu tượng tiện ích để mở **side panel** bên phải.
2. Trên VPĐT vào **Văn bản đến → VB đã nhận → Chưa xử lý**, bấm vào một văn bản.
3. Bấm vào **từng file đi kèm** trong trình xem (biểu tượng nhiều lớp) để tiện ích thu thập
   – các file hiện trong mục **File đã thu thập**, tick chọn file muốn đọc.
4. Bấm **🤖 Đọc & phân tích bằng AI**.
5. Sửa lại **Ý kiến xử lý đề xuất** nếu cần → bấm **Ý kiến xử lý** trên VPĐT, nhấp vào ô nhập
   → bấm **✍ Điền vào ô "Ý kiến xử lý"** trong side panel → kiểm tra và gửi.

Tab **Rà soát danh sách**: khi đang ở trang danh sách văn bản, bấm **Rà soát** để AI sắp xếp ưu tiên toàn bộ danh sách.

## Lưu ý

- AI có thể sai. Ý kiến xử lý chỉ là **đề xuất**, người dùng phải đọc lại trước khi gửi.
- PDF dạng **ảnh scan** không có lớp chữ nên không đọc được nội dung (DeepSeek API hiện chỉ nhận văn bản);
  khi đó AI chỉ dựa vào trích yếu/thông tin trên màn hình và tiện ích sẽ cảnh báo.
- File `.doc` (Word 97-2003) chưa được hỗ trợ – dùng bản PDF/DOCX.
- Nội dung văn bản được gửi tới DeepSeek để xử lý. Không dùng cho văn bản **Mật/Tối mật** hoặc
  văn bản mà quy định của đơn vị không cho phép gửi ra dịch vụ bên ngoài.
- API key chỉ lưu trong `chrome.storage.local` trên máy, không đồng bộ.

## Cấu trúc mã nguồn

```
extension/
├── manifest.json          # Manifest V3
├── background.js          # Service worker: mở side panel, đăng ký content script
├── content/
│   ├── hook.js            # Chạy trong trang: bắt file PDF/DOCX trình xem tải về (XHR/fetch/blob)
│   └── content.js         # Đọc tiêu đề, thông tin văn bản, bảng danh sách; điền ý kiến xử lý
├── sidepanel/             # Giao diện chính
├── options/               # Trang cài đặt
├── lib/
│   ├── deepseek.js        # Gọi DeepSeek Chat Completions API
│   ├── prompts.js         # Câu lệnh cho AI (tóm tắt + ý kiến xử lý, rà soát danh sách)
│   ├── extract.js         # Trích chữ từ PDF (pdf.js), DOCX, XLSX
│   ├── settings.js        # Cấu hình
│   ├── sites.js           # Cấp quyền & đăng ký script cho trang VPĐT
│   └── pdfjs/             # Mozilla pdf.js 4.10.38 (Apache-2.0)
└── icons/
```

Tiện ích không cần build – chỉnh sửa file rồi bấm **Reload** trong `chrome://extensions`.
