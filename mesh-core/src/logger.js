/**
 * MESH Worker — Structured Logger
 * Provides consistent JSON logging with trace correlation (requestId).
 */

class Logger {
  #requestId = null;

  constructor(requestId = null) {
    this.#requestId = requestId;
  }

  /**
   * Returns a new logger instance bound to a specific request ID.
   */
  child(requestId) {
    return new Logger(requestId || this.#requestId);
  }

  #log(level, message, context = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      requestId: this.#requestId,
      ...context,
    };
    console.log(JSON.stringify(entry));
  }

  info(message, context) {
    this.#log('INFO', message, context);
  }

  warn(message, context) {
    this.#log('WARN', message, context);
  }

  error(message, context) {
    this.#log('ERROR', message, context);
  }

  debug(message, context) {
    if (process.env.DEBUG) {
      this.#log('DEBUG', message, context);
    }
  }
}

// Default singleton logger for startup/global logs
export const logger = new Logger();
export default logger;
