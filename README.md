# Kiểm tra VPĐT tự động – Chrome Extension dùng DeepSeek AI

Tiện ích Chrome giúp **đọc tự động văn bản** trên hệ thống Văn phòng điện tử (VPĐT),
**tóm tắt nội dung**, **đề xuất ý kiến xử lý** bằng AI của DeepSeek và **xuất kết quả ra
Google Sheet, lưu file vào Google Drive**.

Tiện ích làm theo đúng quy trình kiểm tra và xử lý văn bản nội bộ, cho cả 3 sổ văn bản:

| Sổ văn bản | Mục trên VPĐT | Quy trình |
|---|---|---|
| **Văn bản đến** | VB đã nhận | Xem nội dung file → xem file đi kèm → tóm tắt → ý kiến xử lý → xuất Google Sheet/Drive |
| **Văn bản đi** | VB phát hành | Đọc nội dung → tóm tắt → ý kiến xử lý (theo dõi, đôn đốc) → xuất Google Sheet/Drive |
| **Văn bản nội bộ** | VB nội bộ đã nhận | Đọc nội dung → tóm tắt → ý kiến xử lý → xuất Google Sheet/Drive |

Tiện ích lấy file PDF/DOCX mà VPĐT đang hiển thị, đọc chữ ngay trên máy, gửi cho DeepSeek
và trả về bản tóm tắt cùng ý kiến xử lý để bạn kiểm tra, sửa, điền vào ô **"Ý kiến xử lý"**
rồi ghi vào Google Sheet (mỗi sổ một trang tính) kèm file gốc trên Google Drive.

## Tính năng

- **🤖 Kiểm tra tự động văn bản chưa đọc** (tab *Tự động*): tiện ích tự vào lần lượt
  **Văn bản đến → VB đã nhận**, **Văn bản đi → VB phát hành**, **Văn bản nội bộ → VB nội bộ đã nhận**,
  tìm các văn bản **chưa đọc** (có chấm xanh / chữ in đậm), mở từng văn bản, đọc file chính và file đính kèm,
  tóm tắt, đề xuất ý kiến xử lý, ghi Google Sheet/Drive, đóng văn bản rồi sang văn bản tiếp theo.
  Cuối cùng lập **Báo cáo tổng hợp & khuyến nghị** (việc cần xử lý ngay, khuyến nghị, mốc thời hạn).
  Có thể **lặp lại mỗi N phút** và tự bỏ qua văn bản đã kiểm tra.

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
- **Tự nhận diện sổ văn bản** (đến / đi / nội bộ) theo trang đang mở – AI soạn ý kiến phù hợp từng loại;
  có thể chọn tay nếu nhận diện sai.
- **Xuất Google Sheet + lưu Google Drive**: mỗi văn bản một dòng (cập nhật nếu đã có cùng số ký hiệu),
  file gốc lưu trong thư mục `VPĐT - Văn bản/<Sổ văn bản>/<Số ký hiệu>/`. Có thể bật tự động xuất.
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

## Kết nối Google Sheet & Google Drive (tài khoản thoang9741@gmail.com)

Tiện ích ghi dữ liệu qua một **Google Apps Script** chạy dưới tài khoản Google của bạn, nên
dữ liệu và file nằm trong Google Drive của tài khoản đó – không cần tạo dự án Google Cloud.

1. Mở trình duyệt, **đăng nhập Google bằng tài khoản `thoang9741@gmail.com`**.
2. Vào <https://sheets.new> để tạo Google Sheet mới, đặt tên, ví dụ **VPĐT - Tổng hợp văn bản**.
3. Trên Sheet: menu **Tiện ích mở rộng → Apps Script**.
4. Xoá nội dung có sẵn trong `Code.gs`, dán toàn bộ nội dung file
   [`apps-script/Code.gs`](apps-script/Code.gs) trong repo này.
5. Sửa dòng `const TOKEN = '...'` thành một chuỗi bí mật của bạn (ví dụ `Vishipel@2026#abc`). Bấm 💾 **Lưu**.
6. Bấm **Triển khai → Tùy chọn triển khai mới** → bánh răng ⚙ chọn **Ứng dụng web**:
   - **Thực thi dưới dạng**: *Tôi (thoang9741@gmail.com)*
   - **Người có quyền truy cập**: *Bất kỳ ai*
   - Bấm **Triển khai** → **Cấp quyền truy cập** → chọn tài khoản → *Nâng cao → Đi tới … (không an toàn)* → **Cho phép**
     (đây là script của chính bạn nên Google cảnh báo như vậy).
7. Copy **URL ứng dụng web** (kết thúc bằng `/exec`).
8. Trong tiện ích: ⚙ **Cài đặt → Google Sheet & Google Drive**: dán URL, nhập **Mã bảo mật** (đúng TOKEN ở bước 5),
   bấm **Kiểm tra Google Sheet** → thấy "✔ Kết nối thành công (tài khoản thoang9741@gmail.com)" → **Lưu cài đặt**.

> **Đã cài script từ bản trước?** Dán lại `Code.gs` mới (có thêm trang *Báo cáo tổng hợp*) và triển khai phiên bản mới như dưới đây.
>
> Khi sửa `Code.gs` sau này, cần **Triển khai → Quản lý các bản triển khai → ✏ → Phiên bản: Mới → Triển khai**
> thì thay đổi mới có hiệu lực (URL giữ nguyên).

Kết quả trên Google Sheet:

- Trang **Văn bản đến**, **Văn bản đi**, **Văn bản nội bộ**: thời gian xuất, số ký hiệu, ngày, cơ quan ban hành, loại,
  trích yếu, độ khẩn, nơi nhận, người ký, tóm tắt, nội dung chính, nhiệm vụ/thời hạn, hạn xử lý, mức ưu tiên,
  hướng xử lý, **ý kiến xử lý**, lưu ý, link file trên Drive, link VPĐT.
- Trang **Rà soát danh sách**: kết quả rà soát ưu tiên của cả danh sách.
- Trang **Báo cáo tổng hợp**: mỗi lần kiểm tra tự động một dòng (tổng quan, cần xử lý ngay, khuyến nghị, mốc thời hạn).
- Google Drive: thư mục **VPĐT - Văn bản** → theo sổ văn bản → theo số ký hiệu.

## Sử dụng

### Kiểm tra tự động các văn bản chưa đọc

1. Mở trang VPĐT (đã đăng nhập), bấm biểu tượng tiện ích để mở side panel → tab **Tự động**.
2. Tick các mục cần kiểm tra (mặc định cả 3), phạm vi **Chỉ văn bản chưa đọc**.
3. Bấm **▶ Bắt đầu kiểm tra tự động** và **không thao tác trên tab VPĐT** cho đến khi xong
   (mỗi văn bản khoảng 10–30 giây tuỳ độ dài).
4. Xem kết quả ngay trong side panel: **Báo cáo tổng hợp & khuyến nghị** ở trên, bên dưới là thẻ từng văn bản
   (tóm tắt, ý kiến xử lý đề xuất, mức ưu tiên). Bấm **Xem chi tiết →** để xem đầy đủ / điền ý kiến xử lý.
5. Nếu đã cấu hình Google Sheet: mỗi văn bản được ghi vào trang tính tương ứng, báo cáo ghi vào trang
   **Báo cáo tổng hợp**, file lưu trên Google Drive.

> - Mở văn bản bằng tiện ích cũng đánh dấu **"Đã đọc"** trên VPĐT như khi bạn tự mở.
> - Tiện ích nhận biết văn bản chưa đọc qua chấm xanh / chữ in đậm ở đầu dòng. Nếu báo "không nhận ra văn bản chưa đọc"
>   trong khi thực tế vẫn còn, chọn phạm vi **Tất cả văn bản trên trang**.
> - Chỉ xét các văn bản đang hiển thị ở trang 1 của danh sách – tăng **Bản ghi** trên VPĐT nếu cần nhiều hơn.
> - Chế độ **Lặp lại** chỉ chạy khi side panel và tab VPĐT còn mở; khi xong có thông báo trên màn hình.

### Phân tích từng văn bản (thủ công)

1. Bấm biểu tượng tiện ích để mở **side panel** bên phải.
2. Trên VPĐT vào một trong các mục: **Văn bản đến → VB đã nhận**, **Văn bản đi → VB phát hành**
   hoặc **Văn bản nội bộ → VB nội bộ đã nhận**, bấm vào một văn bản.
   Kiểm tra dòng **Sổ văn bản** trong side panel đã nhận diện đúng (chọn tay nếu sai).
3. Bấm vào **từng file đi kèm** trong trình xem (biểu tượng nhiều lớp) để tiện ích thu thập
   – các file hiện trong mục **File đã thu thập**, tick chọn file muốn đọc.
4. Bấm **🤖 Đọc & phân tích bằng AI**.
5. Sửa lại **Ý kiến xử lý đề xuất** nếu cần → bấm **Ý kiến xử lý** trên VPĐT, nhấp vào ô nhập
   → bấm **✍ Điền vào ô "Ý kiến xử lý"** trong side panel → kiểm tra và gửi.
6. Bấm **📤 Xuất ra Google Sheet / Drive** (hoặc bật *Tự động xuất* trong Cài đặt).

Tab **Rà soát danh sách**: khi đang ở trang danh sách văn bản (đến / đi / nội bộ), bấm **Rà soát** để AI sắp xếp
ưu tiên toàn bộ danh sách, rồi **Xuất danh sách ra Google Sheet** nếu cần.

## Lưu ý

- AI có thể sai. Ý kiến xử lý chỉ là **đề xuất**, người dùng phải đọc lại trước khi gửi.
- PDF dạng **ảnh scan** không có lớp chữ nên không đọc được nội dung (DeepSeek API hiện chỉ nhận văn bản);
  khi đó AI chỉ dựa vào trích yếu/thông tin trên màn hình và tiện ích sẽ cảnh báo.
- File `.doc` (Word 97-2003) chưa được hỗ trợ – dùng bản PDF/DOCX.
- Nội dung văn bản được gửi tới DeepSeek để xử lý. Không dùng cho văn bản **Mật/Tối mật** hoặc
  văn bản mà quy định của đơn vị không cho phép gửi ra dịch vụ bên ngoài.
- Văn bản và file được gửi tới Google Drive/Sheet của tài khoản triển khai Apps Script. Giữ bí mật URL `/exec`
  và mã bảo mật (TOKEN); nếu lộ, đổi TOKEN trong `Code.gs` và triển khai lại.
- API key và TOKEN chỉ lưu trong `chrome.storage.local` trên máy, không đồng bộ.

## Cấu trúc mã nguồn

```
apps-script/
└── Code.gs                # Google Apps Script: ghi Google Sheet + lưu file Google Drive
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
│   ├── sheets.js          # Gửi kết quả sang Google Apps Script (Sheet/Drive)
│   ├── prompts.js         # Câu lệnh cho AI theo từng sổ văn bản (đến / đi / nội bộ)
│   ├── extract.js         # Trích chữ từ PDF (pdf.js), DOCX, XLSX
│   ├── settings.js        # Cấu hình
│   ├── sites.js           # Cấp quyền & đăng ký script cho trang VPĐT
│   └── pdfjs/             # Mozilla pdf.js 4.10.38 (Apache-2.0)
└── icons/
```

Tiện ích không cần build – chỉnh sửa file rồi bấm **Reload** trong `chrome://extensions`.
