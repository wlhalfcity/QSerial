import { describe, it, expect } from 'vitest';
import {
  sanitizeLogName,
  formatLogTimestamp,
  buildLogFileName,
  buildLogFilePath,
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
