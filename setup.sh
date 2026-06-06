#!/usr/bin/env bash
# Bootstraps native dependencies for english-tutor:
#   - whisper.cpp (compiled, CPU-only) + small.en quantized model
#   - piper TTS binary + en_US-amy-medium voice
#
# Idempotent: skips steps that are already done.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$ROOT/vendor"
BIN="$ROOT/bin"
MODELS="$ROOT/data/models"

mkdir -p "$VENDOR" "$BIN" "$MODELS"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

# ---- 0. apt deps -------------------------------------------------------------
need_apt=()
for pkg in build-essential cmake ffmpeg; do
  dpkg -s "$pkg" >/dev/null 2>&1 || need_apt+=("$pkg")
done
if (( ${#need_apt[@]} > 0 )); then
  log "Installing apt packages: ${need_apt[*]} (sudo required)"
  sudo apt-get update
  sudo apt-get install -y "${need_apt[@]}"
else
  log "apt deps already present"
fi

# ---- 1. whisper.cpp ----------------------------------------------------------
WHISPER_DIR="$VENDOR/whisper.cpp"
WHISPER_BIN_SRC="$WHISPER_DIR/build/bin/whisper-cli"

if [[ ! -d "$WHISPER_DIR" ]]; then
  log "Cloning whisper.cpp"
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
else
  log "whisper.cpp already cloned"
fi

if [[ ! -x "$WHISPER_BIN_SRC" ]]; then
  log "Building whisper.cpp (CPU)"
  cmake -B "$WHISPER_DIR/build" -S "$WHISPER_DIR" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$WHISPER_DIR/build" -j --config Release
else
  log "whisper.cpp already built"
fi

cp -f "$WHISPER_BIN_SRC" "$BIN/whisper-cli"
log "whisper-cli -> $BIN/whisper-cli"

# ---- 2. Whisper model --------------------------------------------------------
MODEL_FILE="$MODELS/ggml-small.en-q5_1.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin"

if [[ ! -f "$MODEL_FILE" ]]; then
  log "Downloading Whisper model (small.en q5_1, ~190 MB)"
  curl -L --fail -o "$MODEL_FILE" "$MODEL_URL"
else
  log "Whisper model already present"
fi

# ---- 3. Piper ----------------------------------------------------------------
PIPER_DIR="$VENDOR/piper"
PIPER_TARBALL="$VENDOR/piper_linux_x86_64.tar.gz"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"

if [[ ! -x "$PIPER_DIR/piper" ]]; then
  log "Downloading Piper TTS"
  curl -L --fail -o "$PIPER_TARBALL" "$PIPER_URL"
  tar -xzf "$PIPER_TARBALL" -C "$VENDOR"
  rm -f "$PIPER_TARBALL"
else
  log "Piper already extracted"
fi

# Wrap piper so it finds its vendored .so files instead of copying just the binary.
cat > "$BIN/piper" <<'EOF'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LD_LIBRARY_PATH="$HERE/vendor/piper:${LD_LIBRARY_PATH:-}"
exec "$HERE/vendor/piper/piper" "$@"
EOF
chmod +x "$BIN/piper"
log "piper -> $BIN/piper (wrapper over vendor/piper/)"

# ---- 4. Piper voice ----------------------------------------------------------
VOICE_ONNX="$MODELS/en_US-amy-medium.onnx"
VOICE_JSON="$MODELS/en_US-amy-medium.onnx.json"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium"

if [[ ! -f "$VOICE_ONNX" ]]; then
  log "Downloading Piper voice (en_US-amy-medium, ~60 MB)"
  curl -L --fail -o "$VOICE_ONNX" "$VOICE_BASE/en_US-amy-medium.onnx"
fi
if [[ ! -f "$VOICE_JSON" ]]; then
  curl -L --fail -o "$VOICE_JSON" "$VOICE_BASE/en_US-amy-medium.onnx.json"
fi

# ---- 5. Smoke tests ----------------------------------------------------------
log "Smoke testing whisper-cli"
"$BIN/whisper-cli" --help >/dev/null || fail "whisper-cli failed"

log "Smoke testing piper"
echo "Hello, this is a quick test of the text to speech engine." \
  | "$BIN/piper" --model "$VOICE_ONNX" --output_file "$ROOT/data/audio/_setup_test.wav" \
  || fail "piper failed"
log "Wrote $ROOT/data/audio/_setup_test.wav  (play it to verify TTS)"

log "Done."
