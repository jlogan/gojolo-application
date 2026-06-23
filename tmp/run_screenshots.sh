#!/bin/bash
# Run this script to take invoice screenshots for jolo app
# Usage: bash /Users/jaylogan/Projects/gojolo-application/tmp/run_screenshots.sh

set -e

TMP_DIR="/Users/jaylogan/Projects/gojolo-application/tmp"
PROJECT_DIR="/Users/jaylogan/Projects/gojolo-application"

echo "=== Jolo Invoice Screenshot Runner ==="
echo "Output dir: $TMP_DIR"

# Ensure tmp dir exists
mkdir -p "$TMP_DIR"

# Check if dev server is running
echo ""
echo "[1] Checking dev server at http://127.0.0.1:5173..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173 2>/dev/null || echo "000")
echo "    HTTP status: $HTTP_CODE"

if [ "$HTTP_CODE" != "200" ]; then
    echo "    ⚠ Dev server may not be running! Expected 200, got $HTTP_CODE"
    echo "    Attempting to continue anyway..."
fi

# Check for Node.js
echo ""
echo "[2] Checking Node.js..."
NODE_PATH=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_PATH" ]; then
    # Try hermes node
    if [ -f "/Users/jaylogan/.hermes/node/bin/node" ]; then
        NODE_PATH="/Users/jaylogan/.hermes/node/bin/node"
        NPX_PATH="/Users/jaylogan/.hermes/node/bin/npx"
        echo "    Using hermes node: $NODE_PATH"
    else
        echo "    ❌ Node.js not found!"
        exit 1
    fi
else
    NPX_PATH=$(which npx 2>/dev/null || echo "$(dirname $NODE_PATH)/npx")
    echo "    Node: $NODE_PATH ($(${NODE_PATH} --version))"
    echo "    npx: $NPX_PATH"
fi

# Check if playwright is available
echo ""
echo "[3] Checking Playwright..."
PW_AVAILABLE=false

# Check in project node_modules
if [ -f "$PROJECT_DIR/node_modules/.bin/playwright" ]; then
    echo "    Found in project node_modules"
    PW_AVAILABLE=true
    PLAYWRIGHT_BIN="$PROJECT_DIR/node_modules/.bin/playwright"
fi

# Check globally
if ! $PW_AVAILABLE; then
    GLOBAL_PW=$(which playwright 2>/dev/null || echo "")
    if [ -n "$GLOBAL_PW" ]; then
        echo "    Found globally: $GLOBAL_PW"
        PW_AVAILABLE=true
    fi
fi

# Install if needed
if ! $PW_AVAILABLE; then
    echo "    Installing Playwright (this may take a minute)..."
    cd "$TMP_DIR"
    
    # Create a minimal package.json for the tmp dir
    cat > "$TMP_DIR/pw_package.json" <<'JSON'
{
  "name": "jolo-screenshots",
  "version": "1.0.0",
  "type": "module",
  "private": true
}
JSON
    
    # Install playwright
    cd "$TMP_DIR"
    $NPX_PATH --yes playwright@latest install --with-deps chromium 2>&1 | tail -5
    echo "    Playwright installed"
fi

# Run the Node.js script
echo ""
echo "[4] Running screenshot script..."
cd "$TMP_DIR"

# Try to run with playwright's node
if [ -n "$PLAYWRIGHT_BIN" ]; then
    $PLAYWRIGHT_BIN node "$TMP_DIR/screenshot_invoices.mjs" 2>&1
else
    $NODE_PATH "$TMP_DIR/screenshot_invoices.mjs" 2>&1
fi

echo ""
echo "[5] Screenshots in $TMP_DIR:"
ls -la "$TMP_DIR"/*.png 2>/dev/null || echo "    No PNG files found"

echo ""
echo "Done."
