#!/usr/bin/env bash
# Пускане на локалния админ панел (WSL/Linux/macOS)
cd "$(dirname "$0")" && exec node admin.mjs "$@"
