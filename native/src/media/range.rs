// SPDX-License-Identifier: GPL-3.0-only

/// An inclusive byte range, matching the HTTP `Range: bytes=start-end`
/// convention and the existing loopback service contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ByteRange {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) partial: bool,
}

/// Parses a single HTTP byte range.
///
/// Multiple ranges, malformed values, overflows and unsatisfiable ranges are
/// rejected. An absent header means the complete resource, as in the Node
/// service's `parseRange` primitive.
pub(crate) fn parse_range(header: Option<&str>, size: usize) -> Option<ByteRange> {
    if header.is_none() {
        if size == 0 {
            return None;
        }
        return Some(ByteRange {
            start: 0,
            end: size - 1,
            partial: false,
        });
    }
    if size == 0 {
        return None;
    }
    let value = header?;
    let value = value.strip_prefix("bytes=")?;
    if value.is_empty() || value.contains(',') {
        return None;
    }
    let (start_text, end_text) = value.split_once('-')?;
    if start_text.is_empty() && end_text.is_empty() {
        return None;
    }
    if start_text.is_empty() {
        let suffix = decimal(end_text)?;
        if suffix == 0 {
            return None;
        }
        let start = size.saturating_sub(suffix);
        return Some(ByteRange {
            start,
            end: size - 1,
            partial: true,
        });
    }

    let start = decimal(start_text)?;
    if start >= size {
        return None;
    }
    let end = if end_text.is_empty() {
        size - 1
    } else {
        decimal(end_text)?.min(size - 1)
    };
    if end < start {
        return None;
    }
    Some(ByteRange {
        start,
        end,
        partial: true,
    })
}

fn decimal(value: &str) -> Option<usize> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{ByteRange, parse_range};

    #[test]
    fn parses_exact_open_and_suffix_ranges() {
        assert_eq!(
            parse_range(Some("bytes=2-4"), 10),
            Some(ByteRange {
                start: 2,
                end: 4,
                partial: true,
            })
        );
        assert_eq!(
            parse_range(Some("bytes=7-"), 10),
            Some(ByteRange {
                start: 7,
                end: 9,
                partial: true,
            })
        );
        assert_eq!(
            parse_range(Some("bytes=-4"), 10),
            Some(ByteRange {
                start: 6,
                end: 9,
                partial: true,
            })
        );
        assert_eq!(
            parse_range(Some("bytes=4-900"), 10),
            Some(ByteRange {
                start: 4,
                end: 9,
                partial: true,
            })
        );
        assert_eq!(
            parse_range(None, 10),
            Some(ByteRange {
                start: 0,
                end: 9,
                partial: false,
            })
        );
        assert_eq!(parse_range(None, 0), None);
    }

    #[test]
    fn rejects_invalid_and_unsatisfiable_ranges() {
        for value in [
            "bytes=10-",
            "bytes=4-2",
            "bytes=-0",
            "bytes=0-1,4-5",
            "bytes=9007199254740992-",
            "bytes=abc-def",
            "bytes=--",
            "bytes=+1-2",
            "bytes=-+2",
        ] {
            assert_eq!(parse_range(Some(value), 10), None, "{value}");
        }
        assert_eq!(parse_range(Some("bytes=0-"), 0), None);
    }
}
