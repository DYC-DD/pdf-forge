# PDF Forge — PDF 工作台

純前端 PDF 工具，以 Vite、React、TypeScript 製作。檔案在瀏覽器中處理，不會上傳至伺服器。

## 功能

- **合併 PDF**：加入多份檔案，拖曳或使用上下按鈕調整順序，下載單一 PDF。
- **拆分 PDF**：點選縮圖或輸入頁碼範圍，建立多個頁面群組；也可每頁輸出一個檔案。多個結果打包成 ZIP。

壓縮 PDF 尚未實作。

## 專案結構

```text
src/
├── main.tsx                  # React 入口
├── app/
│   ├── App.tsx               # 組合首頁、工具切換與工作區
│   ├── components/           # 獨立的頁首與頁尾元件
│   ├── styles.css            # 依序載入各層樣式
│   └── styles/              # 基礎、外殼、頁首、頁尾與工作區樣式
├── features/
│   ├── landing/             # 首頁展示、工具選擇及其視覺元件
│   ├── merge/               # 合併介面、排序元件及合併邏輯
│   └── split/               # 拆分介面、頁面縮圖及拆分邏輯
├── shared/
│   ├── files/               # 檔名、大小顯示與下載工具
│   ├── pdf/                 # PDF 載入、預覽、解鎖與錯誤訊息
│   └── ui/                  # 跨功能共用的介面元件
└── tests/                   # 跨功能 PDF 整合測試與測試資料
public/                       # 靜態資源
docs/                         # 專案文件
```

`app` 負責組合與全域樣式載入；`features` 各自擁有畫面、專用元件、處理邏輯與樣式；`shared` 只放跨功能使用的能力。依賴方向為 `app → features → shared`，`shared` 不反向引用功能。新增功能時先放入對應的 `features` 目錄，確定重複使用後再提升至 `shared`。

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

程式碼使用專案固定版本的 Prettier 排版，並由匯入排序外掛統一 `import` 順序。VS Code 會提示安裝 Prettier 擴充套件，並在儲存時依 `.prettierrc.json` 自動格式化。其他編輯器也可執行：

```bash
npm run format
npm run format:check
```

## GitHub Pages

`vite.config.ts` 的正式建置路徑為 `/file-converter/`。儲存庫在 GitHub Pages 設定中選擇 **GitHub Actions** 作為來源後，推送至 `main` 即會執行 `.github/workflows/pages.yml`。目前開發分支是 `develop`，不會因本地建置而部署。

## 已知限制

- 可直接開啟、但以擁有者密碼限制編輯的 PDF，會在瀏覽器內嘗試用空密碼解鎖後處理；輸出檔不保留原加密設定。真正需要開啟密碼的 PDF 目前仍無法處理。
- 合併與拆分是複製頁面；原始 PDF 的書籤、內部連結、表單或簽章可能無法完整保留。
- 每頁一檔的模式會在瀏覽器記憶體中產生所有結果；大型 PDF 可能受到裝置記憶體限制。
