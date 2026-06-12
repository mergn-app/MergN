#!/usr/bin/env bash
# One-line installer for MergN. Clones the repo to a fixed location and puts the
# `mergn` command on your PATH, so you can run `mergn run` / `mergn update` from
# anywhere.
#
#   curl -fsSL https://raw.githubusercontent.com/flowbaker/MergN/main/install.sh | bash
#
# Override the location with MERGN_DIR=/path before the pipe.
set -euo pipefail

REPO_URL="${MERGN_REPO:-https://github.com/flowbaker/MergN.git}"
DEST="${MERGN_DIR:-${HOME}/.mergn}"
BIN_DIR="${MERGN_BIN_DIR:-/usr/local/bin}"

ln_cmd() {
  if [ -w "${BIN_DIR}" ]; then ln -sf "$1" "$2"; else sudo ln -sf "$1" "$2"; fi
}

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

if [ -d "${DEST}/.git" ]; then
  echo "-> Updating existing MergN at ${DEST} ..."
  git -C "${DEST}" pull --ff-only
else
  echo "-> Cloning MergN into ${DEST} ..."
  git clone --depth 1 "${REPO_URL}" "${DEST}"
fi

chmod +x "${DEST}/mergn" "${DEST}/update.sh" 2>/dev/null || true
ln_cmd "${DEST}/mergn" "${BIN_DIR}/mergn"

echo "OK - 'mergn' is now on your PATH (${BIN_DIR}/mergn), repo at ${DEST}"
echo
echo "Next:"
echo "  mergn run        # start MergN (Docker: compose up; native: npm install first)"
echo "  mergn update     # update later, from anywhere"
echo "  mergn help       # all commands"
