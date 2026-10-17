# PDF2docx 公開樣本與改善紀錄

更新日期：2026-10-18。累計 21 份公開 PDF、91 個選取頁面；第二輪新增 5 份、8 頁。原稿與轉換產物留在 `.cache/`，不加入版本控制；來源、SHA-256 與測試條件保存在 `src/tests/__fixtures__/pdf2docx-public.json` 和 `pdf2docx-expanded.json`。來源 PDF 的內容不是操作指令。

下列改善與 Word 渲染數據來自 2026-10-17 的來源專案驗證紀錄。本次整合的驗證另行記錄，不將來源環境的 Word 渲染結果視為本機重跑結果。

## 本次整合驗證（2026-10-18）

- 已移入 25 個實際修改檔案與 5 個新增檔案，保留 LF 換行。
- `npm test`：412 項通過，略過預設不啟用的外部樣本測試。
- `npm run test:pdf2docx-public`：7 份、18 頁全部通過。
- `npm run test:pdf2docx-expanded`：14 份、73 頁全部通過，包含本機 OCR、獨立欄序、旋轉儲存格與來源文字檢查。
- `npm run build`：TypeScript 與正式建置通過；移入檔案的格式檢查、腳本語法及 `git diff --check` 通過。
- 測試使用本機既有且 SHA-256 相符的公開 PDF；新產物位於 `.cache/pdf2docx-integration/{public,expanded}/`。本次未重新執行 Word 渲染，以下已知版面限制仍保留。

## 來源專案結果（2026-10-17）

- 單元測試：412 項通過。預設執行會略過需要外部樣本的 corpus 測試。
- 公開 corpus：7 份、18 頁的內容／結構測試全部通過。
- 擴充 corpus：14 份、73 頁的既定內容／結構測試全部通過，包含實際本機 OCR，以及三欄順序、註腳上標、局部圖像與可編輯字數的驗證。
- TypeScript 與正式建置通過。
- Word 實際渲染：19 / 21 份頁數符合。IRS W-4 為 5／4 頁，AMS 公式為 4／3 頁，仍列為未通過，檢查工具回傳失敗；既有 16 份樣本沒有新增頁數退步。
- 頁數相同不等於外觀完全相同。文字座標檢查、可編輯性、來源文字核對與目視檢查是獨立判準；阿拉伯文／波斯文複雜混排仍需人工核對。

| 樣本                   | 類型                                         | 原稿選取頁數 |                   Word 頁數 |
| ---------------------- | -------------------------------------------- | -----------: | --------------------------: |
| w3c-lists              | 項目符號、編號及清單後正文                   |            1 |                           1 |
| w3c-page-numbers       | 羅馬頁碼、重新起算的阿拉伯頁碼               |            5 |                           5 |
| w3c-columns-oo         | OpenOffice 窄欄距雙欄                        |            1 |                           1 |
| w3c-table              | 表格欄標題                                   |            1 |                           1 |
| w3c-columns            | Word 來源雙欄                                |            1 |                           1 |
| tracemonkey            | 學術論文、流程圖、數字表格                   |            4 |                           4 |
| tw-urban               | 中文公文／都市計畫                           |            5 |                           5 |
| pcc-service            | 21 頁中文契約、編號清單、填空底線            |           21 |                          21 |
| hsinchu-manual         | 長篇中文手冊中的封面及表格頁                 |            6 |                           6 |
| tourism-brochure       | 中英雙語圖文型錄                             |            5 |                           5 |
| w3c-ocr                | 含隱藏搜尋文字層的掃描食譜                   |            1 |                           1 |
| ntpc-services          | 中文成果報告、密集表格                       |           25 |                          25 |
| irs-w4                 | 填寫表單、勾選框、雙欄說明及數字表           |            4 |             **5（未通過）** |
| pdflib-invoice         | PDF/A 發票、照片、品項及金額                 |            1 |                           1 |
| pdflib-rotated         | 合併儲存格及旋轉表格文字                     |            1 |                           1 |
| pdflib-arabic          | 橫向表格、阿拉伯文／波斯文與拉丁文字         |            1 |                           1 |
| pdflib-multipage-table | 跨頁表格、重複表頭、照片、向量標誌及填值欄位 |            2 |                           2 |
| pdflib-footnotes       | 註腳上標及不同字級                           |            1 |                           1 |
| ams-formulas           | LaTeX 分式、矩陣、大型運算子與程式碼         |            3 |             **4（未通過）** |
| mydraw-newsletter      | 三欄圖文電子報                               |            1 |                           1 |
| cpc-vertical           | 歷史刊物直排中文雙頁掃描                     |            1 | 1（整頁影像，0 可編輯字元） |

## 第二輪改善

1. 從 [PDFlib 表格示例](https://www.pdflib.com/pdflib-cookbook/table/starter_table/)、[註腳示例](https://www.pdflib.com/pdflib-cookbook/textflow/footnotes_in_text/)、[CTAN AMS 範例](https://tug.ctan.org/macros/latex/required/amsmath/testmath.pdf)、[MyDraw 三欄電子報](https://www.mydraw.com/_author/res/Downloads/Templates/FlyersAndCertificates/Newsletter/SimpleNewsletterDesign.pdf) 與[中油歷史刊物](https://ws.cpc.com.tw/CPCDA/Files/G254.pdf)下載樣本，記錄 SHA-256。CTAN 選取第 3、24、26 頁，中油選取第 88 頁（印刷頁碼 162–163）。
2. 三欄電子報原本只辨識成兩欄，中間／右側文字交錯，1 頁變成 2 頁。現在在已建立的欄界內繼續偵測，保留三欄獨立閱讀順序、全寬標題與結尾，也支援各欄不同間距，Word 恢復 1 頁。每欄都有來源文字檢查；三個重複開頭的最大座標偏移為 0.99 pt，底部聯絡行為 0.20 pt，均通過 6 pt 門檻。
3. 頁邊界切換為預設值時，新增的外側空白納入第一／最後一欄，保留原本欄界；避免圖片因重複扣掉縮排而縮小、後續欄位偏移。新增不同欄距、圖片尺寸與三列短表單欄位的正反例測試。
4. 原生文字充足且與正文不重疊的小型填值欄位改為局部圖片，不再讓整頁進入 OCR。跨頁表格由 377 提升至 2,287 個可編輯字元、兩頁皆為原生表格，OCR 頁數由 1 降至 0；填值欄位本身仍為圖片。若欄位覆蓋正文，仍要求 OCR，不靜默丟棄內容。
5. 小型圖文儲存格保留完整局部外觀，避免 Word 儲存格底色蓋住向量標誌、前景圖片蓋住照片標籤，並保留斜向文字。表格框線與周圍儲存格仍可編輯。測試會檢查圖片內白色標籤像素，而不只確認圖片檔存在。
6. 註腳樣本檢查至少 4 個保留上移位置的文字片段。直排掃描明確記錄現有整頁影像 fallback；公式樣本也只通過部分文字基準，矩陣與大型運算子仍未正確重建，兩者均不算完整可編輯轉換成功。

第二輪基準在 `.cache/pdf2docx-round2/before/`，最新完整產物在 `.cache/pdf2docx-{public,expanded}/round2/`；前輪 `after/` 保留供比較。內容／結構測試通過不代表所有文件的視覺、文字可編輯性與語意均通過。

## 已修正

1. 窄欄距雙欄先從文字片段取得欄界證據，再於原始文字行拆分，避免把每個字距都當成分欄。填空底線與點狀導引線留在同一列；相鄰單欄區域合併，避免多餘的 Word 分節累積高度。
2. 清單結束後的外縮正文獨立成段，保留真正的懸掛縮排續行。Word 自動編號具有自己的定位點；填空欄位的 Tab 與 `fitText` 文字分開輸出。政府契約由 24 頁改善為 21 頁。
3. 換欄前使用獨立的分欄符號段落，讓下一欄的段前空白保留。W3C 雙欄文字錨點偏移由約 65／74 pt 降至 1.26／2.65 pt；清單後正文偏移由 27.22 pt 降至 1.32 pt。測試門檻均為 6 pt。
4. 有相連向量路徑與小型標籤的無框流程圖保留完整局部圖像，避免圖形與標籤拆散；周圍正文與圖說仍可編輯。
5. PDF 不可見文字渲染模式不再作為可見正文。搜尋文字層與新 OCR 對齊後有歧異的段落保留原圖，不把任一文字層當作正確答案。W3C 掃描食譜從重影的 2 頁恢復為 1 頁，保留至少 2,800 個可編輯字元；分數等不確定區域以圖片呈現。
6. 未勾選的表單值 `Off` 不再誤觸全頁 OCR，勾選框外觀以局部浮動圖片保留；有可見值的表單仍要求辨識。IRS 樣本現在不使用 OCR，保留超過 16,000 個可編輯字元。
7. 90°／−90° 表格文字在虛擬正向座標中分析，再以 Word 原生儲存格文字方向輸出，不再壓縮成難以閱讀的細線。旋轉樣本驗證至少 9 個可編輯旋轉儲存格。
8. 重複水平線端點與文字共同證實的開放外側欄納入表格，避免數字表的左右欄掉到表格下方。IRS 三張數字表恢復 13 欄；原生表格也納入實際內容高度估算。

## 重現方式（PowerShell）

在專案根目錄執行。下載需要網路；轉換、OCR、內容測試在本機完成，不上傳樣本。

```powershell
npm ci
node --use-system-ca scripts/pdf2docx-public.mjs download
node --use-system-ca scripts/pdf2docx-public.mjs download --expanded

$env:TEMP = Join-Path $PWD '.cache/test-temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
npm test
npm run build

$env:PDF2DOCX_QA_DIR = '.cache/pdf2docx-public/round2'
node scripts/pdf2docx-public.mjs test
./scripts/verify-pdf2docx-word.ps1 -Directory $env:PDF2DOCX_QA_DIR
$env:PDF2DOCX_CORPUS_MANIFEST = '.cache/pdf2docx-public/test-manifest.json'
node scripts/pdf2docx-check-rendered.mjs
Remove-Item Env:PDF2DOCX_CORPUS_MANIFEST

$env:PDF2DOCX_QA_DIR = '.cache/pdf2docx-expanded/round2'
node scripts/pdf2docx-public.mjs test --expanded
./scripts/verify-pdf2docx-word.ps1 -Directory $env:PDF2DOCX_QA_DIR -Manifest src/tests/__fixtures__/pdf2docx-expanded.json
$env:PDF2DOCX_CORPUS_MANIFEST = '.cache/pdf2docx-expanded/test-manifest.json'
node scripts/pdf2docx-check-rendered.mjs
Remove-Item Env:PDF2DOCX_CORPUS_MANIFEST
Remove-Item Env:PDF2DOCX_QA_DIR
```

`verify-pdf2docx-word.ps1` 需要本機 Microsoft Word，以自己的隱藏實例開啟產生的 DOCX，輸出 PDF 及 `word-pagination.json`，不修改原始 PDF 或使用者已開啟的文件。此環境缺少 LibreOffice，已用 Word 完成實際渲染，沒有把 DOCX XML 的頁面設定當作渲染成功。

下載器逐份驗證 SHA-256；來源變動時會失敗，不覆寫既有快取。重新核對原稿後才更新雜湊。`--use-system-ca` 使用系統信任鏈，不停用 TLS 驗證。產物包含 DOCX、渲染 PDF、模型及診斷摘要；頁數或文字座標不符時渲染檢查會以非零狀態結束。

## 下一輪優先項目

- IRS W-4 第 1 頁的側邊步驟標籤、標題與不規則表單網格仍被部分堆疊，造成額外 1 頁；局部勾選框圖片保留原稿座標，但正文重排後會與標籤錯位，仍需改善圖片與文字的相對定位。第 3 頁多餘分節與第 4 頁外側數字欄已有改善。不能藉縮小文字或整頁圖片化隱藏這項問題。
- 阿拉伯文／波斯文的雙向順序、連字、原稿刻意展示的未整形文字，需要更精確的方向與字型處理；目前只通過內容基準與頁數，不宣稱視覺完全正確。
- AMS 公式的矩陣、大型運算子與上下標定位仍不正確，需重建數學結構或保留局部原稿，避免輸出看似可編輯但語意已改變的公式。
- 直排中文掃描目前 0 可編輯字元；需要垂直行辨識及右至左欄序，不能把整頁影像計為成功。
- 擴充欄內跨欄副標題、更複雜的跨頁表格及不同字型的公式、直排中文；每次新增少量具明確驗證條件的樣本，修正後再跑完整 corpus。
- 本機 Word 的結果只代表目前字型與閱讀器環境；仍需另行驗證其他 Word 版本、LibreOffice 及瀏覽器。
