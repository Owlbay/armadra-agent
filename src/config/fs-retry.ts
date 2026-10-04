/**
 * Windows 上的暂时性文件错误（多个 ama 进程同时读写 auth.json 时）。
 *
 * NTFS 上文件被删除后、最后一个句柄关闭前处于「删除挂起」：此时 `open(wx)` 报 EPERM 而不是 EEXIST；
 * 目标文件正被别的进程读时 `rename` 覆盖它会报 EPERM / EACCES / EBUSY。这些都是瞬时的，稍等重试即可。
 * 其它平台上同样的错误码是真的权限问题，原样抛出。
 */

const TRANSIENT_WIN32 = new Set(["EPERM", "EACCES", "EBUSY"]);

/** 这个错误码在当前平台上是不是「别的进程正占着，稍后再试」。 */
export function isTransientFsError(code: unknown, platform: string = process.platform): boolean {
  return platform === "win32" && typeof code === "string" && TRANSIENT_WIN32.has(code);
}

/** 同步睡眠（只用在重试之间，最长几十毫秒）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface FsRetryOptions {
  platform?: string;
  attempts?: number;
  /** 第 n 次重试前等 `delayMs * n`。 */
  delayMs?: number;
  sleep?: (ms: number) => void;
}

/** 执行 `fn`；Windows 的暂时性错误按递增间隔重试（缺省 8 次，共约 0.7 s），其它错误立即抛出。 */
export function retryTransientFs<T>(fn: () => T, options: FsRetryOptions = {}): T {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 20;
  const sleep = options.sleep ?? sleepSync;
  for (let n = 1; ; n++) {
    try {
      return fn();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (n >= attempts || !isTransientFsError(code, options.platform)) throw error;
      sleep(delayMs * n);
    }
  }
}
