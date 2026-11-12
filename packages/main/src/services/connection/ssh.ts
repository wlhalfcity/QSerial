/**
 * SSH 连接实现
 */

import { Client, ClientChannel } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ConnectionType,
  ConnectionState,
  type IConnection,
  type SshConnectionOptions,
} from '@qserial/shared';
import { EventEmitter } from 'events';

// 默认密钥文件名列表（按优先级）
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa'];

/**
 * 获取用户默认 SSH 密钥列表
 */
function getDefaultPrivateKeys(): Buffer[] {
  const sshDir = path.join(os.homedir(), '.ssh');
  const keys: Buffer[] = [];

  for (const name of DEFAULT_KEY_NAMES) {
    const keyPath = path.join(sshDir, name);
    try {
      if (fs.existsSync(keyPath)) {
        keys.push(fs.readFileSync(keyPath));
      }
    } catch {
      // 读取失败跳过
    }
  }

  return keys;
}

/**
 * 算法配置预设
 * - full: 完整算法列表，优先兼容新设备
 * - legacy: 仅使用最保守的算法，兼容旧设备
 */
const ALGORITHM_PRESETS = {
  full: {
    kex: [
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group15-sha512',
      'diffie-hellman-group16-sha512',
      'diffie-hellman-group17-sha512',
      'diffie-hellman-group18-sha512',
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group-exchange-sha1',
      'diffie-hellman-group1-sha1',
    ],
    serverHostKey: [
      'ssh-rsa',
      'ssh-ed25519',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'ssh-dss',
    ],
    cipher: [
      'aes128-gcm@openssh.com',
      'aes256-gcm@openssh.com',
      'aes128-ctr',
      'aes192-ctr',
      'aes256-ctr',
      'aes128-cbc',
      'aes256-cbc',
      '3des-cbc',
    ],
    hmac: ['hmac-sha2-512', 'hmac-sha2-256', 'hmac-sha1', 'hmac-sha1-96'],
  },
  legacy: {
    kex: [
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group1-sha1',
      'diffie-hellman-group-exchange-sha1',
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
    ],
    serverHostKey: [
      // 只保留 ssh-rsa 和 ssh-dss，避免 rsa-sha2-* 签名不匹配
      'ssh-rsa',
      'ssh-dss',
    ],
    cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes256-cbc', '3des-cbc'],
    hmac: ['hmac-sha1', 'hmac-sha1-96', 'hmac-sha2-256', 'hmac-sha2-512'],
  },
};

export class SshConnection implements IConnection {
  private client: Client | null = null;
  private stream: ClientChannel | null = null;
  // 记住最近一次终端尺寸：shell 建立前的 resize 无法下发（stream 尚不存在），
  // 先暂存，建 shell 时带上，避免远端 pty 停留在默认 80x24 导致长命令换行错位
  private pendingCols = 80;
  private pendingRows = 24;
  private eventEmitter = new EventEmitter();
  private _state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;
  private isClosing = false;
  // 是否真正建立过一次 shell；首次连接失败（IP 不通/认证失败）不进入自动重连，
  // 否则用户界面已经关闭会话，后台仍会不断重试并往无监听者的事件发射器发 error
  private everConnected = false;

  readonly id: string;
  readonly type = ConnectionType.SSH;
  readonly options: SshConnectionOptions;

  constructor(options: SshConnectionOptions) {
    this.id = options.id;
    this.options = options;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async open(): Promise<void> {
    if (this.client) {
      throw new Error('Connection already open');
    }

    this.isClosing = false;
    this._state = ConnectionState.CONNECTING;
    this.emitStateChange();

    // 构建认证方式列表，按优先级尝试
    const defaultKeys = getDefaultPrivateKeys();

    // 收集所有可用的认证配置
    const authMethods: { privateKey?: Buffer; password?: string; passphrase?: string }[] = [];

    // 1. 用户指定的私钥（最高优先级）
    if (this.options.privateKey) {
      try {
        const keyPath = this.options.privateKey.replace(/^~/, os.homedir());
        const keyBuffer = fs.readFileSync(keyPath);
        authMethods.push({ privateKey: keyBuffer, passphrase: this.options.passphrase });
      } catch {
        // 读取失败跳过
      }
    }

    // 2. 用户指定的密码
    if (this.options.password) {
      authMethods.push({ password: this.options.password });
    }

    // 3. 默认密钥（最低优先级，仅在用户未提供任何认证时使用）
    if (!this.options.privateKey && !this.options.password) {
      for (const key of defaultKeys) {
        authMethods.push({ privateKey: key });
      }
    }

    if (authMethods.length === 0) {
      this._state = ConnectionState.ERROR;
      this.emitStateChange();
      throw new Error('未找到 SSH 密钥 (~/.ssh/id_*) 且未提供密码');
    }

    // 连接策略：先用完整算法列表，失败后回退到保守算法
    const algorithmPresets = ['full', 'legacy'] as const;
    let lastError: Error | null = null;

    for (const preset of algorithmPresets) {
      if (this.isClosing) break;
      for (const auth of authMethods) {
        // 用户已关闭/销毁连接时停止后续尝试，避免失败重试期间又新建 Client
        if (this.isClosing) break;
        try {
          await this.tryConnect(auth, ALGORITHM_PRESETS[preset]);
          return; // 连接成功
        } catch (err) {
          lastError = err as Error;
          const errMsg = lastError.message || '';

          // 签名验证失败时，立即切换到保守算法预设重试
          if (errMsg.includes('signature verification failed') && preset === 'full') {
            console.log(
              '[SSH] signature verification failed with full algorithms, retrying with legacy preset...'
            );
            break; // 跳出 authMethods 循环，进入 legacy preset
          }

          // 其他错误（如认证失败），继续尝试下一个认证方式
        }
      }

      // 仅在 legacy preset 仍签名验证失败时放弃，让 full→legacy 回退生效
      if (preset === 'legacy' && lastError?.message?.includes('signature verification failed')) {
        break;
      }
    }

    // 用户已关闭/销毁连接：保持 DISCONNECTED，不再改动状态，也不做自动重连
    if (this.isClosing) {
      throw lastError || new Error('Connection closed');
    }

    // 所有方式都失败
    if (this.reconnectCount > 0) {
      // 重连失败时保持 RECONNECTING 状态（handleReconnect 会继续调度）
      this._state = ConnectionState.RECONNECTING;
    } else {
      this._state = ConnectionState.ERROR;
    }
    this.emitStateChange();
    throw lastError || new Error('All configured authentication methods failed');
  }

  private async tryConnect(
    auth: { privateKey?: Buffer; password?: string; passphrase?: string },
    algorithms: typeof ALGORITHM_PRESETS.full
  ): Promise<void> {
    // Cleanup previous client（连带摘除监听并保留空 error 监听，防止迟到错误打崩主进程）
    this.closeClientSilently();
    this.stream = null;

    if (this.isClosing) {
      throw new Error('Connection closed');
    }

    // SSH Jump Host: connect to bastion first, then tunnel to target
    const jumpHost = this.options.jumpHost;
    let sock: import('stream').Duplex | undefined;
    let jumpClient: Client | undefined;

    if (jumpHost) {
      jumpClient = new Client();
      const jumpConfig: Record<string, unknown> = {
        host: jumpHost.host,
        port: jumpHost.port || 22,
        username: jumpHost.username,
        readyTimeout: 20000,
        keepaliveInterval: 30000,
        algorithms,
      };
      if (jumpHost.privateKey) {
        try {
          jumpConfig.privateKey = fs.readFileSync(jumpHost.privateKey.replace(/^~/, os.homedir()));
        } catch {
          /* ignore */
        }
      }
      if (jumpHost.password) {
        jumpConfig.password = jumpHost.password;
        jumpConfig.tryKeyboard = true;
      }

      await new Promise<void>((resolveJump, rejectJump) => {
        jumpClient!.on('ready', () => resolveJump());
        jumpClient!.on('error', (err) => rejectJump(err));
        jumpClient!.connect(jumpConfig);
      });

      sock = await new Promise<import('stream').Duplex>((resolveFwd, rejectFwd) => {
        jumpClient!.forwardOut(
          '127.0.0.1',
          0,
          this.options.host,
          this.options.port,
          (err, stream) => {
            if (err) return rejectFwd(err);
            resolveFwd(stream);
          }
        );
      });
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let settled = false;

      const cleanup = () => {
        // 不能只 removeAllListeners 后 end()：ssh2 在关闭过程中仍可能再 emit('error')，
        // 此时没有监听者会抛 ERR_UNHANDLED_ERROR 直接把主进程打崩（表现为整个软件闪退）
        // 仅当仍指向本次 client 时才清空，避免上一次尝试的迟到回调误伤新连接
        if (this.client === client) {
          this.client = null;
        }
        client.removeAllListeners();
        client.on('error', () => {});
        try {
          client.end();
        } catch {
          /* ignore */
        }
        this.stream = null;
        if (jumpClient) {
          try {
            jumpClient.end();
          } catch {
            /* ignore */
          }
        }
      };

      const onError = (err: Error) => {
        if (settled) {
          // 连接建立后发生的错误：交给上层提示，连接关闭由 client 'close' 事件统一处理
          if (!this.isClosing) this.emitError(err);
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      };

      const onHandshake = () => {
        // 握手完成前连接可能已被 cleanup/被新连接替换，此时不再建 shell
        if (this.client !== client || this.isClosing) return;
        // 使用渲染进程上报的最新终端尺寸（握手期间 resize 会先暂存到 pending*）
        const shellOptions = {
          term: 'xterm-256color',
          cols: this.pendingCols,
          rows: this.pendingRows,
        };
        client.shell(shellOptions, (err, stream) => {
          if (err) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
            return;
          }
          if (settled) {
            try {
              stream.close();
            } catch {
              /* ignore */
            }
            return;
          }

          this.stream = stream;

          stream.on('data', (data: Buffer) => {
            this.eventEmitter.emit('data', data);
          });

          // ClientChannel 的 'error' 没有监听者时会抛未捕获异常；连接中断时非常常见
          stream.on('error', (streamErr: Error) => {
            if (this.isClosing) return;
            this.emitError(streamErr);
          });

          stream.on('close', () => {
            if (this.isClosing) return;
            this._state = ConnectionState.DISCONNECTED;
            this.emitStateChange();
            this.eventEmitter.emit('close');
            this.closeClientSilently();
            this.handleReconnect();
          });

          stream.stderr.on('data', (data: Buffer) => {
            this.eventEmitter.emit('data', data);
          });
          stream.stderr.on('error', () => {
            /* stderr 流异常不影响会话，忽略 */
          });

          this._state = ConnectionState.CONNECTED;
          this.reconnectCount = 0;
          this.everConnected = true;
          settled = true;
          this.emitStateChange();
          resolve();
        });
      };

      client.on('ready', onHandshake);
      client.on('error', onError);

      client.on('close', () => {
        if (this.isClosing || this.client !== client) return;
        this._state = ConnectionState.DISCONNECTED;
        this.emitStateChange();
        this.eventEmitter.emit('close');
        this.handleReconnect();
      });

      const config: Record<string, unknown> = sock
        ? {
            sock,
            username: this.options.username,
            readyTimeout: 20000,
            keepaliveInterval: this.options.keepaliveInterval || 30000,
            algorithms,
          }
        : {
            host: this.options.host,
            port: this.options.port,
            username: this.options.username,
            readyTimeout: 20000,
            keepaliveInterval: this.options.keepaliveInterval || 30000,
            algorithms,
            debug: (msg: string) => {
              console.log('[SSH]', msg);
            },
          };

      if (auth.privateKey) {
        config.privateKey = auth.privateKey;
        if (auth.passphrase) config.passphrase = auth.passphrase;
      }
      if (auth.password) {
        config.password = auth.password;
        config.tryKeyboard = true;
      }
      if (this.options.verifyHostKey === false) {
        config.hostVerifier = () => true;
      }

      client.connect(config);
    });
  }

  async close(): Promise<void> {
    this.isClosing = true;
    this.cancelReconnect();
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      stream.removeAllListeners();
      stream.on('error', () => {});
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    }
    this.closeClientSilently();
    this._state = ConnectionState.DISCONNECTED;
    this.emitStateChange();
  }

  destroy(): void {
    this.isClosing = true;
    this.cancelReconnect();
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      stream.removeAllListeners();
      stream.on('error', () => {});
    }
    this.closeClientSilently();
    this._state = ConnectionState.DISCONNECTED;
    this.eventEmitter.removeAllListeners();
  }

  /**
   * 关闭 ssh2 Client，并保留一个空 error 监听。
   * ssh2 关闭过程中仍会 emit('error')，无监听者时 Node 会抛未捕获异常导致应用退出。
   */
  private closeClientSilently(): void {
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeAllListeners();
    client.on('error', () => {});
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }

  /**
   * 只在有监听者时 emit error。连接销毁后（渲染进程已移除监听）迟到的错误
   * 若直接 emit('error') 会抛 ERR_UNHANDLED_ERROR，打崩主进程。
   */
  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.eventEmitter.listenerCount('error') > 0) {
      this.eventEmitter.emit('error', error);
    } else {
      console.warn('[ssh] connection error (no listener):', error.message);
    }
  }

  write(data: Buffer | string): void {
    const stream = this.stream;
    if (!stream || stream.destroyed || stream.writableEnded) return;
    // 将字符串转换为 Buffer，使用 UTF-8 编码以支持中文
    const bufferData = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    try {
      stream.write(bufferData);
    } catch (err) {
      this.emitError(err);
    }
  }

  writeHex(hex: string): void {
    this.write(Buffer.from(hex, 'hex'));
  }

  set(_options: { brk?: boolean; dtr?: boolean; rts?: boolean }): void {
    // SSH does not support DTR/RTS/break control
  }

  resize(cols: number, rows: number): void {
    // stream 就绪前先暂存（shell 建立时会用）；就绪后立即下发 window-change
    this.pendingCols = cols;
    this.pendingRows = rows;
    const stream = this.stream;
    if (!stream || stream.destroyed) return;
    try {
      stream.setWindow(rows, cols, 480, 640);
    } catch {
      /* 通道已关闭时忽略 */
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
    // 从未成功连接过（IP 不通、认证失败）时不做自动重连：
    // 界面上的会话已经关闭，后台重试只会不断失败并可能向已销毁的连接发错误
    if (!this.options.autoReconnect || this.isClosing || !this.everConnected) {
      this.client = null;
      this.stream = null;
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
      this.client = null;
      this.stream = null;
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
