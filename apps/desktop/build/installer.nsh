; Trình gỡ cài đặt: hỏi có xoá dữ liệu người dùng (%APPDATA%\EasyVoice: giọng, model, runtime Python, bản ghi) không.
; Mặc định GIỮ LẠI để cài lại / cập nhật không phải tải lại hàng GB model. Khi cập nhật (gỡ im lặng) không hỏi.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent evKeepData 0
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Xoá luôn dữ liệu EasyVoice (giọng đã tạo, model đã tải, runtime)?$\r$\nDelete all EasyVoice data too (voices, downloaded models, runtime)?$\r$\n$\r$\n$APPDATA\EasyVoice" \
      IDNO evKeepData
    RMDir /r "$APPDATA\EasyVoice"
    evKeepData:
  ${endIf}
!macroend
