use crate::transcribe::Segment;

/// 將分段組成標準 SRT（UTF-8）字串，相容 DaVinci Resolve 匯入。
pub fn to_srt(segments: &[Segment]) -> String {
    let mut out = String::new();
    for (i, seg) in segments.iter().enumerate() {
        out.push_str(&format!("{}\n", i + 1));
        out.push_str(&format!("{} --> {}\n", fmt_ts(seg.start), fmt_ts(seg.end)));
        out.push_str(seg.text.trim());
        out.push('\n');
        if i + 1 < segments.len() {
            out.push('\n');
        }
    }
    out
}

/// 秒數 → `HH:MM:SS,mmm`。
fn fmt_ts(secs: f64) -> String {
    let ms = (secs * 1000.0).round().max(0.0) as i64;
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let milli = ms % 1000;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, milli)
}