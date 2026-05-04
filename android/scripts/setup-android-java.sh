#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${JAVA_HOME:-}" ]] && command -v brew >/dev/null 2>&1; then
  if brew --prefix openjdk@21 >/dev/null 2>&1; then
    export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
  fi
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "JAVA_HOME is not set. Install JDK 21 or export JAVA_HOME before building Android."
  return 1 2>/dev/null || exit 1
fi

export PATH="$JAVA_HOME/bin:$PATH"
