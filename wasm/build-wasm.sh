#!/bin/bash
set -e
echo "WASM build - Rust + wasm-pack szukseges. Docker-rel:"
echo "  docker run --rm -v \$(pwd):/app -w /app rust:1.84 bash -c 'cargo install wasm-pack 2>/dev/null; wasm-pack build --target nodejs'"
echo ""
if command -v wasm-pack &>/dev/null; then
	wasm-pack build --target nodejs
	echo "Build sikerult: pkg/ mappa"
else
	echo "wasm-pack nem talalhato. Futtasd a fenti docker parancsot."
	exit 1
fi
