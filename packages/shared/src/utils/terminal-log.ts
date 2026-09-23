/**
 * 终端日志文件名工具
 * 用于自动记录功能：根据终端名称和打开时间生成日志文件路径
 */

/** 文件名非法字符（Windows 保留字符） */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/**
 * 清理终端名称中的非法文件名字符
 * @param name 终端名称（如标签页名称）
 * @returns 可安全用作文件名的字符串，空名回退为 terminal
 */
export function sanitizeLogName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_CHARS, '-')
    // 控制字符（0x00-0x1F）不允许出现在文件名中，直接剔除
    .split('')
    .filter((ch) => ch.charCodeAt(0) > 31)
    .join('')
    .trim();
  return cleaned || 'terminal';
}

/**
 * 格式化打开时间为 YYYYMMDD_HHmmss（本地时间）
 */
export function formatLogTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * 生成日志文件名：终端名_打开时间.log
 */
export function buildLogFileName(name: string, openedAt: Date): string {
  return `${sanitizeLogName(name)}_${formatLogTimestamp(openedAt)}.log`;
}

/**
 * 生成日志文件完整路径（统一以 / 分隔，Windows 兼容）
 * @param dir 日志文件夹（自动去除尾部斜杠）
 */
export function buildLogFilePath(dir: string, name: string, openedAt: Date): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return `${trimmed}/${buildLogFileName(name, openedAt)}`;
}

/**
 * 格式化日志行时间戳（本地时间）：[HH:mm:ss.SSS]
 */
export function formatLogTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `[${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.` +
    `${String(date.getMilliseconds()).padStart(3, '0')}]`
  );
}

/** 无换行的日志积压上限，超过后强制结算为一行 */
const LOG_BUFFER_LIMIT = 8192;

/**
 * 从流式日志分片中按行提取并加时间戳前缀（跨分片行缓冲）。
 *
 * 日志数据按任意边界分片到达，不保证按行对齐：完整行（以 \n 结束）加
 * `[HH:mm:ss.SSS]` 前缀返回，行内回车符剔除；不完整的尾行留在 rest 中
 * 等待后续分片。积压超过上限时强制结算，避免缓冲无限增长。
 */
export function extractLogLines(
  buffer: string,
  chunk: string,
  date: Date
): { lines: string[]; rest: string } {
  const stamp = formatLogTimestamp(date);
  let pending = buffer + chunk;
  const lines: string[] = [];
  let idx: number;
  while ((idx = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, idx).replace(/\r/g, '');
    pending = pending.slice(idx + 1);
    lines.push(`${stamp}${line}\n`);
  }
  if (pending.length > LOG_BUFFER_LIMIT) {
    lines.push(`${stamp}${pending.replace(/\r/g, '')}\n`);
    pending = '';
  }
  return { lines, rest: pending };
}
