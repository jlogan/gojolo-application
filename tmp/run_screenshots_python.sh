#!/bin/bash
# Python-based screenshot runner using a venv
# Usage: bash run_screenshots_python.sh

set -e

TMP_DIR="/Users/jaylogan/Projects/gojolo-application/tmp"
VENV_DIR="$TMP_DIR/.venv"

echo "=== Jolo Invoice Screenshot Runner (Python) ==="

mkdir -p "$TMP_DIR"

# Create venv if needed
if [ ! -d "$VENV_DIR" ]; then
    echo "[1] Creating Python venv..."
    python3 -m venv "$VENV_DIR"
fi

echo "[2] Installing playwright in venv..."
"$VENV_DIR/bin/pip" install -q playwright

echo "[3] Installing chromium browser..."
"$VENV_DIR/bin/playwright" install chromium 2>&1 | tail -3

echo "[4] Running screenshot script..."
"$VENV_DIR/bin/python" "$TMP_DIR/screenshot_invoices.py"

echo ""
echo "Screenshots:"
ls -la "$TMP_DIR"/ss-*.png 2>/dev/null || echo "No screenshots found"
