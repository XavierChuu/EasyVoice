# Câu hỏi còn mở

## Từ spec (mục 10)
- [ ] App miễn phí hay bán? (ảnh hưởng chọn model, xem mục 9)
- [ ] Dùng checkpoint F5-TTS tiếng Việt nào?
- [ ] Có cần hỗ trợ GPU AMD trên Windows ở v2 không?
- [ ] Tên miền và chứng chỉ ký số đứng tên cá nhân hay công ty?

## Phát sinh khi đọc spec / làm Phase 0
- [ ] **Định dạng model RVC trong profile:** mục 2 ghi `model.pth`, còn mục 3.5 chỉ chấp nhận `model.safetensors` trong `.evoice`
      và yêu cầu convert `.pth` cộng đồng sang safetensors. Đề xuất: profile lưu `model.safetensors` + metadata cấu hình
      (config, sr, f0, version) trong `profile.json`, không giữ `.pth`. Cần xác nhận.
- [ ] **Chế độ TTS "Chain"** cần "một giọng chuẩn đẹp" cho F5-TTS: giọng này lấy từ đâu (ref đi kèm app? license?).
- [ ] **Train RVC trong app (Phase 3):** vendor code train từ RVC gốc hay từ Applio? Applio không phụ thuộc fairseq,
      dễ cài hơn trên Python 3.11 / Windows. Quyết định sau khi đo ở Phase 0.
- [ ] **Encoder nội dung:** dùng ContentVec dạng `transformers` (không cần fairseq) thay cho `hubert_base.pt` của RVC gốc —
      Phase 0 cần nghe so sánh để xác nhận chất lượng tương đương.
- [ ] Spec ghi "Python 3.10 hoặc 3.11"; spike dùng **3.11** + torch 2.8. Chốt lại sau Phase 0.
- [ ] File `EasyVoice UI mẫu.html`: là thiết kế chốt cho Phase 2/5 hay chỉ tham khảo?
