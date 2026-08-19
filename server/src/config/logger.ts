export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  userId?: string;
  accountId?: string;
  service?: string;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export class Logger {
  private minLevel: LogLevel;
  private serviceName: string;

  constructor(minLevel: LogLevel = 'info', serviceName: string = 'mallick-backend') {
    this.minLevel = minLevel;
    this.serviceName = serviceName;
  }

  public setLevel(level: LogLevel) {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private formatEntry(level: LogLevel, message: string, context?: LogContext, error?: Error): string {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service: this.serviceName,
      message,
      ...(context || {}),
      ...(error ? {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      } : {})
    };

    return JSON.stringify(entry);
  }

  public debug(message: string, context?: LogContext) {
    if (this.shouldLog('debug')) {
      console.debug(this.formatEntry('debug', message, context));
    }
  }

  public info(message: string, context?: LogContext) {
    if (this.shouldLog('info')) {
      console.info(this.formatEntry('info', message, context));
    }
  }

  public warn(message: string, context?: LogContext, error?: Error) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatEntry('warn', message, context, error));
    }
  }

  public error(message: string, context?: LogContext, error?: Error) {
    if (this.shouldLog('error')) {
      console.error(this.formatEntry('error', message, context, error));
    }
  }
}

export const logger = new Logger(
  (process.env.LOG_LEVEL as LogLevel) || 'info',
  process.env.APP_NAME || 'mallick-exchange-backend'
);
