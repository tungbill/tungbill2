# kvr-termin-watcher

Công cụ nhỏ chạy trên Windows để **tự động tải lại trang đặt lịch hẹn của KVR München và báo cho bạn** khi có ngày trống. Nó làm đúng việc bạn có thể tự làm bằng cách bấm F5 mỗi 30 giây, chỉ thêm phần kêu chuông, hiện thông báo Windows và nhắn Telegram.

**Bạn tự đặt lịch.** Công cụ không điền form, không bấm nút, không gọi API của trang, không đụng vào bất kỳ widget kiểm tra (captcha) nào. Nó chỉ:

1. Mở một cửa sổ Chromium bình thường (nhìn thấy được, dùng profile riêng nên cookie / đồng ý cookie được giữ lại).
2. Để trang tự tải lịch như bình thường, và **chỉ lắng nghe** phản hồi mạng có tên `available-calendar`.
3. Nếu `availableDays` rỗng và `nextBookableDate` là `null` → chờ theo lịch rồi tải lại trang.
4. Nếu có ngày trống → dừng tải lại, kêu chuông, hiện toast, nhắn Telegram kèm link, đưa cửa sổ Chromium lên trước để bạn tự bấm chọn ngày và đặt.

Nếu trang hiện kiểm tra thủ công (captcha có tương tác) hoặc không tải được lịch trong 30 giây, công cụ **tạm dừng**, chụp màn hình vào `logs/`, báo cho bạn, và chỉ chạy tiếp khi bạn bấm Enter trong cửa sổ console.

---

## 1. Cài Node.js

- Tải **Node.js 20 LTS** (hoặc mới hơn) tại <https://nodejs.org> → chọn bản *LTS* → cài với các lựa chọn mặc định.
- Mở *Command Prompt* mới, gõ `node -v`. Phải hiện `v20.x.x` trở lên.

## 2. Tải công cụ và tạo file cấu hình

1. Chép thư mục `kvr-termin-watcher` vào máy (ví dụ `C:\kvr-termin-watcher`).
2. Chạy `start.bat` lần đầu: nó sẽ tự tạo `config.json` từ `config.example.json` rồi thoát để bạn chỉnh.
3. Mở `config.json` bằng Notepad:

```json
{
  "url": "https://stadt.muenchen.de/buergerservice/terminvereinbarung.html#/services/10339028/locations/10461",
  "hotWindows": [
    { "start": "07:10", "end": "07:50", "intervalSec": 20 },
    { "start": "12:00", "end": "13:45", "intervalSec": 30 }
  ],
  "coldIntervalSec": 300,
  "activeHours": { "start": "07:00", "end": "16:00" },
  "weekdaysOnly": true,
  "telegram": { "botToken": "", "chatId": "" },
  "sound": true,
  "toast": true
}
```

| Khoá | Ý nghĩa |
|---|---|
| `url` | Trang đặt lịch (dịch vụ + địa điểm). Đổi nếu bạn cần dịch vụ khác. |
| `hotWindows` | Các khung giờ "nóng" (giờ máy tính) và khoảng cách tải lại tính bằng giây. Tối thiểu 15 s, nhanh hơn sẽ bị nâng lên 15 s. |
| `coldIntervalSec` | Khoảng cách tải lại ngoài khung giờ nóng (mặc định 5 phút). |
| `activeHours` | Ngoài khung này công cụ chỉ ngủ và in ra giờ sẽ chạy lại. |
| `weekdaysOnly` | `true` = không chạy Thứ 7 / Chủ nhật. |
| `telegram` | Token bot + chat id (xem mục 3). Để trống cả hai nếu không dùng. |
| `sound` / `toast` | Bật / tắt chuông và thông báo Windows. |

Tuỳ chọn nâng cao (không bắt buộc): `responseTimeoutSec` (mặc định 30), `profileDir` (mặc định `browser-profile`), `logDir` (mặc định `logs`).

## 3. Lấy Telegram bot token và chat id

1. Trong Telegram, tìm **@BotFather** → gửi `/newbot` → đặt tên → BotFather trả về token dạng `123456789:AAH...`. Đó là `botToken`.
2. Mở chat với bot vừa tạo (bấm link `t.me/<tên_bot>`) và bấm **Start**, gửi một tin bất kỳ.
3. Mở trình duyệt, vào `https://api.telegram.org/bot<TOKEN>/getUpdates` (thay `<TOKEN>` bằng token của bạn). Tìm `"chat":{"id":123456789,...}` → số đó là `chatId`.
4. Điền vào `config.json`. Khi khởi động, công cụ gửi một tin "started" để bạn biết Telegram hoạt động.

Có thể đặt biến môi trường `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` thay vì ghi vào file.

## 4. Chạy

Bấm đúp `start.bat`. Lần đầu nó sẽ:

- cài thư viện npm (`node_modules`),
- tải Chromium cho Playwright (~150 MB, một lần),
- tạo `alert.wav` nếu chưa có,
- build TypeScript rồi khởi động.

Sau đó bạn sẽ thấy hai cửa sổ: **console** (log) và **Chromium** với trang đặt lịch. Trong vòng 30 giây console phải in dòng như:

```
07:12:03 INFO  availableDays=0 nextBookableDate=null status=200
07:12:03 INFO  next reload in 20 s intervalSec=20 hot=07:10 multiplier=1
```

Cứ để hai cửa sổ mở. Có thể dùng máy bình thường, nhưng **đừng đóng tab Chromium** (đóng cửa sổ Chromium = dừng công cụ). Bấm `Ctrl+C` trong console để thoát.

Chạy `start.bat` lần thứ hai khi đang chạy sẽ thoát ngay với thông báo "already running (PID ...)". Nếu chắc chắn không có bản nào đang chạy mà vẫn bị báo, xoá file `watcher.lock`.

### Khi có lịch trống

- Chuông kêu 3 lần, toast Windows hiện, Telegram nhận tin kèm link.
- Cửa sổ Chromium được đưa lên trước. **Bạn tự bấm ngày, chọn giờ và điền thông tin.** Công cụ không làm gì thêm.
- Console ghi `SLOT AVAILABLE` và dừng tải lại. Nếu đặt xong (hoặc slot bị người khác lấy mất) và muốn theo dõi tiếp, bấm Enter trong console; muốn thoát thì `Ctrl+C`.

### Khi công cụ yêu cầu bạn xử lý kiểm tra thủ công

Console và Telegram báo *"Site is asking for a manual check"* (có ảnh chụp trong `logs/manual-check-*.png`). Điều này xảy ra khi:

- lịch không được tải trong 30 giây (mạng chậm, trang bảo trì, hoặc trang hiện kiểm tra), hoặc
- một widget kiểm tra (captcha) nhìn thấy được xuất hiện trên trang.

Làm gì: nhìn vào cửa sổ Chromium, tự xử lý những gì trang yêu cầu (hoặc chỉ cần chờ trang tải xong), rồi quay lại console và **bấm Enter**. Công cụ tải lại và tiếp tục. Nếu chuyện này xảy ra 3 lần trong 1 giờ, công cụ tự **nhân đôi khoảng cách tải lại** và báo cho bạn — đó là dấu hiệu nên chạy chậm hơn nữa hoặc tạm nghỉ.

## 5. Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `Node.js khong duoc tim thay` | Cài Node.js 20 LTS, mở console mới rồi chạy lại. |
| `config.json: ...` khi khởi động | File cấu hình sai định dạng; đọc thông báo lỗi (giờ phải là `HH:MM`, `start` phải trước `end`, Telegram phải điền cả hai hoặc bỏ trống cả hai). |
| `could not launch Chromium` | Chạy `npx playwright install chromium` trong thư mục công cụ rồi thử lại. |
| Chromium mở nhưng console không in `availableDays=` | Nhìn cửa sổ Chromium: trang có hiện banner cookie hoặc kiểm tra không? Xử lý một lần bằng tay, profile sẽ nhớ. Kiểm tra ảnh trong `logs/`. |
| `HTTP 429` / `HTTP 403` | Trang đang giới hạn tần suất. Công cụ tự chờ lâu dần (backoff) và báo Telegram. Tăng `intervalSec` / `coldIntervalSec` trong `config.json`. |
| Không nhận tin Telegram | Kiểm tra token/chat id; đã bấm Start với bot chưa; xem `logs/watcher.log` dòng `telegram send failed`. |
| Không có tiếng | Kiểm tra `"sound": true`, file `alert.wav` tồn tại (chạy `npm run gen-alert`), loa không mute. |
| `already running (PID ...)` | Đang có bản khác chạy. Nếu không, xoá `watcher.lock`. |
| Muốn xem log chi tiết | `logs/watcher.log` (JSON, mỗi dòng một sự kiện). Đặt `set LOG_LEVEL=debug` trước khi chạy để thấy cả phản hồi lịch. |
| Máy ngủ (sleep) | Windows ngủ thì công cụ cũng dừng. Tắt chế độ ngủ trong giờ theo dõi. |

## 6. Dành cho người phát triển

```
npm install
npm test               # unit test (schedule, config) + integration test (Chromium headless, mạng giả lập)
npm run test:unit
npm run build && node dist/src/index.js
```

Cấu trúc:

- `src/config.ts` — đọc và kiểm tra `config.json`.
- `src/schedule.ts` — logic lịch thuần (khung giờ nóng, giờ hoạt động, cuối tuần, backoff); không I/O nên dễ test.
- `src/watcher.ts` — lắng nghe `page.on('response')`, vòng lặp tải lại, tạm dừng / tiếp tục, backoff 429/403.
- `src/notify.ts` — chuông (PowerShell SoundPlayer), toast (`node-notifier`), Telegram (`fetch`).
- `src/index.ts` — khoá một phiên, mở Chromium, xử lý console và Ctrl+C.
- `scripts/gen-alert.js` — tạo `alert.wav`.
- `test/` — unit + integration test (`node:test`).

Ranh giới cố ý: không headless, không proxy, không plugin "stealth", không gọi API trực tiếp, không đụng widget kiểm tra, không submit. Khoảng cách tải lại tối thiểu 15 giây được khoá cứng trong code.
