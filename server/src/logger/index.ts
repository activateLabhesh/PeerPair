export const logger = {
  info: (...args: unknown[]) => {
    console.info(...args);
  },
  error: (...args: unknown[]) => {
    console.error(...args);
  }
};
