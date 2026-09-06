<div align="center">

<img src="src/assets/KiriSub_icon_transparent.png" alt="KiriSub logo" width="120" />

# KiriSub

</div>

**影片剪輯字幕 AI 助手** —— 幫剪輯師快速產生字幕的本機桌面工具。

把剪好的影片（或音檔）丟進來，KiriSub 會用 **Whisper AI 在你的電腦上本機轉錄**，產生帶時間戳的字幕段落。之後便可匯出標準 **SRT**，直接匯入 **剪輯軟體** 完成初步的字幕。

## ✨ 特色

- 🔒 **完全本機運行**：影片與音訊不上傳任何伺服器，快速且隱私安全
- 🌏 **多語言字幕**：支援多語言自動偵測，亦可指定語系
- 🧠 **三種 AI 模型可選**：Base（快）、Small（推薦）、Large-v3（最準），在 App 內直接下載／刪除／切換
- ✏️ **內建字幕編輯器**：直接改文字、點時間微調（入點／出點、±0.1s／±0.5s）、全段批量偏移
- 📼 **支援影片與純音檔**：mp4 / mov / mkv / mp3 / wav / flac / m4a 等常見格式（HEVC 影片轉錄也支援）
- ⬇️ **一鍵匯出 SRT**：UTF-8 標準格式，剪輯軟體可直接匯入
- 🔄 **自動更新**：啟動時自動檢查新版本，詢問後背景下載安裝

## 📥 下載安裝

到 [**Releases 頁面**](https://github.com/KokoroHoshi/KiriSub/releases/latest) 下載最新的
`KiriSub_*_x64-setup.exe`，雙擊安裝即可。

> 安裝後開啟軟體，它會自動偵測新版本並詢問是否更新——不用再手動回來抓新版。

## 🚀 快速上手

1. **選擇影片／音訊**（📁 按鈕）
2. 選**轉錄語系**與**模型**（第一次使用請到「設定」下載模型）
3. 點 **✨ 生成字幕**，等進度條跑完
4. 在右側細修：改文字、點時間展開微調、用「全段偏移」一次校正整體延遲
5. 點 **⬇ 匯出 SRT**，把產生的 .srt 匯入剪輯軟體即完成

## 💻 系統需求

- Windows 10 / 11（64 位元）
- RAM：Base 模型約 2 GB；Small 約 4 GB；Large-v3 建議 12 GB 以上（或搭配 GPU）
- 模型檔首次使用需下載（142 MB / 466 MB / 2.9 GB）

## 🛠 開發者建置

```bash
npm install
npm run tauri dev    # 開發模式
npm run tauri build  # 打包安裝檔
```

需求：Node.js 18+、Rust、CMake、Windows 上的 WebView2（Win11 內建）。

### Windows 本機建置注意事項

**GPU（Vulkan）轉錄**需要安裝 [Vulkan SDK](https://vulkan.lunarg.com/)，並確保 `VULKAN_SDK` 環境變數已設定。

此外，whisper.cpp 的 Vulkan shader 產生器建置路徑極深，**MSBuild 的 FileTracker 不支援 Windows 長路徑**（即使系統已啟用 `LongPathsEnabled`），若專案放在較長的路徑（如 `C:\Users\...\Documents\Project\...\KiriSub`），會出現 `FTK1011` 或 `No CMAKE_C_COMPILER could be found` 錯誤。解法：把 Cargo 的 target 目錄指到**短路徑**。

請複製設定範本並依你的環境修改：

```bash
cp src-tauri/.cargo/config.toml.example src-tauri/.cargo/config.toml
```

此檔已列入 `.gitignore`（內含機器專屬路徑），主要內容：

```toml
[env]
CFLAGS = "/FS"        # 避免平行編譯的 C1041（PDB 衝突）
CXXFLAGS = "/FS"
VULKAN_SDK = "C:/VulkanSDK/<你的SDK版本>"

[build]
target-dir = "C:/ct"  # 任一夠短的本機路徑，避開 260 字元限制
```

> GitHub Actions 等 CI 環境不需此檔（checkout 路徑夠短、SDK 由 runner 提供）。

### 發佈新版

1. 更新 `src-tauri/tauri.conf.json` 與 `src-tauri/Cargo.toml` 的版本號
2. commit 後打 tag：`git tag v0.x.0 && git push origin main --tags`
3. GitHub Actions 會自動 build、簽署並發佈 Release（含 `latest.json`，供自動更新使用）

## 📄 授權

MIT
