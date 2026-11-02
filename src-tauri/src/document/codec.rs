use encoding_rs::{EUC_KR, UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};

use super::{DocumentError, DocumentResult};

pub const MAX_DOCUMENT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Cp949,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    None,
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Debug, Clone)]
pub struct DecodedDocument {
    pub content: String,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
    pub preferred_line_ending: LineEnding,
}

pub fn decode_document(bytes: &[u8]) -> DocumentResult<DecodedDocument> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(DocumentError::new(
            "TOO_LARGE",
            "The selected file is larger than 10 MiB.",
        ));
    }

    let (decoded, encoding) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let text = std::str::from_utf8(&bytes[3..]).map_err(|_| {
            DocumentError::new("UNSUPPORTED_ENCODING", "Invalid UTF-8 byte sequence.")
        })?;
        (text.to_owned(), TextEncoding::Utf8Bom)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        decode_with(UTF_16LE, &bytes[2..], TextEncoding::Utf16Le)?
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        decode_with(UTF_16BE, &bytes[2..], TextEncoding::Utf16Be)?
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        if looks_binary(text) {
            return Err(DocumentError::new(
                "BINARY_FILE",
                "The selected file appears to be binary.",
            ));
        }
        (text.to_owned(), TextEncoding::Utf8)
    } else {
        decode_with(EUC_KR, bytes, TextEncoding::Cp949)?
    };

    if looks_binary(&decoded) {
        return Err(DocumentError::new(
            "BINARY_FILE",
            "The selected file appears to be binary.",
        ));
    }

    let (line_ending, preferred_line_ending) = detect_line_endings(&decoded);
    let content = decoded.replace("\r\n", "\n").replace('\r', "\n");

    Ok(DecodedDocument {
        content,
        encoding,
        line_ending,
        preferred_line_ending,
    })
}

pub fn encode_document(
    content: &str,
    encoding: TextEncoding,
    line_ending: LineEnding,
) -> DocumentResult<Vec<u8>> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let with_line_endings = match line_ending {
        LineEnding::Crlf => normalized.replace('\n', "\r\n"),
        LineEnding::Cr => normalized.replace('\n', "\r"),
        _ => normalized,
    };

    match encoding {
        TextEncoding::Utf8 => Ok(with_line_endings.into_bytes()),
        TextEncoding::Utf8Bom => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(with_line_endings.as_bytes());
            Ok(bytes)
        }
        TextEncoding::Utf16Le => {
            let mut bytes = vec![0xFF, 0xFE];
            for unit in with_line_endings.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(bytes)
        }
        TextEncoding::Utf16Be => {
            let mut bytes = vec![0xFE, 0xFF];
            for unit in with_line_endings.encode_utf16() {
                bytes.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(bytes)
        }
        TextEncoding::Cp949 => {
            let (bytes, _, had_errors) = EUC_KR.encode(&with_line_endings);
            if had_errors {
                Err(DocumentError::new(
                    "UNSUPPORTED_ENCODING",
                    "This document contains characters that cannot be represented as CP949.",
                ))
            } else {
                Ok(bytes.into_owned())
            }
        }
    }
}

fn decode_with(
    encoding: &'static encoding_rs::Encoding,
    bytes: &[u8],
    text_encoding: TextEncoding,
) -> DocumentResult<(String, TextEncoding)> {
    let (text, had_errors) = encoding.decode_without_bom_handling(bytes);
    if had_errors {
        return Err(DocumentError::new(
            "UNSUPPORTED_ENCODING",
            "The selected file uses an unsupported or malformed text encoding.",
        ));
    }
    Ok((text.into_owned(), text_encoding))
}

fn looks_binary(text: &str) -> bool {
    text.chars().take(8192).any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    })
}

fn detect_line_endings(content: &str) -> (LineEnding, LineEnding) {
    let bytes = content.as_bytes();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                crlf += 1;
                index += 2;
            }
            b'\r' => {
                cr += 1;
                index += 1;
            }
            b'\n' => {
                lf += 1;
                index += 1;
            }
            _ => index += 1,
        }
    }

    let used = [crlf > 0, lf > 0, cr > 0]
        .into_iter()
        .filter(|used| *used)
        .count();
    let preferred = if crlf >= lf && crlf >= cr && crlf > 0 {
        LineEnding::Crlf
    } else if lf >= cr && lf > 0 {
        LineEnding::Lf
    } else if cr > 0 {
        LineEnding::Cr
    } else {
        default_line_ending()
    };

    let line_ending = match used {
        0 => LineEnding::None,
        1 if crlf > 0 => LineEnding::Crlf,
        1 if lf > 0 => LineEnding::Lf,
        1 => LineEnding::Cr,
        _ => LineEnding::Mixed,
    };

    (line_ending, preferred)
}

pub fn default_line_ending() -> LineEnding {
    if cfg!(windows) {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_utf8_bom_and_crlf() {
        let bytes = b"\xEF\xBB\xBFhello\r\nworld\r\n";
        let decoded = decode_document(bytes).expect("decode");
        assert_eq!(decoded.encoding, TextEncoding::Utf8Bom);
        assert_eq!(decoded.line_ending, LineEnding::Crlf);
        assert_eq!(decoded.content, "hello\nworld\n");

        let encoded = encode_document(
            &decoded.content,
            decoded.encoding,
            decoded.preferred_line_ending,
        )
        .expect("encode");
        assert_eq!(encoded.as_slice(), bytes.as_ref());
    }

    #[test]
    fn round_trips_cp949_korean() {
        let original = "안녕하세요\r\n마크다운";
        let (bytes, _, had_errors) = EUC_KR.encode(original);
        assert!(!had_errors);

        let decoded = decode_document(&bytes).expect("decode");
        assert_eq!(decoded.encoding, TextEncoding::Cp949);
        assert_eq!(decoded.content, "안녕하세요\n마크다운");

        let encoded = encode_document(
            &decoded.content,
            decoded.encoding,
            decoded.preferred_line_ending,
        )
        .expect("encode");
        assert_eq!(encoded.as_slice(), bytes.as_ref());
    }

    #[test]
    fn round_trips_utf16_little_and_big_endian() {
        for encoding in [TextEncoding::Utf16Le, TextEncoding::Utf16Be] {
            let original = "한글과 English\r\nsecond line";
            let bytes = encode_document(original, encoding, LineEnding::Crlf).expect("encode");
            let decoded = decode_document(&bytes).expect("decode");

            assert_eq!(decoded.encoding, encoding);
            assert_eq!(decoded.line_ending, LineEnding::Crlf);
            assert_eq!(decoded.content, "한글과 English\nsecond line");
            assert_eq!(
                encode_document(
                    &decoded.content,
                    decoded.encoding,
                    decoded.preferred_line_ending,
                )
                .expect("re-encode"),
                bytes
            );
        }
    }

    #[test]
    fn detects_mixed_line_endings() {
        let decoded = decode_document(b"one\r\ntwo\nthree\r").expect("decode");
        assert_eq!(decoded.line_ending, LineEnding::Mixed);
        assert_eq!(decoded.preferred_line_ending, LineEnding::Crlf);
        assert_eq!(decoded.content, "one\ntwo\nthree\n");
    }

    #[test]
    fn rejects_binary_files() {
        let error = decode_document(b"hello\0world").expect_err("binary");
        assert_eq!(error.code, "BINARY_FILE");
    }

    #[test]
    fn rejects_oversized_files() {
        let bytes = vec![b'a'; MAX_DOCUMENT_BYTES + 1];
        let error = decode_document(&bytes).expect_err("large");
        assert_eq!(error.code, "TOO_LARGE");
    }
}
