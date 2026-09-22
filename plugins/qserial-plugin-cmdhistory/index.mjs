/**
 * 命令历史插件
 * 记录用户在终端发送过的命令行（按回车切行），输入时由宿主聚合查询，
 * 渲染进程按 ↑ 用历史命令替换当前输入行。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

const PLUGIN_ID = 'qserial-plugin-cmdhistory';
const SAVE_DEBOUNCE_MS = 500;
const MAX_PENDING = 8192;
const MAX_SUGGESTIONS = 5;

function resolveDataDir() {
  return path.join(app.getPath('userData'), 'plugins-data', PLUGIN_ID);
}

export async function activate(ctx) {
  const dataDir = resolveDataDir();
  const historyFile = path.join(dataDir, 'history.json');

  const state = {
    /** 历史条目（旧 → 新）：{ text, connectionType, at } */
    history: [],
    /** 跨 write 分片的行缓冲（按 \r 切行） */
    pending: '',
    saveTimer: null,
    config: { maxHistory: 1000, minInputLength: 2, matchMode: 'prefix-first' },
  };

  // ── 配置 ──
  const readConfig = () => {
    try {
      const max = ctx.config.get('maxHistory');
      const min = ctx.config.get('minInputLength');
      const mode = ctx.config.get('matchMode');
      if (typeof max === 'number' && max >= 50) state.config.maxHistory = Math.floor(max);
      if (typeof min === 'number' && min >= 1) state.config.minInputLength = Math.floor(min);
      if (
        typeof mode === 'string' &&
        ['prefix-first', 'prefix', 'substring'].includes(mode)
      ) {
        state.config.matchMode = mode;
      }
    } catch (err) {
      ctx.log.warn(`读取配置失败，使用默认值: ${err?.message}`);
    }
  };
  readConfig();
  ctx.config.onChange(() => readConfig());

  // ── 持久化 ──
  const save = () => {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = `${historyFile}.tmp`;
        fs.writeFileSync(
          tmp,
          JSON.stringify({ version: 1, entries: state.history }),
          'utf-8'
        );
        fs.renameSync(tmp, historyFile);
      } catch (err) {
        ctx.log.warn(`保存历史失败: ${err?.message}`);
      }
    }, SAVE_DEBOUNCE_MS);
  };

  // 启动载入历史（首次启动或文件损坏时从空开始）
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    if (Array.isArray(parsed?.entries)) {
      state.history = parsed.entries.filter(
        (e) => e && typeof e.text === 'string' && e.text.length > 0
      );
    }
  } catch {
    /* ignore */
  }

  // 查询连接类型（供历史条目标记，建议排序时同类型优先）
  const typeOf = (connectionId) => {
    try {
      return ctx.connection.list().find((c) => c.id === connectionId)?.type || '';
    } catch {
      return '';
    }
  };

  // ── 订阅用户输入，按 \r 切行入史 ──
  ctx.terminal.onUserInput(({ connectionId, data }) => {
    state.pending += data;
    let idx;
    while ((idx = state.pending.indexOf('\r')) !== -1) {
      const line = state.pending.slice(0, idx).replace(/\n/g, '').trim();
      state.pending = state.pending.slice(idx + 1);
      if (line.length < state.config.minInputLength) continue;
      const last = state.history[state.history.length - 1];
      if (last && last.text === line) continue; // 相邻去重
      state.history.push({ text: line, connectionType: typeOf(connectionId), at: Date.now() });
    }
    // 防止无换行的超长输入撑爆缓冲
    if (state.pending.length > MAX_PENDING) state.pending = state.pending.slice(-1024);
    if (state.history.length > state.config.maxHistory) {
      state.history = state.history.slice(-state.config.maxHistory);
    }
    save();
  });

  // ── 建议提供者：前缀优先、子串兜底、同连接类型优先 ──
  ctx.terminal.registerSuggestionProvider(async (suggestionCtx) => {
    const { connectionType, currentLine } = suggestionCtx;
    const input = (currentLine || '').trim();
    if (input.length < state.config.minInputLength) return [];

    const lower = input.toLowerCase();
    const prefix = [];
    const substring = [];
    for (let i = state.history.length - 1; i >= 0; i--) {
      const entry = state.history[i];
      if (entry.text === input) continue;
      const pos = entry.text.toLowerCase().indexOf(lower);
      if (pos === 0) prefix.push(entry);
      else if (pos > 0 && state.config.matchMode !== 'prefix') substring.push(entry);
    }

    let matched =
      state.config.matchMode === 'substring' ? [...prefix, ...substring] : prefix;
    if (matched.length === 0 && state.config.matchMode === 'prefix-first') {
      matched = substring;
    }

    // 稳定排序：同连接类型优先，各自保持从新到旧
    const sameType = matched.filter((e) => e.connectionType === connectionType);
    const others = matched.filter((e) => e.connectionType !== connectionType);
    return [...sameType, ...others]
      .slice(0, MAX_SUGGESTIONS)
      .map((e) => ({ text: e.text, source: PLUGIN_ID }));
  });

  ctx.log.info('activated');
}

export function deactivate() {
  // 贡献（监听器/提供者）由宿主自动回收；落盘防抖定时器随进程生命周期结束即可
}
