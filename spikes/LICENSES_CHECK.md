# Kiểm tra license (Phase 0)

Xác minh tại **trang gốc** của từng model (model card + file LICENSE), ghi ngày kiểm tra và link.
Rủi ro lớn nhất của dự án nằm ở license weights (spec mục 9).

| Thành phần | Nguồn | License code | License weights | Thương mại được? | Ngày kiểm tra / link |
|---|---|---|---|---|---|
| F5-TTS (gốc, SWivid) | huggingface.co/SWivid/F5-TTS | MIT | CC-BY-NC-4.0 (dataset Emilia) | Không | |
| F5-TTS tiếng Việt (ứng viên 1) | | | | | |
| F5-TTS tiếng Việt (ứng viên 2) | | | | | |
| Vocos mel 24 kHz | huggingface.co/charactr/vocos-mel-24khz | | | | |
| RVC v2 (code) | github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI | MIT | — | | |
| RVC pretrained (f0G/f0D 40k/48k) | huggingface.co/lj1995/VoiceConversionWebUI | | | | |
| RMVPE | huggingface.co/lj1995/VoiceConversionWebUI | | | | |
| ContentVec / HuBERT base | huggingface.co/lengyue233/content-vec-best (gốc: github.com/auspicious3000/contentvec) | | | | |
| Tách vocal (UVR-MDX / Demucs) | | | | | |
| faster-whisper + Whisper weights | | | | | |
| Applio (chỉ dùng để đo train) | github.com/IAHispano/Applio | | — | | |
| rvc-python (nguồn code vendored) | pypi.org/project/rvc-python | MIT | — | | |

Kết luận (miễn phí phi thương mại hay có thể bán?): …
