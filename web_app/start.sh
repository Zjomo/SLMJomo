#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"
PYTHON_CMD=${PYTHON:-python3}

if ! command -v "$PYTHON_CMD" >/dev/null 2>&1; then
    printf 'Python interpreter not found: %s\n' "$PYTHON_CMD" >&2
    exit 1
fi

printf 'Installing Web App dependencies with %s...\n' "$PYTHON_CMD"
"$PYTHON_CMD" -m pip install -r requirements.txt
printf 'Starting the Web App at http://127.0.0.1:5000\n'
exec "$PYTHON_CMD" app.py
