#!/usr/bin/env bash
# Dựng FFmpeg LGPL tĩnh cho macOS rồi chép vào vendor/ffmpeg/darwin-<arch> (qua fetch-ffmpeg.mjs --from).
# Chạy được với bash 3.2 có sẵn của macOS (mảng rỗng + set -u: dùng ${a[@]+"${a[@]}"}).
# Engine chỉ cần: đọc mọi định dạng audio/video (lấy tiếng) + ghi MP3 (libmp3lame, LGPL). Không --enable-gpl/nonfree,
# --disable-autodetect để không dính thư viện Homebrew: binary chỉ phụ thuộc /usr/lib và framework hệ thống.
# x64 dựng chéo được trên máy Apple Silicon (và ngược lại).
# Dùng: scripts/build-ffmpeg-mac.sh [arm64] [x64]   (mặc định cả hai)
set -euo pipefail

FFMPEG_VERSION=8.0.1
LAME_VERSION=3.100
MACOS_MIN=11.0

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$root/vendor/ffmpeg/.build"
mkdir -p "$work/src"
jobs="$(sysctl -n hw.ncpu)"
host_arch="$(uname -m)" # arm64 | x86_64

fetch() { # url file
  [ -f "$work/src/$2" ] && return
  curl -fsSL --retry 5 --retry-all-errors -o "$work/src/$2.part" "$1" # tải dở thì không để lại file hỏng
  mv "$work/src/$2.part" "$work/src/$2"
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz"
fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" "lame-$LAME_VERSION.tar.gz"

build() { # arm64 | x64
  local arch="$1" carch triple ffarch cross=() asm=()
  case "$arch" in
    arm64) carch=arm64; triple=arm-apple-darwin; ffarch=aarch64 ;;
    x64) carch=x86_64; triple=x86_64-apple-darwin; ffarch=x86_64; asm=(--disable-x86asm) ;; # chỉ giải mã audio, không cần nasm
    *) echo "arch không hỗ trợ: $arch" >&2; exit 1 ;;
  esac
  local dir="$work/$arch" prefix="$work/$arch/prefix"
  local cc="clang -arch $carch -mmacosx-version-min=$MACOS_MIN"
  rm -rf "$dir" && mkdir -p "$prefix"
  [ "$carch" = "$host_arch" ] || cross=(--host="$triple")

  tar -xzf "$work/src/lame-$LAME_VERSION.tar.gz" -C "$dir"
  (cd "$dir/lame-$LAME_VERSION" &&
    ./configure ${cross[@]+"${cross[@]}"} CC="$cc" --prefix="$prefix" --enable-static --disable-shared \
      --disable-frontend --disable-decoder --disable-dependency-tracking >/dev/null &&
    make -j"$jobs" >/dev/null && make install >/dev/null)

  [ "$carch" = "$host_arch" ] && cross=() || cross=(--enable-cross-compile)
  tar -xJf "$work/src/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$dir"
  (cd "$dir/ffmpeg-$FFMPEG_VERSION" &&
    ./configure --prefix="$prefix" --target-os=darwin --arch="$ffarch" ${cross[@]+"${cross[@]}"} ${asm[@]+"${asm[@]}"} \
      --cc="$cc" --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" \
      --enable-static --disable-shared --disable-autodetect --enable-zlib --enable-bzlib --enable-libmp3lame \
      --disable-doc --disable-ffplay --disable-ffprobe --disable-network --disable-indevs --disable-outdevs \
      --disable-encoders --enable-encoder=libmp3lame,pcm_s16le,pcm_f32le \
      --disable-muxers --enable-muxer=mp3,wav,pcm_f32le >/dev/null &&
    make -j"$jobs" >/dev/null)

  local bin="$dir/ffmpeg-$FFMPEG_VERSION/ffmpeg"
  if "$bin" -hide_banner -buildconf 2>/dev/null | grep -qE -- '--enable-(gpl|nonfree)'; then
    echo "[ffmpeg] $arch: không phải bản LGPL" >&2; exit 1
  fi
  if otool -L "$bin" | tail -n +2 | grep -vqE '^\s+(/usr/lib/|/System/Library/)'; then
    otool -L "$bin" >&2; echo "[ffmpeg] $arch: phụ thuộc thư viện ngoài hệ thống" >&2; exit 1
  fi
  node "$root/scripts/fetch-ffmpeg.mjs" --platform darwin --arch "$arch" --from "$bin"
}

for a in "${@:-arm64 x64}"; do
  for x in $a; do build "$x"; done
done
