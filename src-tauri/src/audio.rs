use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_16k() {
        // 用專案內的 DaVinci 範例影片驗證抽音訊 + 重取樣管線
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/test.mp4");
        if !std::path::Path::new(path).exists() {
            eprintln!("skip: test.mp4 不存在");
            return;
        }
        let mono = extract_mono_16k(path).expect("抽取音訊失敗");
        assert!(!mono.samples.is_empty(), "音訊不應為空");
        println!("抽出樣本數：{}（16kHz）≈ {:.1}s", mono.samples.len(), mono.samples.len() as f64 / 16000.0);
    }

    #[test]
    fn test_resample_44k_to_16k() {
        let src_rate = 44_100u32;
        let input: Vec<f32> = (0..44_100).map(|i| (i % 400) as f32 / 200.0 - 1.0).collect();
        let out = resample(&input, src_rate, 16_000).expect("重取樣失敗");
        let expected = (input.len() as f64 * 16000.0 / 44100.0) as usize;
        assert!((out.len() as i64 - expected as i64).abs() <= 2, "len {} vs {expected}", out.len());
        assert!(out.iter().all(|v| v.is_finite()));
    }
}

/// Whisper 需要的音訊格式：16kHz 單聲道 f32。
pub struct MonoAudio {
    pub samples: Vec<f32>,
}

/// 抽音訊被取消時回傳的錯誤標記（lib.rs 據此發出 transcribe-cancelled）。
pub const CANCELLED_MARKER: &str = "__CANCELLED__";

/// 從影片檔抽出音訊，並重取樣成 16kHz 單聲道 f32。
/// 若轉錄取消旗標被設定（`crate::transcribe::is_cancelled()`），
/// 會中途停止解碼並回傳 `CANCELLED_MARKER`。
pub fn extract_mono_16k(path: &str) -> Result<MonoAudio, String> {
    let file = File::open(path).map_err(|e| format!("無法開啟檔案：{e}"))?;
    let byte_len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);

    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    hint.with_extension(ext);

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("無法解析檔案格式：{e}"))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "找不到音訊軌".to_string())?
        .clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("無法建立音訊解碼器：{e}"))?;

    let track_id = track.id;
    let mut interleaved: Vec<f32> = Vec::with_capacity(byte_len / 4);
    let mut sample_rate: u32 = 0;
    let mut channels: usize = 1;

    loop {
        // 每個封包檢查一次取消旗標（atomic load 開銷極小），
        // 讓「抽取音訊」階段也能被中斷按鈕停止。
        if crate::transcribe::is_cancelled() {
            return Err(CANCELLED_MARKER.to_string());
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("讀取封包失敗：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                sample_rate = spec.rate;
                channels = spec.channels.count() as usize;
                let frames = decoded.capacity() as usize;
                let mut buf = SampleBuffer::<f32>::new(frames as u64, spec);
                buf.copy_interleaved_ref(decoded);
                interleaved.extend_from_slice(buf.samples());
            }
            Err(SymphoniaError::DecodeError(_)) => {
                continue; // 單一壞掉封包跳過
            }
            Err(e) => return Err(format!("解碼失敗：{e}")),
        }
    }

    if interleaved.is_empty() {
        return Err("沒有解出任何音訊資料".to_string());
    }

    // 混成單聲道
    let mono = if channels == 1 {
        interleaved
    } else {
        interleaved
            .chunks_exact(channels)
            .map(|c| c.iter().sum::<f32>() / c.len() as f32)
            .collect()
    };

    let target = 16_000u32;
    let samples = if sample_rate == target {
        mono
    } else {
        resample(&mono, sample_rate, target)?
    };

    Ok(MonoAudio {
        samples,
    })
}

/// 輕量重取樣：降採樣用 box 平均抗鋸齒，升採樣用線性內插。
fn resample(input: &[f32], src: u32, target: u32) -> Result<Vec<f32>, String> {
    if src == 0 || target == 0 {
        return Err("無效的取樣率".to_string());
    }
    if src == target {
        return Ok(input.to_vec());
    }
    let ratio = target as f64 / src as f64;
    let out_len = (input.len() as f64 * ratio) as usize;
    let mut out: Vec<f32> = Vec::with_capacity(out_len);

    if ratio < 1.0 {
        // 降採樣：來源取樣區間平均
        let step = 1.0 / ratio;
        let mut next = 0usize;
        for _ in 0..out_len {
            let start = next;
            let end = (((start as f64 + step).floor() as usize).max(start + 1)).min(input.len());
            let sum: f32 = input[start..end].iter().sum();
            out.push(sum / (end - start) as f32);
            next = end;
        }
    }    else {
        // 升採樣：線性內插
        let inv = 1.0 / ratio;
        for j in 0..out_len {
            let x = j as f64 * inv;
            let i0 = x.floor() as usize;
            let i1 = (i0 + 1).min(input.len().saturating_sub(1));
            let frac = (x - i0 as f64) as f32;
            out.push(input[i0] * (1.0 - frac) + input[i1] * frac);
        }
    }
    Ok(out)
}