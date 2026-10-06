// Runtime Python cho bản cài đặt (spec mục 8 / Phase 6): lần chạy đầu tự tải uv → uv cài Python (python-build-standalone)
// → tạo venv → cài torch đúng bản (CUDA / MPS / CPU) → cài thư viện engine. Tất cả nằm trong <thư mục dữ liệu>/runtime,
// người dùng không phải tự cài Python hay CUDA toolkit. App cập nhật mà danh sách thư viện đổi → chỉ cài bù phần đổi.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UV_VERSION = '0.8.22';
export const PYTHON_VERSION = '3.11';

export type TorchFlavor = 'cuda' | 'mps' | 'cpu';
export type RuntimeStep = 'uv' | 'python' | 'venv' | 'torch' | 'packages' | 'done';

export interface RuntimeProgress {
  step: RuntimeStep;
  index: number; // 1..5
  total: number;
  /** 0..1 trong bước hiện tại nếu biết (tải uv), không thì null. */
  fraction: number | null;
  line: string; // dòng log gần nhất
}

export interface RuntimeDirs {
  root: string;
  uvDir: string;
  venv: string;
  python: string;
  cache: string;
  pythons: string;
  marker: string;
}

export function runtimeDirs(dataDir: string, platform = process.platform): RuntimeDirs {
  const root = path.join(dataDir, 'runtime');
  const venv = path.join(root, 'venv');
  return {
    root, venv,
    uvDir: path.join(root, 'uv'),
    python: platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'),
    cache: path.join(root, 'cache'),
    pythons: path.join(root, 'python'),
    marker: path.join(root, 'runtime.json'),
  };
}

/** Thư mục dữ liệu giống engine (paths.py): %APPDATA%/EasyVoice, ~/Library/Application Support/EasyVoice. */
export function dataDir(appData: string): string {
  return process.env.EASYVOICE_DATA_DIR ?? path.join(appData, 'EasyVoice');
}

export function uvAsset(platform: string, arch: string): string {
  const map: Record<string, string> = {
    'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
    'win32-arm64': 'uv-aarch64-pc-windows-msvc.zip',
    'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
    'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
    'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz', // chỉ để phát triển / CI (spec: Linux ngoài phạm vi v1)
    'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
  };
  const a = map[`${platform}-${arch}`];
  if (!a) throw new Error(`nền tảng chưa hỗ trợ: ${platform}-${arch}`);
  return a;
}

export const uvUrl = (asset: string) => `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;

/** Windows có GPU NVIDIA (nvidia-smi chạy được) → torch CUDA; Mac Apple Silicon → bản mặc định (MPS); còn lại CPU. */
export function detectTorch(platform = process.platform, arch = process.arch): TorchFlavor {
  if (process.env.EASYVOICE_TORCH === 'cuda' || process.env.EASYVOICE_TORCH === 'mps' || process.env.EASYVOICE_TORCH === 'cpu') {
    return process.env.EASYVOICE_TORCH;
  }
  if (platform === 'darwin') return arch === 'arm64' ? 'mps' : 'cpu';
  if (platform === 'win32') {
    const r = spawnSync('nvidia-smi', ['-L'], { windowsHide: true, timeout: 8000 });
    return r.status === 0 && String(r.stdout).includes('GPU') ? 'cuda' : 'cpu';
  }
  return 'cpu';
}

export function requirementFiles(engineDir: string, torch: TorchFlavor) {
  const req = path.join(engineDir, 'requirements');
  return { torch: path.join(req, `${torch}.txt`), packages: process.env.EASYVOICE_RUNTIME_REQS ?? path.join(req, 'runtime.txt') };
}

/** Dấu vân tay của danh sách thư viện: đổi (app cập nhật) thì cài lại. */
export function requirementsHash(engineDir: string, torch: TorchFlavor): string {
  const f = requirementFiles(engineDir, torch);
  const h = createHash('sha256');
  for (const p of [f.torch, f.packages]) h.update(existsSync(p) ? readFileSync(p) : Buffer.from(p));
  return `${torch}:${h.digest('hex').slice(0, 16)}`;
}

export function runtimeReady(dirs: RuntimeDirs, engineDir: string, torch: TorchFlavor): boolean {
  if (!existsSync(dirs.python) || !existsSync(dirs.marker)) return false;
  try {
    return JSON.parse(readFileSync(dirs.marker, 'utf8')).requirements === requirementsHash(engineDir, torch);
  } catch {
    return false;
  }
}

function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

type Fetcher = (url: string) => Promise<Response>;

async function download(url: string, dest: string, fetcher: Fetcher, onFraction: (f: number) => void) {
  const res = await fetcher(url);
  if (!res.ok || !res.body) throw new Error(`tải ${url} lỗi HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => {
    got += c.length;
    if (total) onFraction(got / total);
  });
  await pipeline(body, createWriteStream(dest));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine: (l: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, windowsHide: true, signal });
    let tail = '';
    const feed = (d: Buffer) => {
      for (const l of d.toString().split(/\r?\n|\r/)) {
        const s = l.trim();
        if (s) {
          onLine(s);
          tail = (tail + '\n' + s).slice(-1500);
        }
      }
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args[0]} lỗi (mã ${code}):\n${tail.trim()}`))));
  });
}

/**
 * Cài (hoặc cài bù) runtime. Trả đường dẫn python của venv. Bước đã xong được bỏ qua: chạy lại sau khi rớt mạng
 * sẽ tiếp tục (uv giữ cache gói đã tải trong runtime/cache).
 */
export async function ensureRuntime(engineDir: string, dirs: RuntimeDirs, torch: TorchFlavor,
  onProgress: (p: RuntimeProgress) => void, opts: { fetcher?: Fetcher; signal?: AbortSignal } = {}): Promise<string> {
  const total = 5;
  const emit = (step: RuntimeStep, index: number, line: string, fraction: number | null = null) =>
    onProgress({ step, index, total, fraction, line });
  mkdirSync(dirs.root, { recursive: true });
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
  let uv = existsSync(dirs.uvDir) ? findFile(dirs.uvDir, exe) : null;
  if (!uv) {
    const asset = uvAsset(process.platform, process.arch);
    emit('uv', 1, `uv ${UV_VERSION}`, 0);
    mkdirSync(dirs.uvDir, { recursive: true });
    const archive = path.join(dirs.root, asset);
    await download(uvUrl(asset), archive, opts.fetcher ?? fetch, (f) => emit('uv', 1, `uv ${UV_VERSION}`, f));
    // tar có sẵn trên macOS và Windows 10+ (bsdtar đọc được cả .zip)
    await run('tar', ['-xf', archive, '-C', dirs.uvDir], process.env, (l) => emit('uv', 1, l));
    rmSync(archive, { force: true });
    uv = findFile(dirs.uvDir, exe);
    if (!uv) throw new Error('không tìm thấy uv sau khi giải nén');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UV_CACHE_DIR: dirs.cache,
    UV_PYTHON_INSTALL_DIR: dirs.pythons,
    UV_PYTHON_PREFERENCE: 'only-managed', // luôn dùng Python của app, không lẫn Python có sẵn trên máy
    UV_LINK_MODE: 'copy',
    UV_NO_PROGRESS: '1',
  };
  const step = (s: RuntimeStep, i: number) => (l: string) => emit(s, i, l);
  emit('python', 2, `Python ${PYTHON_VERSION}`);
  await run(uv, ['python', 'install', PYTHON_VERSION], env, step('python', 2), opts.signal);
  if (!existsSync(dirs.python)) {
    emit('venv', 3, dirs.venv);
    await run(uv, ['venv', '--python', PYTHON_VERSION, dirs.venv], env, step('venv', 3), opts.signal);
  }
  const req = requirementFiles(engineDir, torch);
  emit('torch', 4, `PyTorch (${torch})`);
  await run(uv, ['pip', 'install', '--python', dirs.python, '-r', req.torch], env, step('torch', 4), opts.signal);
  emit('packages', 5, 'EasyVoice engine');
  await run(uv, ['pip', 'install', '--python', dirs.python, '-r', req.packages], env, step('packages', 5), opts.signal);
  writeFileSync(dirs.marker, JSON.stringify({
    requirements: requirementsHash(engineDir, torch), torch, uv: UV_VERSION, python: PYTHON_VERSION,
    installedAt: new Date().toISOString(),
  }, null, 2));
  emit('done', 5, 'OK', 1);
  return dirs.python;
}

/** Dung lượng ước tính cần tải (hiển thị trước khi cài). */
export const estimateGb = (torch: TorchFlavor) => (torch === 'cuda' ? 4.5 : torch === 'mps' ? 1.6 : 1.4);

export function folderSizeGb(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += statSync(p).size;
    }
  };
  walk(dir);
  return n / 1e9;
}
