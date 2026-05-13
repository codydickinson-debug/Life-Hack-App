#!/bin/bash
# Double-click to launch StockAnalyzer.
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"
exec "$DIR/venv/bin/python" "$DIR/app.py"
