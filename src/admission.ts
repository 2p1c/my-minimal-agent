// 进程内准入：限制同时在跑的 Agent，以及可以短暂排队的请求数。
// Node 是单线程，这里限制的不是 CPU 线程，而是同时挂着的异步任务
// （一次任务会占着一条 HTTP 连接、一段对话内存、以及上游模型的一个请求）。

export class SaturatedError extends Error {
  constructor() {
    super("too many concurrent agent runs");
    this.name = "SaturatedError";
  }
}

type Waiter = {
  grant: (release: () => void) => void;
  signal?: AbortSignal;
  onAbort: () => void;
};

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

export class AdmissionGate {
  private active = 0;
  private waiters: Waiter[] = [];

  constructor(
    readonly maxInflight: number,
    readonly maxWaiting: number,
  ) {
    if (!Number.isInteger(maxInflight) || maxInflight < 1) {
      throw new Error("maxInflight must be an integer >= 1");
    }
    if (!Number.isInteger(maxWaiting) || maxWaiting < 0) {
      throw new Error("maxWaiting must be an integer >= 0");
    }
  }

  get inflightCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();

    // 有人在排队时不能插队，哪怕此刻刚好有空位（空位应由 release 交给队首）。
    if (this.active < this.maxInflight && this.waiters.length === 0) {
      this.active += 1;
      return this.releaser();
    }
    if (this.waiters.length >= this.maxWaiting) {
      throw new SaturatedError();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        signal,
        onAbort: () => {
          this.removeWaiter(waiter);
          reject(abortError());
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // 名额直接交给队首，active 不变。先摘掉 abort 监听，避免移交和取消各走一次。
        next.signal?.removeEventListener("abort", next.onAbort);
        next.grant(this.releaser());
        return;
      }
      this.active -= 1;
    };
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }
}
