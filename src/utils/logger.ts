export function createLogger(verbose: boolean) {
  return {
    step(label: string, message: string) {
      console.log(`[${label}] ${message}`);
    },
    warn(message: string) {
      if (verbose) {
        console.warn(`warning: ${message}`);
      }
    }
  };
}
