#!/usr/bin/env python3
from __future__ import annotations

import re
import sys


CONTROL_SEQUENCE_RE = re.compile(
  rb"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]"
)


def clean_chunk(data: bytes) -> bytes:
  cleaned = CONTROL_SEQUENCE_RE.sub(b"", data)
  cleaned = cleaned.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
  return re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", b"", cleaned)


def main() -> int:
  while True:
    chunk = sys.stdin.buffer.read1(4096)
    if not chunk:
      return 0
    sys.stdout.buffer.write(clean_chunk(chunk))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
  raise SystemExit(main())
