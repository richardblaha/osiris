"""Osiris speech: text to speech with Piper (https://github.com/OHF-Voice/piper1-gpl), Czech and English voices.

POST /tts {"text": "...", "lang": "cs"|"en"} answers audio/wav; GET /healthz answers ok. Inside the cluster only
(the gateway and the digital twin call it for signed-in users); one sentence at a time is synthesized, texts are
capped, and the voices load once at start.
"""

import io
import json
import os
import re
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

from piper import PiperVoice

VOICES_DIR = os.environ.get("VOICES_DIR", "/voices")
VOICES = {
    "cs": os.environ.get("VOICE_CS", "cs_CZ-jirka-medium"),
    "en": os.environ.get("VOICE_EN", "en_US-lessac-medium"),
}
MAX_TEXT = 5000
PORT = int(os.environ.get("PORT", "8080"))

voices = {lang: PiperVoice.load(os.path.join(VOICES_DIR, f"{name}.onnx")) for lang, name in VOICES.items()}
# ONNX sessions are not made for concurrent runs: one synthesis per voice at a time.
locks = {lang: Lock() for lang in voices}


def clean(text: str) -> str:
    """Markdown and links read badly aloud: keep the words."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[*_#>|~]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:MAX_TEXT]


def synthesize(text: str, lang: str) -> bytes:
    voice = voices.get(lang) or voices["cs"]
    out = io.BytesIO()
    with locks.get(lang, locks["cs"]), wave.open(out, "wb") as wav:
        voice.synthesize_wav(text, wav)
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, kind: str) -> None:
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self._send(200, b'{"ok":true}', "application/json")
        self._send(404, b"{}", "application/json")

    def do_POST(self) -> None:
        if self.path != "/tts":
            return self._send(404, b"{}", "application/json")
        try:
            length = min(int(self.headers.get("content-length", "0")), 64 * 1024)
            body = json.loads(self.rfile.read(length) or b"{}")
            text = clean(str(body.get("text", "")))
            lang = str(body.get("lang", "cs"))[:2].lower()
        except (ValueError, json.JSONDecodeError):
            return self._send(400, b'{"error":"invalid request"}', "application/json")
        if not text:
            return self._send(400, b'{"error":"no text"}', "application/json")
        self._send(200, synthesize(text, "cs" if lang in ("cs", "sk") else lang), "audio/wav")

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - the base class's name
        # One line per request, without the text (it may be private).
        print(f'{{"event":"tts","status":"{args[1] if len(args) > 1 else ""}"}}', flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
