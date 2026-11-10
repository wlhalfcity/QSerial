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
  private sharedConnection: IConnection | null = null;
  private dataUnsubscriber: (() => void) | null = null;
  // 渲染进程上报的最新终端尺寸（串口本身无尺寸通道，仅用于 syncTermSize 发送 stty）
  private termCols: number | null = null;
  private termRows: number | null = null;
  private syncSizeTimer: ReturnType<typeof setTimeout> | null = null;

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
        this.eventEmitter.emit('data', data);
      });

      // 错误监听
      this.port.on('error', (error: Error) => {
        this._state = ConnectionState.ERROR;
        this.emitStateChange();
        this.eventEmitter.emit('error', error);
        this.handleReconnect();
      });

      // 关闭监听
      this.port.on('close', () => {
        this._state = ConnectionState.DISCONNECTED;
        this.emitStateChange();
        this.eventEmitter.emit('close');
        this.handleReconnect();
      });

      this._state = ConnectionState.CONNECTED;
      this.reconnectCount = 0;
      this.emitStateChange();
      this.scheduleTermSizeSync();
    } catch (error) {
      this._state = ConnectionState.ERROR;
      this.emitStateChange();
      this.eventEmitter.emit('error', error);
      throw error;
    }
  }

  /**
   * syncTermSize 开启时，连接成功后延迟发送 `stty cols/rows`，
   * 让远端 shell 的行编辑器按本地终端宽度跟踪光标，避免长命令换行后
   * 提示符覆盖上一行。延迟是给远端 getty/login 留出就绪时间。
   */
  private scheduleTermSizeSync(): void {
    if (this.syncSizeTimer) {
      clearTimeout(this.syncSizeTimer);
      this.syncSizeTimer = null;
    }
    if (!this.options.syncTermSize || !this.termCols || !this.termRows) return;

    const cols = this.termCols;
    const rows = this.termRows;
    this.syncSizeTimer = setTimeout(() => {
      this.syncSizeTimer = null;
      if (this.port?.isOpen && this._state === ConnectionState.CONNECTED) {
        this.write(`stty cols ${cols} rows ${rows}\n`);
      }
    }, 800);
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
        this.eventEmitter.emit('data', data);
      });

      // 监听共享连接的状态变化
      sharedConnection.onStateChange((state) => {
        if (state === ConnectionState.DISCONNECTED || state === ConnectionState.ERROR) {
          this._state = state;
          this.emitStateChange();
          if (state === ConnectionState.ERROR) {
            this.eventEmitter.emit('error', new Error('Shared connection error'));
          }
        }
      });

      // 监听共享连接的错误
      sharedConnection.onError((err) => {
        this.eventEmitter.emit('error', err);
      });

      this._state = ConnectionState.CONNECTED;
      this.emitStateChange();
    } catch (error) {
      this._state = ConnectionState.ERROR;
      this.emitStateChange();
      this.eventEmitter.emit('error', error);
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
      if (port.isOpen) {
        port.close(() => {});
      }
      port.removeAllListeners();
    }
    this._state = ConnectionState.DISCONNECTED;
    this.eventEmitter.removeAllListeners();
  }

  write(data: Buffer | string): void {
    // 将字符串转换为 Buffer，使用 UTF-8 编码以支持中文
    const bufferData = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

    if (this.port?.isOpen) {
      this.port.write(bufferData);
    } else if (this.sharedConnection) {
      this.sharedConnection.write(bufferData);
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
    this.termCols = cols;
    this.termRows = rows;
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
    if (!this.options.autoReconnect || this.isClosing) {
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
      this.eventEmitter.emit('error', new Error(`重连失败，已达最大重试次数 (${maxAttempts})`));
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
