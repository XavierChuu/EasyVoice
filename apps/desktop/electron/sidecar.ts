// Vòng đời Python sidecar (spec mục 4): port động, token ngẫu nhiên, health check, tự khởi động lại khi crash.
// Engine chưa có (Phase 1) → nếu không tìm thấy engine hoặc EASYVOICE_MOCK=1 thì chạy chế độ mock.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

export type EngineStatus = 'starting' | 'online' | 'restarting' | 'offline' | 'mock';

export interface EngineInfo {
  status: EngineStatus;
  port?: number;
  token?: string;
  restarts: number;
  lastError?: string;
}

const HEALTH_TIMEOUT_MS = 15_000; // spec mục 5: backend sẵn sàng ≤ 15 s
const MAX_RESTARTS = 5;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

export class Sidecar {
  private proc: ChildProcess | null = null;
  private stopping = false;
  info: EngineInfo = { status: 'starting', restarts: 0 };

  constructor(
    private readonly engineDir: string,
    private readonly python: string,
    private readonly onChange: (info: EngineInfo) => void,
  ) {}

  static locate(appRoot: string): { engineDir: string; python: string } | null {
    if (process.env.EASYVOICE_MOCK === '1') return null;
    const engineDir = process.env.EASYVOICE_ENGINE_DIR ?? path.resolve(appRoot, '../../engine');
    if (!existsSync(path.join(engineDir, 'easyvoice_engine', 'main.py'))) return null;
    const venvPy = process.platform === 'win32'
      ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : path.join(engineDir, '.venv', 'bin', 'python');
    const python = process.env.EASYVOICE_PYTHON ?? (existsSync(venvPy) ? venvPy : null);
    return python ? { engineDir, python } : null;
  }

  private set(patch: Partial<EngineInfo>) {
    this.info = { ...this.info, ...patch };
    this.onChange(this.info);
  }

  async start(): Promise<void> {
    const port = await freePort();
    const token = randomBytes(24).toString('hex');
    this.set({ status: this.info.restarts ? 'restarting' : 'starting', port, token });
    const proc = spawn(this.python, ['-m', 'easyvoice_engine.main', '--port', String(port)], {
      cwd: this.engineDir,
      env: { ...process.env, EASYVOICE_TOKEN: token, PYTHONUNBUFFERED: '1' }, // token qua env, không lộ trên argv
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stderr?.on('data', (d: Buffer) => this.set({ lastError: d.toString().slice(-500) }));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      if (this.info.restarts >= MAX_RESTARTS) {
        this.set({ status: 'offline', lastError: `engine exited (${code}), restart limit reached` });
        return;
      }
      this.set({ status: 'restarting', restarts: this.info.restarts + 1 });
      setTimeout(() => void this.start(), 1000);
    });
    await this.waitHealthy(port, token);
  }

  private async waitHealthy(port: number, token: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline && this.proc) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/system/health`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return this.set({ status: 'online' });
      } catch {
        /* chưa lên */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (this.proc) this.set({ status: 'offline', lastError: 'health check timeout' });
  }

  async restart(): Promise<void> {
    this.stopping = true;
    this.kill();
    this.stopping = false;
    this.set({ restarts: 0 });
    await this.start();
  }

  /** Tắt app thì không được để sót process Python (nghiệm thu Phase 2). */
  kill(): void {
    if (!this.proc) return;
    const pid = this.proc.pid;
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      this.proc.kill('SIGTERM');
    }
    this.proc = null;
  }

  stop(): void {
    this.stopping = true;
    this.kill();
  }
}
