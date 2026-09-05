#[cfg(test)]
mod symphonia_test {
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use std::fs::File;

    #[test]
    fn test_read_davinci_export() {
        // open file
        let file = File::open("test.mp4").expect("找不到檔案");
        let mss =  MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();

        hint.with_extension("mp4");

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
            .expect("無法解析檔案格式，可能是不支援的編碼格式或檔案損毀");

        let mut format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .expect("找不到音訊軌");

        println!("取樣率： {:?}", track.codec_params.sample_rate);
        println!("聲道數： {:?}", track.codec_params.channels);
        println!("編碼： {:?}", track.codec_params.codec);

        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .expect("無法建立解碼器，可能是不支援的編碼格式");

        let track_id = track.id;
        let mut packet_count = 0;
        while let Ok(packet) = format.next_packet() {
            if packet.track_id() != track_id {
                continue;
            }

            match decoder.decode(&packet) {
                Ok(decoded) => {
                    println!("解碼成功，取樣數： {}", decoded.frames());
                    
                    packet_count += 1;

                    if packet_count >= 5 {
                        break; // 先取前五個
                    }
                }
                Err(err) => {
                    println!("解碼失敗: {:?}", err);
                }
            }
        }

        assert!(packet_count > 0, "沒有解碼任何音訊封包");
    }
}