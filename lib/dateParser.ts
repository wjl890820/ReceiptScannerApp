// lib/dateParser.ts

/**
 * 解析收据上的日期时间字符串
 * 支持多种格式：日本收据常见格式
 * - YYYY/MM/DD HH:MM
 * - YYYY-MM-DD HH:MM
 * - YYYY年MM月DD日 HH:MM
 * - MM/DD HH:MM (假设当前年份)
 * - 等等
 */

/**
 * 解析日期时间字符串为 epoch timestamp
 * @param dateTimeStr 日期时间字符串（可能包含各种格式）
 * @param fallbackToNow 如果解析失败，是否返回当前时间（默认false，返回null）
 * @returns epoch timestamp (number) 或 null
 */
export function parseReceiptDateTime(
  dateTimeStr: string | null | undefined,
  fallbackToNow: boolean = false
): number | null {
  if (!dateTimeStr || typeof dateTimeStr !== 'string') {
    return fallbackToNow ? Date.now() : null;
  }

  const trimmed = dateTimeStr.trim();
  if (!trimmed) {
    return fallbackToNow ? Date.now() : null;
  }

  // 尝试多种格式
  const patterns = [
    // YYYY/MM/DD HH:MM 或 YYYY/MM/DD HH:MM:SS
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/,
    // YYYY-MM-DD HH:MM 或 YYYY-MM-DD HH:MM:SS
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/,
    // YYYY年MM月DD日 HH:MM
    /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/,
    // MM/DD HH:MM (假设当前年份)
    /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/,
    // YYYY/MM/DD (只有日期，时间设为00:00)
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
    // YYYY-MM-DD (只有日期，时间设为00:00)
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      try {
        let year: number;
        let month: number;
        let day: number;
        let hour = 0;
        let minute = 0;
        let second = 0;

        if (pattern.source.includes('年')) {
          // YYYY年MM月DD日格式
          year = parseInt(match[1], 10);
          month = parseInt(match[2], 10);
          day = parseInt(match[3], 10);
          hour = parseInt(match[4] || '0', 10);
          minute = parseInt(match[5] || '0', 10);
          second = parseInt(match[6] || '0', 10);
        } else if (match.length === 4 || match.length === 5) {
          // MM/DD HH:MM 格式（没有年份）
          const now = new Date();
          year = now.getFullYear();
          month = parseInt(match[1], 10);
          day = parseInt(match[2], 10);
          hour = parseInt(match[3] || '0', 10);
          minute = parseInt(match[4] || '0', 10);
          second = parseInt(match[5] || '0', 10);
        } else if (match.length === 3) {
          // 只有日期 YYYY/MM/DD
          year = parseInt(match[1], 10);
          month = parseInt(match[2], 10);
          day = parseInt(match[3], 10);
        } else {
          // YYYY/MM/DD HH:MM 或 YYYY-MM-DD HH:MM
          year = parseInt(match[1], 10);
          month = parseInt(match[2], 10);
          day = parseInt(match[3], 10);
          hour = parseInt(match[4] || '0', 10);
          minute = parseInt(match[5] || '0', 10);
          second = parseInt(match[6] || '0', 10);
        }

        // 验证日期有效性
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          continue;
        }

        const date = new Date(year, month - 1, day, hour, minute, second);

        // 验证日期是否有效（例如不会出现2月30日）
        if (
          date.getFullYear() !== year ||
          date.getMonth() !== month - 1 ||
          date.getDate() !== day
        ) {
          continue;
        }

        // 检查日期是否在未来（超过当前时间+1天认为是无效的，可能是年份错误）
        const now = Date.now();
        const oneDayLater = now + 24 * 60 * 60 * 1000;
        if (date.getTime() > oneDayLater) {
          // 可能是年份错误，尝试减一年
          const prevYear = new Date(year - 1, month - 1, day, hour, minute, second);
          if (prevYear.getTime() <= oneDayLater) {
            return prevYear.getTime();
          }
          continue;
        }

        // 检查日期是否太旧（超过5年认为是无效的）
        const fiveYearsAgo = now - 5 * 365 * 24 * 60 * 60 * 1000;
        if (date.getTime() < fiveYearsAgo) {
          continue;
        }

        return date.getTime();
      } catch (e) {
        console.error('日期解析错误:', e, '输入:', trimmed);
        continue;
      }
    }
  }

  // 如果所有模式都失败，尝试使用原生Date解析
  try {
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      const now = Date.now();
      const oneDayLater = now + 24 * 60 * 60 * 1000;
      const fiveYearsAgo = now - 5 * 365 * 24 * 60 * 60 * 1000;
      const timestamp = parsed.getTime();

      // 验证日期在合理范围内
      if (timestamp >= fiveYearsAgo && timestamp <= oneDayLater) {
        return timestamp;
      }
    }
  } catch (e) {
    // ignore
  }

  return fallbackToNow ? Date.now() : null;
}
