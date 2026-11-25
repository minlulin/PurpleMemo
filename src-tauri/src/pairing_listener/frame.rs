//! The pairing frame codec (§11.6.1): four big-endian bytes of body length,
//! then exactly that many bytes of UTF-8 JSON. `src/lib/sync/frame.ts` is the
//! phone's half, and both sides are pinned to the same byte vector by a test.

use super::{FRAME_HEADER_BYTES, MAX_FRAME_BYTES};

/// Frame one UTF-8 JSON document with its four-byte length prefix.
pub fn encode_frame(text: &str) -> Result<Vec<u8>, String> {
    let body = text.as_bytes();
    if body.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "a pairing message is limited to {MAX_FRAME_BYTES} bytes"
        ));
    }
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

/// Read one framed document. The length must match the body exactly: a
/// truncated frame is refused rather than decoded from whatever is left.
pub fn decode_frame(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < FRAME_HEADER_BYTES {
        return Err("a frame begins with a four-byte length.".to_string());
    }
    let length = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if length > MAX_FRAME_BYTES {
        return Err("the frame is larger than the pairing limit.".to_string());
    }
    if bytes.len() - FRAME_HEADER_BYTES != length {
        return Err("the frame's length prefix does not match its body.".to_string());
    }
    String::from_utf8(bytes[FRAME_HEADER_BYTES..].to_vec())
        .map_err(|_| "the frame is not UTF-8.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::envelope;

    /// The framing both sides speak. `src/lib/sync/frame.test.ts` pins the same
    /// `00000011` prefix for the same plaintext.
    #[test]
    fn a_frame_is_four_big_endian_length_bytes_then_utf8_json() {
        let text = "{\"hello\":\"world\"}";
        let frame = encode_frame(text).expect("frame");
        assert_eq!(
            envelope::to_hex(&frame),
            format!("00000011{}", envelope::to_hex(text.as_bytes()))
        );
        assert_eq!(decode_frame(&frame).expect("decode"), text);

        assert!(
            decode_frame(&frame[..3]).is_err(),
            "three bytes is not a frame"
        );
        assert!(
            decode_frame(&frame[..frame.len() - 1]).is_err(),
            "a truncated body is refused, not guessed"
        );
        let mut longer = frame.clone();
        longer.push(b' ');
        assert!(
            decode_frame(&longer).is_err(),
            "a length that does not match the body is refused"
        );
        assert!(
            decode_frame(&[0xff, 0xff, 0xff, 0xff]).is_err(),
            "an absurd length is refused before anything is allocated"
        );
        assert!(
            decode_frame(b"\x00\x00\x00\x01\xff").is_err(),
            "the body must be UTF-8"
        );
    }
}
