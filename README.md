# 血液透析室｜醫療處方與每月生化決策引導系統 (`hd-clinical-decision-support`)

專為血液透析室（Hemodialysis Unit）設計的輕量化、純前端單頁互動網頁（Single-Page Application），協助醫師與臨床團隊在查房與每月檢驗判讀時快速模擬透析處方並生成結構化病程紀錄。

## 線上預覽（GitHub Pages）
- 網址：`https://yht5582-source.github.io/hd-clinical-decision-support/`

## 核心臨床模組
1. **透析處方與廓清率模擬（spKt/V、eKt/V、stdKt/V & UFR）**：依性別、年齡、身高、乾體重、血管通路、$Q_b$、$Q_d$、時間、每週次數與人工腎臟 $K_oA$ 即時推算尿素廓清率 $K$（Michaels）、分布容積 $V$（Watson）、spKt/V（單池變動容積模型 + Daugirdas II）、eKt/V、stdKt/V（Leypoldt／FHN）、URR 與 UFR；劑量未達 KDOQI 2015 目標時，反推達標所需之 Qb、KoA 與透析時間。
2. **每月生化與用藥決策樹**：整合白蛋白矯正血鈣、鈣磷乘積（Ca × P）、CKD-MBD 磷結合劑與 iPTH 處方決策、腎性貧血鐵劑／ESA 調整指引，以及高血鉀處置提示。
3. **透析營養與水分處方精算**：自動計算維持性血液透析熱量（30–35 kcal/kg）、蛋白質（1.0–1.2 g/kg）、每日限水上限與低白蛋白 PEW 風險警示。
4. **一鍵生成結構化 SOAP 病程紀錄**：即時同步彙整主客觀數據與處置計畫，點擊即可複製貼入醫院 HIS 系統。

## 檔案結構
- `index.html`：介面與互動
- `engine.js`：純函式計算引擎（無 DOM 依賴，可於 Node 測試）
- `tests/engine.test.cjs`：`node --test tests/`

## 版本
- **v1.1.0**：修正頁面腳本語法錯誤（字串內換行導致整頁無法計算）；重寫動力學模型；空白欄位不再視為 0；新增年齡、通路、每週次數、iPTH 檢驗上限欄位；鐵質分類細分；手機版版面與複製功能相容性修正；新增單元測試。

## 資安設計
- 100% 純前端本機瀏覽器運算（Zero-Backend / Zero-CDN Dependency），不傳輸、不儲存任何病患個資。
