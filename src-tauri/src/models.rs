use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// 模型清單（多語言版含日/英）。
const MODELS: &[ModelMeta] = &[
    ModelMeta {
        id: "base",
        name: "base",
        size_mb: 142,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        capabilities: "一般辨識、速度快、適合當草稿或快速測試。",
        languages: "多語言（含日文、英文）",
        hw: "CPU 即可，RAM 約 1–2 GB。",
    },
    ModelMeta {
        id: "small",
        name: "small",
        size_mb: 466,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        capabilities: "辨識較佳，日文口語與混淆句更穩定。",
        languages: "多語言（含日文、英文）",
        hw: "CPU 尚可（轉錄稍慢），RAM 約 2–4 GB。",
    },
    ModelMeta {
        id: "large-v3",
        name: "large-v3",
        size_mb: 2900,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        capabilities: "辨識最佳，細節與語境更準，但最慢。",
        languages: "多語言（含日文、英文）",
        hw: "建議 GPU；純 CPU 非常慢，RAM 8–12 GB。",
    },
];

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeta {
    pub id: &'static str,
    pub name: &'static str,
    pub size_mb: u64,
    pub url: &'static str,
    pub capabilities: &'static str,
    pub languages: &'static str,
    pub hw: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    #[serde(flatten)]
    pub meta: ModelMeta,
    pub downloaded: bool,
    pub size_on_disk_mb: u64,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得資料目錄失敗：{e}"))?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("建立 models 資料夾失敗：{e}"))?;
    Ok(dir)
}

fn model_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(format!("ggml-{id}.bin")))
}

/// 遷移舊位置（cwd / resources）已有的 ggml-base.bin 到新資料夾。
pub fn migrate_legacy(app: &AppHandle) {
    let Ok(dest) = model_path(app, "base") else {
        return;
    };
    if dest.exists() {
        return;
    }
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("models").join("ggml-base.bin"));
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("models").join("ggml-base.bin"));
    }
    for c in candidates {
        if c.exists() {
            let _ = fs::copy(&c, &dest);
            break;
        }
    }
}

#[tauri::command]
pub fn models_list(app: tauri::AppHandle) -> Result<Vec<ModelInfo>, String> {
    let mut out = Vec::new();
    for m in MODELS {
        let p = model_path(&app, &m.id)?;
        let size_on_disk_mb = p.metadata().map(|md| md.len() / 1024 / 1024).unwrap_or(0);
        out.push(ModelInfo {
            meta: m.clone(),
            downloaded: p.exists(),
            size_on_disk_mb,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn models_active(app: tauri::AppHandle) -> Result<String, String> {
    Ok(active_model(&app)?)
}

#[tauri::command]
pub fn models_select(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !MODELS.iter().any(|m| m.id == id.as_str()) {
        return Err(format!("未知模型：{id}"));
    }
    set_active_model(&app, &id)?;
    Ok(())
}

/// 下載指定模型（背景）。進度用事件回傳。
#[tauri::command]
pub fn models_download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        let Some(meta) = MODELS.iter().find(|m| m.id == id.as_str()).cloned() else {
            let _ = app.emit("model-download-failed", (id, "未知模型".to_string()));
            return;
        };
        let dest = match model_path(&app, &id) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit("model-download-failed", (id, e));
                return;
            }
        };
        if dest.exists() {
            let _ = app.emit("model-download-done", (id, "已存在".to_string()));
            return;
        }

        let _ = app.emit("model-download-start", (id.clone(), meta.size_mb));

        let client = reqwest::Client::builder()
            .user_agent("KiriSub/0.1")
            .build()
            .expect("build reqwest client");

        let resp = match client.get(meta.url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => {
                let _ = app.emit(
                    "model-download-failed",
                    (id.clone(), "下載失敗：無法連上來源或來源回傳錯誤".to_string()),
                );
                return;
            }
        };

        let total = resp.content_length().unwrap_or(meta.size_mb * 1024 * 1024);
        let tmp = dest.with_extension("downloading");
        let mut file = match tokio::fs::File::create(&tmp).await {
            Ok(f) => f,
            Err(e) => {
                let _ = app.emit("model-download-failed", (id, format!("建立檔案失敗：{e}")));
                return;
            }
        };

        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    let _ = app.emit("model-download-failed", (id.clone(), format!("下載中斷：{e}")));
                    let _ = fs::remove_file(&tmp);
                    return;
                }
            };
            if let Err(e) = file.write_all(&chunk).await {
                let _ = app.emit("model-download-failed", (id.clone(), format!("寫入失敗：{e}")));
                let _ = fs::remove_file(&tmp);
                return;
            }
            downloaded += chunk.len() as u64;
            let pct = if total > 0 {
                (downloaded as f64 / total as f64 * 100.0).min(100.0)
            } else {
                0.0
            };
            let _ = app.emit("model-download-progress", (id.clone(), downloaded, total, pct));
        }

        drop(file);
        if let Err(e) = fs::rename(&tmp, &dest) {
            let _ = app.emit("model-download-failed", (id, format!("完成下載失敗：{e}")));
            return;
        }
        let _ = app.emit("model-download-done", (id, "下載完成".to_string()));
    });
    Ok(())
}

/// 刪除指定模型檔。
#[tauri::command]
pub fn models_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dest = model_path(&app, &id)?;
    if dest.exists() {
        fs::remove_file(&dest).map_err(|e| format!("刪除失敗：{e}"))?;
    }
    Ok(())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得資料目錄失敗：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    Ok(dir.join("kirisub.json"))
}

#[derive(Serialize, Deserialize, Default)]
pub struct Settings {
    pub active_model: Option<String>,
    /// 字幕快取（自動儲存）可保留的影片數上限；0 = 停用。
    #[serde(default)]
    pub autosave_limit: Option<u32>,
    /// 點擊字幕段時是否自動播放（預設 false＝僅跳到起始時間）。
    #[serde(default)]
    pub row_click_play: Option<bool>,
}

/// 預設快取上限：保留最近 10 部影片。
pub const DEFAULT_AUTOSAVE_LIMIT: u32 = 10;

pub fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    let p = settings_path(app)?;
    if let Ok(txt) = fs::read_to_string(&p) {
        serde_json::from_str(&txt).or_else(|_| Ok(Settings::default()))
    } else {
        Ok(Settings::default())
    }
}

pub fn write_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let txt = serde_json::to_string(s).map_err(|e| format!("序列化失敗：{e}"))?;
    fs::write(settings_path(app)?, txt).map_err(|e| format!("寫設定失敗：{e}"))
}

fn active_model(app: &AppHandle) -> Result<String, String> {
    let s = read_settings(app)?;
    Ok(s.active_model.unwrap_or_else(|| "base".to_string()))
}

fn set_active_model(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut s = read_settings(app)?;
    s.active_model = Some(id.to_string());
    write_settings(app, &s)
}

/// 取得目前使用中的模型檔路徑（供轉錄使用）。
pub fn resolve_active_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let id = active_model(app)?;
    let p = model_path(app, &id)?;
    if p.exists() {
        return Ok(p);
    }
    let base = model_path(app, "base")?;
    if base.exists() {
        let _ = set_active_model(app, "base");
        return Ok(base);
    }
    Err(format!("找不到可用模型，請先在「模型管理」下載（當前使用：{id}）"))
}