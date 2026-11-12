/**
 * Telnet 连接实现
 */

import * as net from 'net';
import {
  ConnectionType,
  ConnectionState,
  type IConnection,
  type TelnetConnectionOptions,
} from '@qserial/shared';
import { EventEmitter } from 'events';

// Telnet 协议命令
const IAC = 0xff; // Interpret As Command
const DONT = 0xfe;
const DO = 0xfd;
const WONT = 0xfc;
const WILL = 0xfb;
const SB = 0xfa;
const SE = 0xf0;
const NAWS = 31; // Negotiate About Window Size（RFC 1073）

export class TelnetConnection implements IConnection {
  private socket: net.Socket | null = null;
  private eventEmitter = new EventEmitter();
  private _state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;
  private isClosing = false;
  // 是否成功连接过；首次连接失败（IP 不通/超时）不自动重连
  private everConnected = false;
  // 终端尺寸：渲染进程上报，NAWS 协商完成后 / 尺寸变化时发给服务端
  private termCols: number | null = null;
  private termRows: number | null = null;
  // 服务端已回复 DO NAWS，可以发送子协商
  private nawsEnabled = false;
  // 跨 TCP 包残留的不完整 IAC 序列
  private parseBuffer: Buffer = Buffer.alloc(0);

  readonly id: string;
  readonly type = ConnectionType.TELNET;
  readonly options: TelnetConnectionOptions;

  constructor(options: TelnetConnectionOptions) {
    this.id = options.id;
    this.options = options;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async open(): Promise<void> {
    if (this.socket) {
      throw new Error('Connection already open');
    }

    this.isClosing = false;
    this._state = ConnectionState.CONNECTING;
    this.emitStateChange();

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      let settled = false;

      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Connection timed out'));
        this.destroy();
      }, this.options.timeout || 15000);

      socket.connect(this.options.port, this.options.host, () => {
        clearTimeout(connectTimeout);
        this._state = ConnectionState.CONNECTED;
        this.reconnectCount = 0;
        this.everConnected = true;
        this.nawsEnabled = false;
        this.parseBuffer = Buffer.alloc(0);
        // 主动提出 NAWS（窗口尺寸协商），服务端回 DO NAWS 后即可下发尺寸
        this.socket?.write(Buffer.from([IAC, WILL, NAWS]));
        this.emitStateChange();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.on('data', (data: Buffer) => {
        if (this.isClosing || this.socket !== socket) return;
        const cleaned = this.handleTelnetCommands(data);
        if (cleaned.length > 0) {
          this.eventEmitter.emit('data', cleaned);
        }
      });

      socket.on('error', (err: Error) => {
        clearTimeout(connectTimeout);
        // 已销毁/已关闭的连接收到迟到错误时直接忽略：
        // 此时渲染进程监听已移除，emit('error') 会抛未捕获异常打崩主进程
        if (this.isClosing || this.socket !== socket) return;
        const wasConnecting = !settled || this._state === ConnectionState.CONNECTING;
        // 重连期间失败保持 RECONNECTING 状态
        if (this.reconnectCount === 0) {
          this._state = ConnectionState.ERROR;
          this.emitStateChange();
        }
        this.emitError(err);
        if (wasConnecting) {
          settled = true;
          // 首次连接失败：彻底丢弃 socket，避免再次 open() 报 "Connection already open"
          if (!this.everConnected) {
            this.socket = null;
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
          }
          reject(err);
        }
      });

      socket.on('close', () => {
        clearTimeout(connectTimeout);
        if (this.isClosing || this.socket !== socket) return;
        this._state = ConnectionState.DISCONNECTED;
        this.emitStateChange();
        this.eventEmitter.emit('close');
        this.handleReconnect();
      });
    });
  }

  /**
   * 处理 Telnet 协议协商命令
   * 除 NAWS（窗口尺寸）外，其余选项一律拒绝。
   * IAC 序列可能被 TCP 拆分到多个包，未完成的部分暂存到 parseBuffer。
   */
  private handleTelnetCommands(chunk: Buffer): Buffer {
    const data = this.parseBuffer.length ? Buffer.concat([this.parseBuffer, chunk]) : chunk;
    this.parseBuffer = Buffer.alloc(0);

    const dataOnly: number[] = [];
    const replies: number[] = [];
    let i = 0;

    for (; i < data.length; i++) {
      const byte = data[i];
      if (byte !== IAC) {
        dataOnly.push(byte);
        continue;
      }
      // 不完整的 IAC，留到下一包
      if (i + 1 >= data.length) break;

      const cmd = data[i + 1];
      if (cmd === IAC) {
        // 转义的 0xFF
        dataOnly.push(IAC);
        i += 1;
        continue;
      }
      if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
        if (i + 2 >= data.length) break;
        const opt = data[i + 2];
        if (cmd === DO) {
          if (opt === NAWS) {
            // 对端同意窗口尺寸协商，立即回报当前尺寸
            this.nawsEnabled = true;
            replies.push(IAC, WILL, NAWS);
            this.appendNawsSize(replies);
          } else {
            replies.push(IAC, WONT, opt);
          }
        } else if (cmd === WILL) {
          replies.push(IAC, DONT, opt);
        }
        // DONT / WONT：对端拒绝或停止某选项，无需回应
        i += 2;
        continue;
      }
      if (cmd === SB) {
        // 子协商（IAC SB ... IAC SE）：整体丢弃，不能把内容当普通数据写进终端
        let j = i + 2;
        let end = -1;
        while (j + 1 < data.length) {
          if (data[j] === IAC && data[j + 1] === SE) {
            end = j;
            break;
          }
          j++;
        }
        if (end === -1) break; // 子协商未结束，留到下一包
        i = end + 1;
        continue;
      }
      // 其余单字节命令（NOP/DM/BRK 等）忽略
      i += 1;
    }

    if (i < data.length) {
      this.parseBuffer = Buffer.from(data.subarray(i));
      // 防御：异常流导致子协商迟迟不结束时不无限缓存，避免终端卡死
      if (this.parseBuffer.length > 8192) {
        this.parseBuffer = Buffer.alloc(0);
      }
    }
    if (replies.length > 0) {
      this.socket?.write(Buffer.from(replies));
    }

    return Buffer.from(dataOnly);
  }

  /**
   * 追加 NAWS 子协商：IAC SB NAWS <cols 2B> <rows 2B> IAC SE
   * 数据中的 0xFF 按协议转义为 IAC IAC。
   */
  private appendNawsSize(out: number[]): void {
    if (!this.termCols || !this.termRows) return;
    const cols = Math.min(0xffff, Math.max(1, Math.floor(this.termCols)));
    const rows = Math.min(0xffff, Math.max(1, Math.floor(this.termRows)));
    out.push(IAC, SB, NAWS);
    for (const b of [(cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff]) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    out.push(IAC, SE);
  }

  async close(): Promise<void> {
    this.isClosing = true;
    this.cancelReconnect();
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      socket.removeAllListeners();
      socket.on('error', () => {});
      try {
        socket.end();
      } catch {
        /* ignore */
      }
    }
    this._state = ConnectionState.DISCONNECTED;
    this.emitStateChange();
  }

  destroy(): void {
    this.isClosing = true;
    this.cancelReconnect();
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      socket.removeAllListeners();
      socket.on('error', () => {});
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this._state = ConnectionState.DISCONNECTED;
    this.eventEmitter.removeAllListeners();
  }

  /**
   * 只在有监听者时 emit error。会话销毁后迟到的网络错误若直接 emit('error')，
   * 会抛 ERR_UNHANDLED_ERROR 导致主进程退出（表现为整个软件闪退）。
   */
  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.eventEmitter.listenerCount('error') > 0) {
      this.eventEmitter.emit('error', error);
    } else {
      console.warn('[telnet] connection error (no listener):', error.message);
    }
  }

  write(data: Buffer | string): void {
    if (this.socket) {
      // 将字符串转换为 Buffer，使用 UTF-8 编码以支持中文
      const bufferData = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
      this.socket.write(bufferData);
    }
  }

  writeHex(hex: string): void {
    this.write(Buffer.from(hex, 'hex'));
  }

  set(_options: { brk?: boolean; dtr?: boolean; rts?: boolean }): void {
    // Telnet does not support DTR/RTS/break control
  }

  resize(cols: number, rows: number): void {
    // 记录尺寸；NAWS 协商完成后通过子协商告知服务端（服务端据此设置 pty 大小）
    this.termCols = cols;
    this.termRows = rows;
    if (!this.nawsEnabled || !this.socket) return;
    const out: number[] = [];
    this.appendNawsSize(out);
    if (out.length > 0) {
      this.socket.write(Buffer.from(out));
    }
  }

  onData(callback: (data: Buffer) => void): () => void {
    this.eventEmitter.on('data', callback);
    return () => this.eventEmitter.off('data', callback);
  }

  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.eventEmitter.on('stateChange', callback);
    return () => this.eventEmitter.off('stateChange', callback);
  }

  onError(callback: (error: Error) => void): () => void {
    this.eventEmitter.on('error', callback);
    return () => this.eventEmitter.off('error', callback);
  }

  onClose(callback: (code?: number) => void): () => void {
    this.eventEmitter.on('close', callback);
    return () => this.eventEmitter.off('close', callback);
  }

  private emitStateChange(): void {
    this.eventEmitter.emit('stateChange', this._state);
  }

  private handleReconnect(): void {
    // 从未成功连接过（IP 不通、端口拒绝）时不做自动重连：界面上的会话已关闭，
    // 后台重试只会不断失败，还会向已销毁的连接发错误
    if (!this.options.autoReconnect || this.isClosing || !this.everConnected) {
      this.socket = null;
      if (this.isClosing) {
        this._state = ConnectionState.DISCONNECTED;
        this.emitStateChange();
      }
      return;
    }

    const maxAttempts = this.options.reconnectAttempts || 5;
    const interval = this.options.reconnectInterval || 3000;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.reconnectCount >= maxAttempts) {
      this._state = ConnectionState.DISCONNECTED;
      this.emitStateChange();
      this.emitError(new Error(`重连失败，已达最大重试次数 (${maxAttempts})`));
      return;
    }

    this._state = ConnectionState.RECONNECTING;
    this.emitStateChange();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectCount++;
      this.socket = null;
      this.open().catch(() => {
        this.handleReconnect();
      });
    }, interval);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectCount = 0;
  }
}
