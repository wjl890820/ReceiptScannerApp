/**
 * 最小日志入口，便于后续统一挂接上报或替换输出。
 * 当前仅封装 console，扫描链路关键失败点经此入口。
 */

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, tag: string, message: string, data?: unknown) {
  const prefix = `[${tag}]`;
  if (data !== undefined) {
    (console as any)[level](prefix, message, data);
  } else {
    (console as any)[level](prefix, message);
  }
}

export const logger = {
  info(tag: string, message: string, data?: unknown) {
    log('info', tag, message, data);
  },
  warn(tag: string, message: string, data?: unknown) {
    log('warn', tag, message, data);
  },
  error(tag: string, message: string, data?: unknown) {
    log('error', tag, message, data);
  },
};
