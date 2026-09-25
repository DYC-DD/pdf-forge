# Folio — PDF 工作台

純前端 PDF 工具，以 Vite、React、TypeScript 製作。檔案在瀏覽器中處理，不會上傳至伺服器。

## 功能

- **合併 PDF**：加入多份檔案，拖曳或使用上下按鈕調整順序，下載單一 PDF。
- **拆分 PDF**：點選縮圖或輸入頁碼範圍，建立多個頁面群組；也可每頁輸出一個檔案。多個結果打包成 ZIP。

壓縮 PDF 尚未實作。

## 開發

需要 Node.js 22.13 以上。

```bash
npm ci
npm run dev
```

```bash
npm test
npm run build
```

## GitHub Pages

`vite.config.ts` 的正式建置路徑為 `/file-converter/`。儲存庫在 GitHub Pages 設定中選擇 **GitHub Actions** 作為來源後，推送至 `main` 即會執行 `.github/workflows/pages.yml`。目前開發分支是 `develop`，不會因本地建置而部署。

## 已知限制

- 加密或需密碼的 PDF 暫不支援。
- 合併與拆分是複製頁面；原始 PDF 的書籤、內部連結、表單或簽章可能無法完整保留。
- 每頁一檔的模式會在瀏覽器記憶體中產生所有結果；大型 PDF 可能受到裝置記憶體限制。
