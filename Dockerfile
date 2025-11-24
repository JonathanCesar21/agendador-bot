# echo "=== OS ==="
if [ -f /etc/os-release ]; then cat /etc/os-release; else echo "sem /etc/os-release"; fi
echo
echo "=== Kernel ==="
uname -a
echo
echo "=== Shell atual ==="
echo "pid=$$"
echo "argv0=\c"; echo "$0"
echo "SHELL=$SHELL"
echo -n "proc/$$/exe -> "; readlink /proc/$$/exe 2>/dev/null || echo "n/a"
echo -n "ps comm      -> "; ps -p $$ -o comm= 2>/dev/null || echo "n/a"
echo
echo "=== PATH ==="
echo "$PATH"
echo
echo "=== Node/NPM ==="
node -v 2>/dev/null || echo "node n/a"
npm -v  2>/dev/null || echo "npm n/a"
echo
echo "=== Chromium detect ==="
command -v chromium chromium-browser google-chrome google-chrome-stable 2>/dev/null || true
for B in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v "$B" >/dev/null 2>&1; then
    echo -n "$B -> "; "$B" --version 2>/dev/null || echo "installed (no --version)"
  fi
done
echo
echo "=== CHROME_PATH env ==="
echo "CHROME_PATH=${CHROME_PATH:-<vazio>}"
if [ -n "$CHROME_PATH" ] && [ -x "$CHROME_PATH" ]; then ls -l "$CHROME_PATH"; else echo "arquivo alvo não é executável ou não definido"; fi
echo
echo "=== APT chromium policy (se Ubuntu/Debian) ==="
apt-cache policy chromium chromium-browser 2>/dev/null || echo "apt-cache n/a"=== OS ===
# PRETTY_NAME="Ubuntu 22.04.5 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.5 LTS (Jammy Jellyfish)"
VERSION_CODENAME=jammy
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=jammy
# 
# === Kernel ===
# Linux e865f3f43664 6.8.0-71-generic #71-Ubuntu SMP PREEMPT_DYNAMIC Tue Jul 22 16:52:38 UTC 2025 x86_64 x86_64 x86_64 GNU/Linux
# 
# === Shell atual ===
# pid=1602
# argv0=/bin/sh
# SHELL=
# proc/1602/exe -> /usr/bin/dash
# ps comm      -> sh
# 
# === PATH ===
# /nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:/bin:/sbin:/usr/bin:/usr/sbin
# 
# === Node/NPM ===
# 
v18.20.5
# 10.8.2
# 
# === Chromium detect ===
# # > > > > # 
# === CHROME_PATH env ===
# CHROME_PATH=<vazio>
# arquivo alvo não é executável ou não definido
# 
# === APT chromium policy (se Ubuntu/Debian) ===