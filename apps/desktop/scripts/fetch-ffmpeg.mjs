// Chuẩn bị FFmpeg đóng kèm bộ cài (electron-builder extraResources: vendor/ffmpeg/<platform>-<arch> → resources/ffmpeg).
// Chỉ dùng bản LGPL (không --enable-gpl / nonfree) để phân phối cùng app (spec: giấy phép bên thứ ba).
//   Windows: tải bản LGPL dựng sẵn của BtbN/FFmpeg-Builds.
//   macOS / khác: chép từ --from <đường dẫn ffmpeg> (tự dựng LGPL, ví dụ ./configure --disable-gpl --disable-nonfree).
// Dùng: node scripts/fetch-ffmpeg.mjs [--platform win32] [--arch x64] [--from /path/to/ffmpeg]
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
const from = arg('from');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'vendor', 'ffmpeg', `${platform}-${arch}`);
const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const WIN_BUILDS = {
  x64: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip',
  arm64: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-winarm64-lgpl.zip',
};

function find(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = find(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (from) {
  if (!existsSync(from)) throw new Error(`không thấy ${from}`);
  copyFileSync(from, path.join(out, exe));
  if (platform !== 'win32') chmodSync(path.join(out, exe), 0o755);
  console.log(`[ffmpeg] chép ${from} → ${out}. Hãy chắc đây là bản LGPL (ffmpeg -version không có --enable-gpl).`);
} else if (platform === 'win32' && WIN_BUILDS[arch]) {
  const tmp = path.join(root, 'vendor', 'ffmpeg', `.tmp-${arch}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'ffmpeg.zip');
  console.log(`[ffmpeg] tải ${WIN_BUILDS[arch]}`);
  const res = await fetch(WIN_BUILDS[arch]);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  try {
    execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'ignore' }); // bsdtar (Windows 10+, macOS) đọc được .zip
  } catch {
    execFileSync('unzip', ['-q', zip, '-d', tmp]); // GNU tar (Linux CI) thì không
  }
  for (const name of ['ffmpeg.exe', 'LICENSE.txt']) {
    const hit = find(tmp, name);
    if (hit) copyFileSync(hit, path.join(out, name));
  }
  rmSync(tmp, { recursive: true, force: true });
  if (!existsSync(path.join(out, exe))) throw new Error('không tìm thấy ffmpeg.exe trong gói tải về');
  console.log(`[ffmpeg] xong → ${out}`);
} else {
  console.warn(`[ffmpeg] ${platform}-${arch}: chưa có bản LGPL dựng sẵn. Truyền --from <ffmpeg LGPL>; bỏ qua thì app dùng FFmpeg trong PATH.`);
}
writeFileSync(path.join(out, 'README.txt'),
  'FFmpeg (LGPL v2.1+) — https://ffmpeg.org. EasyVoice gọi ffmpeg như một chương trình riêng để đọc audio/video;\n' +
  'mã nguồn: https://ffmpeg.org/download.html#get-sources (bản Windows: https://github.com/BtbN/FFmpeg-Builds).\n');
