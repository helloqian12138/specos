export function createLogger(verbose: boolean) {
  return {
    step(label: string, message: string) {
      console.log(`[${label}] ${message}`);
    },
    warn(message: string) {
      if (verbose) {
        console.warn(`warning: ${message}`);
      }
    },
    debug(enabled: boolean, label: string, payload: string) {
      if (!enabled) {
        return;
      }

      console.log(`\n[debug] ${label}\n${payload}\n`);
    }
  };
}
