# CHANGELOG

This changelog follows the [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/) format to track version updates.

## [Unreleased]

### Added

- 建立 Vite、React 與 TypeScript 的純前端 PDF 工作台，檔案在瀏覽器本機處理。
- 支援匯入多份 PDF，透過拖曳或上下按鈕調整順序後合併下載；提供首頁縮圖、頁數及檔案大小資訊。
- 支援以頁面縮圖或頁碼範圍選取頁面，建立多個可命名的 PDF 輸出群組。
- 支援每頁輸出一份 PDF；多份輸出會打包為 ZIP，單份輸出則直接下載 PDF。
- 加入檔案讀取與處理進度提示，以及無效或加密 PDF 的錯誤訊息。
- 加入 GitHub Pages 的建置與部署工作流程，並設定專案子路徑。
- 加入頁碼範圍、合併頁面順序與拆分結果的自動化測試。

### Changed

- 改善手機與平板版面：調整頁首、工作區欄數、上傳區及觸控操作尺寸。
- 將應用程式依頁面外殼、合併與拆分功能、共用元件及 PDF 處理分層整理。
- 合併與拆分現在可處理能以空使用者密碼開啟、但受擁有者密碼限制的 PDF；檔案會在瀏覽器內解鎖，輸出不保留原加密設定。真正需要開啟密碼的 PDF 仍會提示無法處理。
