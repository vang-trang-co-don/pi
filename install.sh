#!/bin/sh
set -eu

# Pi Installer for vang-trang-co-don/pi
# Downloads pre-compiled binary from GitHub Releases and links to ~/.local/bin/pi

REPO="vang-trang-co-don/pi"
CMD="pi"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.pi-bundle}"
BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM_OS="linux" ;;
  Darwin*) PLATFORM_OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM_OS="windows" ;;
  *)
    printf "Error: Unsupported operating system: %s\n" "$OS" >&2
    exit 1
    ;;
esac

# Detect Architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) PLATFORM_ARCH="x64" ;;
  arm64|aarch64) PLATFORM_ARCH="arm64" ;;
  *)
    printf "Error: Unsupported architecture: %s\n" "$ARCH" >&2
    exit 1
    ;;
esac

PLATFORM="${PLATFORM_OS}-${PLATFORM_ARCH}"
printf "\033[1;36m==>\033[0m Detected platform: \033[1m%s\033[0m\n" "$PLATFORM"

# Determine archive name
if [ "$PLATFORM_OS" = "windows" ]; then
  ARCHIVE_NAME="pi-${PLATFORM}.zip"
else
  ARCHIVE_NAME="pi-${PLATFORM}.tar.gz"
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ARCHIVE_NAME}"

printf "\033[1;36m==>\033[0m Downloading %s from GitHub Releases...\n" "$ARCHIVE_NAME"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

DOWNLOADED=0
if command -v curl >/dev/null 2>&1; then
  if curl -fL --progress-bar -o "$TMP_DIR/$ARCHIVE_NAME" "$DOWNLOAD_URL"; then
    DOWNLOADED=1
  fi
elif command -v wget >/dev/null 2>&1; then
  if wget -q --show-progress -O "$TMP_DIR/$ARCHIVE_NAME" "$DOWNLOAD_URL"; then
    DOWNLOADED=1
  fi
else
  printf "Error: curl or wget is required to download Pi.\n" >&2
  exit 1
fi

if [ "$DOWNLOADED" -eq 0 ]; then
  printf "\033[1;33mWarning:\033[0m Could not download binary release from GitHub.\n"
  printf "Checking if git and node are available to build from source...\n"
  if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    printf "==> Building from source repository...\n"
    SRC_DIR="$HOME/.pi-source"
    if [ -d "$SRC_DIR/.git" ]; then
      (cd "$SRC_DIR" && git fetch origin main && git reset --hard origin/main)
    else
      git clone "https://github.com/${REPO}.git" "$SRC_DIR"
    fi
    (cd "$SRC_DIR" && npm ci --ignore-scripts && npm run build)
    mkdir -p "$BIN_DIR"
    cat << EOF > "$BIN_DIR/$CMD"
#!/bin/sh
exec node "$SRC_DIR/packages/coding-agent/dist/cli.js" "\$@"
EOF
    chmod +x "$BIN_DIR/$CMD"
    if [ -d "$HOME/.pi/agent/bin" ]; then
      ln -sf "$BIN_DIR/$CMD" "$HOME/.pi/agent/bin/$CMD"
    fi
    printf "\n\033[1;32m✓ Pi installed successfully from source!\033[0m\n"
    printf "Run it with: \033[1;36m%s\033[0m\n\n" "$CMD"
    exit 0
  else
    printf "Error: Failed to download release asset and build tools (git/node/npm) are not found.\n" >&2
    exit 1
  fi
fi

printf "\033[1;36m==>\033[0m Installing to %s...\n" "$INSTALL_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

if [ "$PLATFORM_OS" = "windows" ]; then
  unzip -q "$TMP_DIR/$ARCHIVE_NAME" -d "$INSTALL_DIR"
else
  tar -xzf "$TMP_DIR/$ARCHIVE_NAME" -C "$TMP_DIR"
  if [ -d "$TMP_DIR/pi" ]; then
    cp -r "$TMP_DIR/pi/"* "$INSTALL_DIR/"
  else
    cp -r "$TMP_DIR/"* "$INSTALL_DIR/"
  fi
fi

mkdir -p "$BIN_DIR"
TARGET_EXE="$INSTALL_DIR/pi"
if [ "$PLATFORM_OS" = "windows" ]; then
  TARGET_EXE="$INSTALL_DIR/pi.exe"
fi

chmod +x "$TARGET_EXE"
ln -sf "$TARGET_EXE" "$BIN_DIR/$CMD"

# Also update ~/.pi/agent/bin/pi if present
if [ -d "$HOME/.pi/agent/bin" ]; then
  ln -sf "$TARGET_EXE" "$HOME/.pi/agent/bin/$CMD"
fi

printf "\n\033[1;32m✓ Pi installed successfully!\033[0m\n"

# Verify path
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf "\n\033[1;33mNote:\033[0m %s is not in your PATH.\n" "$BIN_DIR"
    printf "Add it to your shell configuration (e.g. ~/.bashrc or ~/.zshrc):\n\n"
    printf "  export PATH=\"%s:\$PATH\"\n\n" "$BIN_DIR"
    ;;
esac

printf "Run it with: \033[1;36m%s\033[0m\n\n" "$CMD"
