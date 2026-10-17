/**
 * A background loop: `step` runs again at once while it reports work done, otherwise after `intervalMs`. Errors are
 * logged and the loop goes on. `stop` waits for the step in progress.
 */
export function startLoop(name: string, intervalMs: number, step: () => Promise<boolean>) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const tick = () => {
    current = (async () => {
      let more = true;
      while (more && !stopped) {
        try {
          more = await step();
        } catch (err) {
          console.error(`${name} failed`, err);
          more = false;
        }
      }
    })().finally(() => {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  tick();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
