const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  red: "\u001b[31m"
} as const;

export function createLogger(verbose: boolean) {
  return {
    step(label: string, message: string) {
      console.log(`${ANSI.cyan}[${label}]${ANSI.reset} ${message}`);
    },
    warn(message: string) {
      if (verbose) {
        console.warn(`${ANSI.yellow}warning:${ANSI.reset} ${message}`);
      }
    },
    debug(enabled: boolean, label: string, payload: string) {
      if (!enabled) {
        return;
      }

      console.log(`\n${ANSI.dim}[debug] ${label}${ANSI.reset}\n${payload}\n`);
    },
    error(message: string) {
      console.error(`${ANSI.red}${message}${ANSI.reset}`);
    }
  };
}
