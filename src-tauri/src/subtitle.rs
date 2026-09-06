use crate::transcribe::Segment;

/// 將分段組成標準 SRT（UTF-8）字串，相容 DaVinci Resolve 匯入。
///
/// 防禦性處理（不依賴前端保證）：
/// - 依開始時間排序
/// - 過濾空白文字與起訖不合法（end <= start）的段落
/// - 相鄰段落時間重疊時，將後段的開始夾平到前段的結束；
///   若該段因此完全被前段覆蓋（end <= start），則略過該段。
pub fn to_srt(segments: &[Segment]) -> String {
    let mut order: Vec<usize> = (0..segments.len()).collect();
    order.sort_by(|&a, &b| {
        segments[a]
            .start
            .partial_cmp(&segments[b].start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // (trimmed text, start, end)
    let mut clean: Vec<(&str, f64, f64)> = Vec::new();
    for &i in &order {
        let seg = &segments[i];
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        let s = seg.start.max(0.0);
        let e = seg.end;
        if e <= s {
            continue;
        }
        let (s, e) = match clean.last() {
            Some((_, _, prev_end)) if s < *prev_end => {
                // 與前一段重疊：夾平開始時間；若因此不合法則整段略過
                let s = *prev_end;
                if e <= s {
                    continue;
                }
                (s, e)
            }
            _ => (s, e),
        };
        clean.push((text, s, e));
    }

    let mut out = String::new();
    for (i, (text, s, e)) in clean.iter().enumerate() {
        out.push_str(&format!("{}\n", i + 1));
        out.push_str(&format!("{} --> {}\n", fmt_ts(*s), fmt_ts(*e)));
        out.push_str(text);
        out.push('\n');
        if i + 1 < clean.len() {
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