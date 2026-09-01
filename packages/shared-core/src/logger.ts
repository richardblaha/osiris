/** Minimal leveled logger with a scope prefix, shared by extensions and apps. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogSink {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface Logger extends LogSink {
  readonly scope: string;
  readonly level: LogLevel;
  child(scope: string): Logger;
  setLevel(level: LogLevel): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
}

const consoleSink: LogSink = {
  debug: (m, ...a) => console.error(m, ...a),
  info: (m, ...a) => console.error(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  let level: LogLevel = options.level ?? 'info';
  const sink = options.sink ?? consoleSink;

  const enabled = (target: Exclude<LogLevel, 'silent'>): boolean =>
    level !== 'silent' && LEVEL_ORDER[target] >= LEVEL_ORDER[level as Exclude<LogLevel, 'silent'>];

  const prefix = `[osiris:${scope}]`;

  return {
    scope,
    get level() {
      return level;
    },
    setLevel(next) {
      level = next;
    },
    debug: (message, ...args) => enabled('debug') && sink.debug(`${prefix} ${message}`, ...args),
    info: (message, ...args) => enabled('info') && sink.info(`${prefix} ${message}`, ...args),
    warn: (message, ...args) => enabled('warn') && sink.warn(`${prefix} ${message}`, ...args),
    error: (message, ...args) => enabled('error') && sink.error(`${prefix} ${message}`, ...args),
    child: (childScope) => createLogger(`${scope}:${childScope}`, { level, sink }),
  };
}
