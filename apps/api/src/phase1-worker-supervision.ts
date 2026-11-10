// Phase-1 test helper. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// A queue worker is an owned child. Cluster teardown waits for its close event.
import type { ChildProcess } from "node:child_process";

export interface SupervisedWorker {
  confirmedClosed(): boolean;
  output(): string;
  stop(): Promise<void>;
  until(pattern: RegExp, timeoutMs?: number): Promise<{ code: number | null; output: string }>;
}

/**
 * Waits until every worker's close event has been observed, then stops the cluster.
 * An uncertain close throws and does not call the cluster stop.
 */
export async function stopClusterAfterWorkers(
  workers: readonly SupervisedWorker[],
  stopCluster: () => Promise<void>,
): Promise<void> {
  for (const worker of workers) {
    await worker.stop();
    if (!worker.confirmedClosed()) {
      throw new Error("owned worker close unconfirmed; cluster retained");
    }
    process.stdout.write("owned-worker closed\n");
  }
  await stopCluster();
}

export function superviseFixtureWorker(
  child: ChildProcess,
  options: {
    closeWaitMs?: number;
    signal?: (child: ChildProcess) => void;
  } = {},
): SupervisedWorker {
  let output = "";
  let confirmed = false;
  let closeCode: number | null = null;
  const waiters: Array<() => void> = [];
  const closeWaitMs = options.closeWaitMs ?? 5_000;
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("close", (code) => {
    if (confirmed) return;
    confirmed = true;
    closeCode = code;
    for (const waiter of waiters.splice(0)) waiter();
  });

  const waitForClose = (limitMs: number) =>
    new Promise<boolean>((resolve) => {
      if (confirmed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), limitMs);
      waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const stop = async () => {
    if (confirmed) return;
    try {
      (options.signal ?? ((target) => target.kill("SIGTERM")))(child);
    } catch {
      // A failed signal is not a close. The wait below still has to observe one.
    }
    const exited = await waitForClose(closeWaitMs);
    if (!exited || !confirmed) {
      throw new Error("owned worker close unconfirmed; cluster retained");
    }
  };

  return {
    confirmedClosed: () => confirmed,
    output: () => output,
    stop,
    until: (pattern, timeoutMs = 40_000) =>
      new Promise((resolve, reject) => {
        let settled = false;
        let poll: ReturnType<typeof setInterval> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          settle();
        };
        const onClose = () => finish(() => resolve({ code: closeCode, output }));
        if (confirmed) {
          onClose();
          return;
        }
        waiters.push(onClose);
        timer = setTimeout(() => {
          finish(() => {
            void stop().then(
              () => reject(new Error("owned worker timed out")),
              (error: unknown) => reject(error),
            );
          });
        }, timeoutMs);
        poll = setInterval(() => {
          if (!pattern.test(output)) return;
          finish(() => resolve({ code: null, output }));
        }, 20);
      }),
  };
}
