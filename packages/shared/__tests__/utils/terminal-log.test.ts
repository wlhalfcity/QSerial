import { describe, it, expect } from 'vitest';
import {
  sanitizeLogName,
  formatLogTimestamp,
  buildLogFileName,
  buildLogFilePath,
  extractLogLines,
} from '../../src/utils/terminal-log.js';

describe('sanitizeLogName', () => {
  it('保留合法字符', () => {
    expect(sanitizeLogName('串口 /dev/ttyUSB0')).toBe('串口 -dev-ttyUSB0');
  });

  it('替换 Windows 非法字符', () => {
    expect(sanitizeLogName('a\\b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i');
  });

  it('剔除控制字符', () => {
    expect(sanitizeLogName('a\u0000b\u001fc')).toBe('abc');
  });

  it('去除首尾空白', () => {
    expect(sanitizeLogName('  COM3  ')).toBe('COM3');
  });

  it('空名回退为 terminal', () => {
    expect(sanitizeLogName('')).toBe('terminal');
    expect(sanitizeLogName('   ')).toBe('terminal');
  });
});

describe('formatLogTimestamp', () => {
  it('按本地时间格式化为 YYYYMMDD_HHmmss', () => {
    // 用本地时间构造，验证各字段补零
    const d = new Date(2026, 8, 22, 17, 5, 3); // 2026-09-22 17:05:03 本地时间
    expect(formatLogTimestamp(d)).toBe('20260922_170503');
  });

  it('单位数月份与日期补零', () => {
    const d = new Date(2026, 0, 5, 3, 4, 5); // 2026-01-05 03:04:05
    expect(formatLogTimestamp(d)).toBe('20260105_030405');
  });
});

describe('buildLogFileName', () => {
  it('生成 终端名_时间.log', () => {
    const d = new Date(2026, 8, 22, 17, 15, 30);
    expect(buildLogFileName('COM3', d)).toBe('COM3_20260922_171530.log');
  });

  it('终端名中的非法字符被替换', () => {
    const d = new Date(2026, 8, 22, 17, 15, 30);
    expect(buildLogFileName('ssh:root@192.168.1.1', d)).toBe(
      'ssh-root@192.168.1.1_20260922_171530.log'
    );
  });
});

describe('buildLogFilePath', () => {
  const d = new Date(2026, 8, 22, 17, 15, 30);

  it('拼接目录与文件名', () => {
    expect(buildLogFilePath('/home/user/logs', 'COM3', d)).toBe(
      '/home/user/logs/COM3_20260922_171530.log'
    );
  });

  it('去除目录尾部斜杠', () => {
    expect(buildLogFilePath('/home/user/logs/', 'COM3', d)).toBe(
      '/home/user/logs/COM3_20260922_171530.log'
    );
    expect(buildLogFilePath('/home/user/logs\\', 'COM3', d)).toBe(
      '/home/user/logs/COM3_20260922_171530.log'
    );
  });

  it('兼容 Windows 盘符路径', () => {
    expect(buildLogFilePath('D:\\qserial-logs', 'COM3', d)).toBe(
      'D:\\qserial-logs/COM3_20260922_171530.log'
    );
  });
});

describe('formatLogTimestamp', () => {
  it('输出 [HH:mm:ss.SSS] 本地时间，毫秒补零', () => {
    expect(formatLogTimestamp(new Date(2026, 8, 22, 9, 5, 3, 7))).toBe('[09:05:03.007]');
    expect(formatLogTimestamp(new Date(2026, 8, 22, 23, 59, 59, 999))).toBe('[23:59:59.999]');
  });
});

describe('extractLogLines', () => {
  const t = new Date(2026, 8, 23, 10, 15, 32, 123);
  const STAMP = '[10:15:32.123]';

  it('完整行加时间戳前缀并剔除回车符', () => {
    const { lines, rest } = extractLogLines('', 'AT+CMGF=1\r\nOK\r\n', t);
    expect(lines).toEqual([`${STAMP}AT+CMGF=1\n`, `${STAMP}OK\n`]);
    expect(rest).toBe('');
  });

  it('半行跨分片缓冲，续片后结算', () => {
    const first = extractLogLines('', 'RSSI=-', t);
    expect(first.lines).toEqual([]);
    expect(first.rest).toBe('RSSI=-');

    const second = extractLogLines(first.rest, '75 dBm\r\n', t);
    expect(second.lines).toEqual([`${STAMP}RSSI=-75 dBm\n`]);
    expect(second.rest).toBe('');
  });

  it('一分片含多行与尾半行', () => {
    const { lines, rest } = extractLogLines('', 'a\nb\nc', t);
    expect(lines).toEqual([`${STAMP}a\n`, `${STAMP}b\n`]);
    expect(rest).toBe('c');
  });

  it('行内回车符（进度条刷新）被剔除', () => {
    const { lines } = extractLogLines('', '10%\r20%\r100%\n', t);
    expect(lines).toEqual([`${STAMP}10%20%100%\n`]);
  });

  it('超过上限的无换行积压强制结算', () => {
    const big = 'x'.repeat(9000);
    const { lines, rest } = extractLogLines('', big, t);
    expect(lines).toEqual([`${STAMP}${big}\n`]);
    expect(rest).toBe('');
  });
});
