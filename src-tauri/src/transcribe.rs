use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;

use serde::{Deserialize, Serialize};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// 轉錄取消旗標。由 `request_cancel()` 設定、`reset_cancel()` 清除，
/// 供 whisper 的 abort callback 與轉錄完成後的檢查共用（跨執行緒）。
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

/// 開始新的轉錄前清除取消狀態。
pub fn reset_cancel() {
    CANCEL_FLAG.store(false, Ordering::SeqCst);
}
/// 請求中止目前轉錄。
pub fn request_cancel() {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
}
/// 目前是否已被請求取消。
pub fn is_cancelled() -> bool {
    CANCEL_FLAG.load(Ordering::SeqCst)
}

/// 轉錄結果錯誤型別；將「使用者取消」與「真實錯誤」區分開來。
#[derive(Debug)]
pub enum TranscribeError {
    /// 使用者在轉錄途中按下中斷。
    Cancelled,
    /// 其他真實錯誤（例如模型載入失敗、whisper 內部錯誤）。
    Other(String),
}

impl std::fmt::Display for TranscribeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscribeError::Cancelled => write!(f, "已取消轉錄"),
            TranscribeError::Other(e) => write!(f, "{e}"),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Segment {
    pub index: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// 轉錄。進度百分比透過 `progress` channel 送出（由呼叫端轉發事件），
/// 避免在 whisper.cpp 的 FFI 回呼執行緒中直接操作 Tauri emit。
pub fn transcribe(
    model_path: &Path,
    audio: &[f32],
    language: Option<&str>,
    progress: Option<Sender<i32>>,
) -> Result<Vec<Segment>, TranscribeError> {
    // 每次轉錄開始一律重設取消旗標，避免前一次取消狀態殘留污染本輪。
    reset_cancel();
    let model_str = model_path
        .to_str()
        .ok_or_else(|| TranscribeError::Other("模型路徑含無效字元".to_string()))?;
    let ctx = WhisperContext::new_with_params(model_str, WhisperContextParameters::default())
        .map_err(|e| TranscribeError::Other(format!("載入模型失敗：{e}")))?;

    let mut state = ctx
        .create_state()
        .map_err(|e| TranscribeError::Other(format!("建立狀態失敗：{e}")))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(language);
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // 取消旗標 ── 讓 whisper 在編碼/解碼內可被快速中止
    params.set_abort_callback_safe(|| is_cancelled());

    if let Some(tx) = progress {
        params.set_progress_callback_safe(move |percent: i32| {
            // 只做 channel send；任何錯誤都吞掉，不讓回呼 panic
            let _ = tx.send(percent);
        });
    }

    let err = state.full(params, audio).err();
    // 優先檢查取消：即便 full 回傳具體錯誤碼，只要是取消就當成 Cancelled
    if is_cancelled() {
        return Err(TranscribeError::Cancelled);
    }
    if let Some(e) = err {
        return Err(TranscribeError::Other(format!("轉錄失敗：{e}")));
    }

    let n = state.full_n_segments();
    let mut segments: Vec<Segment> = Vec::with_capacity(n as usize);
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            let raw = seg
                .to_str_lossy()
                .map_err(|e| TranscribeError::Other(format!("讀取文本失敗：{e}")))?;
            segments.push(Segment {
                index: seg.segment_index() as u32,
                start: seg.start_timestamp() as f64 / 100.0,
                end: seg.end_timestamp() as f64 / 100.0,
                text: raw.trim().to_owned(),
            });
        }
    }
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 測試用的互斥鎖：三個會操作全域取消旗標（CANCEL_FLAG）的轉錄測試
    /// 需互斥執行，避免 `cargo test` 多執行緒並行時互相污染旗標造成假失敗。
    static TRANSCRIBE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 在 release 模式下重現「轉錄閃退」：cargo test --release
    #[test]
    fn test_transcribe_full_pipeline() {
        let _guard = TRANSCRIBE_TEST_LOCK.lock().unwrap();
        let manifest = env!("CARGO_MANIFEST_DIR");
        let model = format!("{manifest}/models/ggml-base.bin");
        let media = format!("{manifest}/test.mp4");
        if !Path::new(&model).exists() || !Path::new(&media).exists() {
            eprintln!("skip: 缺少模型或測試影片");
            return;
        }
        let mono = crate::audio::extract_mono_16k(&media).expect("抽取音訊失敗");
        println!("音訊樣本數：{}", mono.samples.len());
        let (tx, rx) = std::sync::mpsc::channel();
        let segs = transcribe(Path::new(&model), &mono.samples, Some("ja"), Some(tx))
            .expect("轉錄失敗");
        drop(rx);
        println!("分段數：{}", segs.len());
        for s in segs.iter().take(5) {
            println!("  [{:.2}-{:.2}] {}", s.start, s.end, s.text);
        }
    }

    /// 驗證修正「轉錄完成但字幕不出現」的核心：
    /// whisper-rs 的 FullParams 沒有 Drop，progress callback 內持有的 Sender
    /// 會被洩漏、channel 永不關閉。此時 forwarder 若依賴「rx Disconnect 才結束」
    /// 會永遠卡住。改用獨立的 done 旗標收尾後，forwarder 應能正常 join。
    ///
    /// 此測試故意不 drop（也不持有）tx：`transcribe` 內部把 tx 移入 progress
    /// callback 並被 whisper-rs 洩漏。返回主線程後只設 done=true，forwarder 必須
    /// 靠旗標結束，否則 join 會卡住（測試逾時/不會到 expect）。
    #[test]
    fn test_forwarder_terminates_after_done_flag() {
        let _guard = TRANSCRIBE_TEST_LOCK.lock().unwrap();
        let manifest = env!("CARGO_MANIFEST_DIR");
        let model = format!("{manifest}/models/ggml-base.bin");
        if !Path::new(&model).exists() {
            eprintln!("skip: 缺少模型");
            return;
        }
        // 8 秒純靜音（whisper 可能回 0 段，但流程必須正常結束）
        let samples: Vec<f32> = vec![0.0; 8 * 16000];

        let (tx, rx) = std::sync::mpsc::channel::<i32>();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fwd_done = std::sync::Arc::clone(&done);
        let progress_seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let prog_cnt = std::sync::Arc::clone(&progress_seen);

        let forwarder = std::thread::spawn(move || {
            let drain = || {
                while let Ok(_pct) = rx.try_recv() {
                    prog_cnt.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            };
            loop {
                drain();
                if fwd_done.load(std::sync::atomic::Ordering::SeqCst) {
                    drain();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });

        let _ = transcribe(Path::new(&model), &samples, Some("ja"), Some(tx));
        // 刻意不 drop tx：模擬 whisper-rs 洩漏。tx 已移入 progress callback。

        // 若無 done 旗標收尾，此 join 會因 channel 未關閉而永遠卡住。
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        forwarder.join().expect("forwarder 應在 done 旗標後正常結束");
        println!("forwarder 收到進度訊息數：{}", progress_seen.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// 驗證取消機制：轉錄途中 request_cancel() 後，transcribe 應回
    /// TranscribeError::Cancelled（而非真實錯誤或長時間卡住）。
    #[test]
    fn test_transcribe_cancelled() {
        let _guard = TRANSCRIBE_TEST_LOCK.lock().unwrap();
        let manifest = env!("CARGO_MANIFEST_DIR");
        let model = format!("{manifest}/models/ggml-base.bin");
        if !Path::new(&model).exists() {
            eprintln!("skip: 缺少模型");
            return;
        }
        // 60 秒純靜音 ── 若未取消會轉錄一陣子；取消後應快速回退。
        let samples: Vec<f32> = vec![0.0; 60 * 16000];

        reset_cancel();
        let (tx, rx) = std::sync::mpsc::channel::<i32>();
        // 延遲觸發取消：與全長 60s 相比，於短時間內就 request_cancel
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            request_cancel();
        });

        // 以另一個執行緒跑轉錄，避免測試本身卡在 full()（若取消機制失效）
        let model2 = model.clone();
        let handle = std::thread::spawn(move || {
            transcribe(Path::new(&model2), &samples, Some("ja"), Some(tx))
        });

        match handle.join() {
            Ok(Ok(_)) => {
                drop(rx);
                panic!("取消後不應成功返回完整結果");
            }
            Ok(Err(TranscribeError::Cancelled)) => {
                drop(rx);
                println!("取消生效：回傳 TranscribeError::Cancelled");
            }
            Ok(Err(e)) => {
                drop(rx);
                panic!("取消後回傳了錯誤而非 Cancelled：{e}");
            }
            Err(_) => {
                drop(rx);
                panic!("轉錄執行緒發生 panic");
            }
        }
    }
}