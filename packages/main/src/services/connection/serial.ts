/**
 * 串口连接实现
 */

import type { SerialPort } from 'serialport';
import {
  ConnectionType,
  ConnectionState,
  type IConnection,
  type SerialConnectionOptions,
  type SerialPortInfo,
} from '@qserial/shared';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  autoFixSerialPermission,
  getPermissionErrorHint,
} from '../../utils/linux-serial-permissions.js';

// 惰性加载 serialport 原生模块，避免模块导入阶段触发 dlopen
// 当原生模块与 Electron ABI 不兼容时，Linux 回退机制需要在方法调用层面捕获错误
let _SerialPortClass: typeof SerialPort | null = null;
async function getSerialPort(): Promise<typeof SerialPort> {
  if (!_SerialPortClass) {
    _SerialPortClass = (await import('serialport')).SerialPort;
  }
  return _SerialPortClass;
}

export class SerialConnection implements IConnection {
  private port: SerialPort | null = null;
  private eventEmitter = new EventEmitter();
  private _state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;
  private isClosing = false;
  // 是否成功打开过串口；首次打开失败（设备不存在/权限不足）不自动重连
  private everConnected = false;
  private sharedConnection: IConnection | null = null;
  private dataUnsubscriber: (() => void) | null = null;
  // 渲染进程上报的最新终端尺寸（串口本身无尺寸通道，仅用于 syncTermSize 发送 stty）
  private termCols: number | null = null;
  private termRows: number | null = null;
  private syncSizeTimer: ReturnType<typeof setTimeout> | null = null;
  // 本次连接是否已下发过 stty（重连后重置）
  private termSizeSynced = false;
  // 尺寸变化后尚未重新同步
  private pendingSizeChange = false;
  // 最近一段远端输出（用于识别 shell 提示符，判断是否已登录完成）
  private outputTail = '';
  private atShellPrompt = false;
  // 本地已输入字符但尚未回车（远端行编辑器正在编辑这一行）
  private halfTypedInput = false;

  readonly id: string;
  readonly type = ConnectionType.SERIAL;
  readonly options: SerialConnectionOptions;

  constructor(options: SerialConnectionOptions) {
    this.id = options.id;
    this.options = options;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async open(): Promise<void> {
    if (this.port?.isOpen) {
      throw new Error('Connection already open');
    }
    if (this._state === ConnectionState.CONNECTED || this._state === ConnectionState.CONNECTING) {
      return;
    }

    this.isClosing = false;
    this.reconnectCount = 0;
    this._state = ConnectionState.CONNECTING;
    this.emitStateChange();

    try {
      const SerialPortClass = await getSerialPort();
      const createAndOpenPort = async () => {
        const port = new SerialPortClass({
          path: this.options.path,
          baudRate: this.options.baudRate,
          dataBits: this.options.dataBits,
          stopBits: this.options.stopBits,
          parity: this.options.parity,
          ...(this.options.flowControl ? { flowControl: this.options.flowControl } : {}),
          autoOpen: false,
        });

        // 先挂空 error 监听：serialport 是 Duplex，open 失败后若再 emit('error')
        // 而没有监听者会抛未捕获异常，直接打崩主进程
        port.on('error', () => {});

        await new Promise<void>((resolve, reject) => {
          port.open((err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        this.port = port;
      };

      try {
        await createAndOpenPort();
      } catch (error) {
        // Linux 权限自动修复：当设备打开失败且为权限错误时，尝试自动修复
        const errMsg = (error as Error).message || '';
        const isPermissionError =
          process.platform === 'linux' &&
          (errMsg.includes('Permission denied') ||
            errMsg.includes('EACCES') ||
            errMsg.includes('EPERM'));

        if (!isPermissionError) throw error;

        console.warn('[serial] Permission denied for', this.options.path, '- attempting auto-fix');

        const { fixed, permanentFixInstalled } = await autoFixSerialPermission(this.options.path);

        if (!fixed) {
          const hint = getPermissionErrorHint(this.options.path);
          throw new Error(`Permission denied, cannot open ${this.options.path}${hint}`);
        }

        // 权限已修复，重试打开
        console.log('[serial] Permission fixed, retrying open for', this.options.path);
        await createAndOpenPort();

        if (permanentFixInstalled) {
          console.log(
            '[serial] Permanent udev rules installed - future devices will work out of the box'
          );
        }
      }

      if (!this.port) throw new Error('Port not created');

      // 数据监听
      this.port.on('data', (data: Buffer) => {
        if (this.isClosing) return;
        this.updatePromptState(data);
        this.eventEmitter.emit('data', data);
      });

      // 错误监听
      this.port.on('error', (error: Error) => {
        // 关闭过程中迟到的错误直接忽略，避免发往已销毁的事件发射器
        if (this.isClosing) return;
        this._state = ConnectionState.ERROR;
        this.emitStateChange();
        this.emitError(error);
        this.handleReconnect();
      });

      // 关闭监听
      this.port.on('close', () => {
        if (this.isClosing) return;
        this._state = ConnectionState.DISCONNECTED;
        this.emitStateChange();
        this.eventEmitter.emit('close');
        this.handleReconnect();
      });

      this._state = ConnectionState.CONNECTED;
      this.reconnectCount = 0;
      this.everConnected = true;
      this.resetTermSizeSyncState();
      this.emitStateChange();
    } catch (error) {
      this._state = ConnectionState.ERROR;
      this.emitStateChange();
      this.emitError(error);
      throw error;
    }
  }

  /**
   * 串口是否可写（独占端口或共享连接）
   */
  private canWrite(): boolean {
    return !!this.port?.isOpen || !!this.sharedConnection;
  }

  /**
   * 重置本次连接的尺寸同步状态（打开/重连时调用）
   */
  private resetTermSizeSyncState(): void {
    if (this.syncSizeTimer) {
      clearTimeout(this.syncSizeTimer);
      this.syncSizeTimer = null;
    }
    this.termSizeSynced = false;
    this.pendingSizeChange = false;
    this.outputTail = '';
    this.atShellPrompt = false;
    this.halfTypedInput = false;
  }

  /**
   * 维护远端输出尾部，识别 shell 提示符。
   * 串口没有带外尺寸通道，只能等 shell 就绪后再发 stty——否则命令会被打进
   * login:/Password: 输入行，污染登录。
   */
  private updatePromptState(data: Buffer): void {
    this.outputTail = (this.outputTail + data.toString('latin1')).slice(-512);
    // eslint-disable-next-line no-control-regex
    const cleaned = this.outputTail.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[A-Za-z]|\x1b/g, '');
    const nl = Math.max(cleaned.lastIndexOf('\n'), cleaned.lastIndexOf('\r'));
    // 提示符必须是换行后的短行，且以 $ # % 结尾（bash/dash/busybox/zsh 常见形态）
    // 顺带排除了 "login: " / "Password: " 这类以冒号结尾的提示
    const line = nl >= 0 ? cleaned.slice(nl + 1).replace(/[ \t]+$/, '') : '';
    this.atShellPrompt = line.length > 0 && line.length <= 120 && /[#$%]$/.test(line);
    if (this.atShellPrompt) {
      this.maybeScheduleTermSizeSync();
    }
  }

  /**
   * 是否满足发送 stty 的条件：
   * - 开启了 syncTermSize、已知终端尺寸、连接可写
   * - 远端停在 shell 提示符（说明已登录完成）
   * - 本地没有正在编辑的行（避免把命令插进用户输入）
   */
  private shouldSyncTermSize(): boolean {
    if (!this.options.syncTermSize) return false;
    if (!this.termCols || !this.termRows) return false;
    if (this._state !== ConnectionState.CONNECTED || !this.canWrite()) return false;
    if (this.termSizeSynced && !this.pendingSizeChange) return false;
    return this.atShellPrompt && !this.halfTypedInput;
  }

  /**
   * 在确认远端 shell 空闲时发送 `stty cols/rows`。
   * 稍作去抖，避免提示符刚打印完还有后续输出；触发时再次校验条件，
   * 若期间用户开始输入则放弃，等下一次提示符再试。
   */
  private maybeScheduleTermSizeSync(): void {
    if (this.syncSizeTimer) {
      clearTimeout(this.syncSizeTimer);
      this.syncSizeTimer = null;
    }
    if (!this.shouldSyncTermSize()) return;

    this.syncSizeTimer = setTimeout(() => {
      this.syncSizeTimer = null;
      if (!this.shouldSyncTermSize()) return;
      this.termSizeSynced = true;
      this.pendingSizeChange = false;
      this.write(`stty cols ${this.termCols} rows ${this.termRows}\n`);
    }, 300);
  }

  /**
   * 使用共享连接打开（复用已有串口）
   */
  async openWithShared(sharedConnection: IConnection): Promise<void> {
    this.sharedConnection = sharedConnection;
    this._state = ConnectionState.CONNECTING;
    this.emitStateChange();

    try {
      // 监听共享连接的数据
      this.dataUnsubscriber = sharedConnection.onData((data) => {
        this.updatePromptState(data);
        this.eventEmitter.emit('data', data);
      });

      // 监听共享连接的状态变化
      sharedConnection.onStateChange((state) => {
        if (state === ConnectionState.DISCONNECTED || state === ConnectionState.ERROR) {
          this._state = state;
          this.emitStateChange();
          if (state === ConnectionState.ERROR) {
            this.emitError(new Error('Shared connection error'));
          }
        }
      });

      // 监听共享连接的错误
      sharedConnection.onError((err) => {
        this.emitError(err);
      });

      this._state = ConnectionState.CONNECTED;
      this.everConnected = true;
      this.resetTermSizeSyncState();
      this.emitStateChange();
    } catch (error) {
      this._state = ConnectionState.ERROR;
      this.emitStateChange();
      this.emitError(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.isClosing) return;
    this.isClosing = true;
    this.cancelReconnect();
    if (this.syncSizeTimer) {
      clearTimeout(this.syncSizeTimer);
      this.syncSizeTimer = null;
    }

    if (this.dataUnsubscriber) {
      this.dataUnsubscriber();
      this.dataUnsubscriber = null;
    }
    this.sharedConnection = null;

    const port = this.port;
    if (port) {
      this.port = null;
      if (port.isOpen) {
        await new Promise<void>((resolve) => {
          port.close(() => resolve());
        });
      }
      port.removeAllListeners();
      // 保留一个空 error 监听：serialport 是 Duplex，关闭后迟到的 error 无监听者会抛未捕获异常
      port.on('error', () => {});
    }
    this._state = ConnectionState.DISCONNECTED;
    this.emitStateChange();
  }
  destroy(): void {
    if (this.isClosing) return;
    this.isClosing = true;
    this.cancelReconnect();
    if (this.syncSizeTimer) {
      clearTimeout(this.syncSizeTimer);
      this.syncSizeTimer = null;
    }

    if (this.dataUnsubscriber) {
      this.dataUnsubscriber();
      this.dataUnsubscriber = null;
    }
    this.sharedConnection = null;

    const port = this.port;
    if (port) {
      this.port = null;
      port.removeAllListeners();
      port.on('error', () => {});
      if (port.isOpen) {
        port.close(() => {});
      }
    }
    this._state = ConnectionState.DISCONNECTED;
    this.eventEmitter.removeAllListeners();
  }

  /**
   * 只在有监听者时 emit error。会话销毁后迟到的设备错误若直接 emit('error')，
   * 会抛 ERR_UNHANDLED_ERROR 导致主进程退出（表现为整个软件闪退）。
   */
  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.eventEmitter.listenerCount('error') > 0) {
      this.eventEmitter.emit('error', error);
    } else {
      console.warn('[serial] connection error (no listener):', error.message);
    }
  }

  write(data: Buffer | string): void {
    // 将字符串转换为 Buffer，使用 UTF-8 编码以支持中文
    const bufferData = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

    this.trackLocalInput(bufferData);

    if (this.port?.isOpen) {
      this.port.write(bufferData);
    } else if (this.sharedConnection) {
      this.sharedConnection.write(bufferData);
    }
  }

  /**
   * 跟踪本地输入，判断远端行编辑器是否正在编辑一行。
   * 回车/换行 = 提交当前行；Ctrl+C / Ctrl+U = 清空当前行；其余按键视为编辑中。
   * 只有确认不在编辑时才会注入 stty，避免污染用户输入。
   */
  private trackLocalInput(data: Buffer): void {
    const text = data.toString('latin1');
    if (!text) return;
    const lastNl = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    if (lastNl >= 0) {
      this.halfTypedInput = text.slice(lastNl + 1).length > 0;
    } else if (text.includes('\x03') || text.includes('\x15')) {
      this.halfTypedInput = false;
    } else {
      this.halfTypedInput = true;
    }
  }

  writeHex(hex: string): void {
    this.write(Buffer.from(hex, 'hex'));
  }

  set(options: { brk?: boolean; dtr?: boolean; rts?: boolean }): void {
    if (this.port?.isOpen) {
      this.port.set(options);
    } else if (this.sharedConnection) {
      this.sharedConnection.set(options);
    }
  }

  resize(cols: number, rows: number): void {
    // 串口无法向硬件下发尺寸；记录下来供 syncTermSize 发送 stty 使用
    const changed = this.termCols !== cols || this.termRows !== rows;
    this.termCols = cols;
    this.termRows = rows;
    if (changed) {
      this.pendingSizeChange = true;
    }
    // 尺寸首次上报（连接时 open() 还拿不到）或发生变化时尝试下发；
    // 若此时还在登录/窗口调整中，会等下一次 shell 提示符出现再发
    if (changed || !this.termSizeSynced) {
      this.maybeScheduleTermSizeSync();
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
    // 首次打开就失败（端口不存在/权限不足）不做自动重连：界面会话已关闭
    if (!this.options.autoReconnect || this.isClosing || !this.everConnected) {
      this.port = null;
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
      this.port = null;
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

  /**
   * 获取可用串口列表（优先使用 serialport，失败时回退到 Linux 原生检测）
   */
  static async listPorts(): Promise<SerialPortInfo[]> {
    try {
      const SerialPortClass = await getSerialPort();
      const ports = await SerialPortClass.list();
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        pnpId: p.pnpId,
        locationId: p.locationId,
        productId: p.productId,
        vendorId: p.vendorId,
      }));
    } catch (err) {
      if (process.platform === 'linux') {
        console.warn(
          '[serial] SerialPort.list() failed, falling back to sysfs detection:',
          (err as Error).message?.slice(0, 80)
        );
        return SerialConnection.listPortsLinux();
      }
      throw err;
    }
  }

  /**
   * Linux 原生串口检测：直接读取 /sys/class/tty/ 和 /dev/serial/
   * 当 serialport 原生模块加载失败（如 ABI 不兼容）时作为回退方案
   */
  private static listPortsLinux(): SerialPortInfo[] {
    const ports: SerialPortInfo[] = [];
    const seen = new Set<string>();

    try {
      const ttyDir = '/sys/class/tty';
      if (!fs.existsSync(ttyDir)) return ports;

      for (const entry of fs.readdirSync(ttyDir)) {
        const devPath = path.join('/dev', entry);
        if (!fs.existsSync(devPath)) continue;
        if (seen.has(devPath)) continue;

        // 只收集真实硬件串口设备
        const isHardware =
          entry.startsWith('ttyUSB') ||
          entry.startsWith('ttyACM') ||
          entry.startsWith('ttyAMA') ||
          entry.startsWith('ttyS');

        if (!isHardware) continue;

        seen.add(devPath);

        const info: SerialPortInfo = { path: devPath };

        // 从 sysfs 读取 USB 设备信息
        try {
          const deviceLink = path.join(ttyDir, entry, 'device');
          if (fs.existsSync(deviceLink)) {
            const realDevPath = fs.realpathSync(deviceLink);
            // 不同驱动（FTDI/CH341/CDC-ACM）的 sysfs 层级不同，
            // 向上遍历直到找到包含 idVendor 的 USB 设备目录
            let searchDir = realDevPath;
            for (let level = 0; level < 6; level++) {
              if (fs.existsSync(path.join(searchDir, 'idVendor'))) {
                info.vendorId = fs.readFileSync(path.join(searchDir, 'idVendor'), 'utf-8').trim();
                try {
                  info.productId = fs
                    .readFileSync(path.join(searchDir, 'idProduct'), 'utf-8')
                    .trim();
                } catch {
                  /* 无 idProduct */
                }
                try {
                  info.manufacturer = fs
                    .readFileSync(path.join(searchDir, 'manufacturer'), 'utf-8')
                    .trim();
                } catch {
                  /* 无制造商信息 */
                }
                try {
                  info.serialNumber = fs
                    .readFileSync(path.join(searchDir, 'serial'), 'utf-8')
                    .trim();
                } catch {
                  /* 无序列号 */
                }
                break;
              }
              searchDir = path.resolve(searchDir, '..');
            }
          }
        } catch {
          /* sysfs 信息读取失败不影响基本功能 */
        }

        // 补充 /dev/serial/by-id/ 的信息
        try {
          const byIdDir = '/dev/serial/by-id';
          if (fs.existsSync(byIdDir)) {
            for (const linkName of fs.readdirSync(byIdDir)) {
              const linkTarget = fs.readlinkSync(path.join(byIdDir, linkName));
              if (linkTarget === `../../${entry}` || linkTarget.endsWith(`/${entry}`)) {
                if (!info.manufacturer) info.manufacturer = linkName;
                break;
              }
            }
          }
        } catch {
          /* by-id 读取失败不影响 */
        }

        ports.push(info);
      }
    } catch (err) {
      console.error('[serial] Linux fallback port detection failed:', (err as Error).message);
    }

    return ports;
  }
}
