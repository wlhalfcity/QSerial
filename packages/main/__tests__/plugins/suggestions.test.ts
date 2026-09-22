/**
 * 终端用户输入监听与输入建议注册表测试
 * 覆盖：广播与取消订阅、插件异常隔离、建议提供者注册/回收、
 *       权限裁剪（terminal:observe / terminal:write）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    setName: () => {},
    getPath: (name: string) => (name === 'userData' ? '/tmp/qserial-test' : '/tmp'),
  },
}));

import {
  addUserInputListener,
  notifyUserInput,
  addSuggestionProvider,
  getSuggestionProviders,
  removeAllContributions,
} from '../../src/plugins/registry.ts';
import { buildPluginContext } from '../../src/plugins/host-api.ts';
import { PluginPermissionError } from '../../src/plugins/permissions.ts';

const PID = 'terminal-ext-test-plugin';

beforeEach(() => {
  removeAllContributions(PID);
});

function makeCtx(permissions: string[]) {
  return buildPluginContext({
    id: PID,
    name: PID,
    version: '1.0.0',
    permissions: permissions as never[],
  } as never);
}

describe('user input listeners', () => {
  it('broadcasts input events to registered listeners', () => {
    const received: Array<{ connectionId: string; data: string }> = [];
    buildPluginContext({
      id: PID,
      name: PID,
      version: '1.0.0',
      permissions: ['terminal:observe'],
    } as never).terminal.onUserInput((e) => received.push(e));

    notifyUserInput('conn-1', 'AT\r');
    expect(received).toEqual([{ connectionId: 'conn-1', data: 'AT\r' }]);
  });

  it('unsubscribes via the returned function', () => {
    const ctx = makeCtx(['terminal:observe']);
    const received: string[] = [];
    const off = ctx.terminal.onUserInput((e) => received.push(e.data));
    off();
    notifyUserInput('conn-1', 'x');
    expect(received).toEqual([]);
  });

  it('isolates listener exceptions', () => {
    const ctx = makeCtx(['terminal:observe']);
    const ok: string[] = [];
    ctx.terminal.onUserInput(() => {
      throw new Error('boom');
    });
    ctx.terminal.onUserInput((e) => ok.push(e.data));
    expect(() => notifyUserInput('conn-1', 'AT')).not.toThrow();
    expect(ok).toEqual(['AT']);
  });

  it('clears listeners on removeAllContributions', () => {
    const ctx = makeCtx(['terminal:observe']);
    const received: string[] = [];
    ctx.terminal.onUserInput((e) => received.push(e.data));
    removeAllContributions(PID);
    notifyUserInput('conn-1', 'AT');
    expect(received).toEqual([]);
  });
});

describe('suggestion providers', () => {
  it('registers and retrieves providers', async () => {
    const ctx = makeCtx(['terminal:write']);
    ctx.terminal.registerSuggestionProvider(async (c) =>
      c.currentLine.startsWith('AT') ? [{ text: 'AT+CMGF=1', source: PID }] : []
    );

    const providers = getSuggestionProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].pluginId).toBe(PID);

    const result = await providers[0].provider({
      connectionId: 'c1',
      connectionType: 'serial',
      connectionName: 'COM3',
      currentLine: 'AT+C',
    });
    expect(result).toEqual([{ text: 'AT+CMGF=1', source: PID }]);
  });

  it('clears providers on removeAllContributions', () => {
    const ctx = makeCtx(['terminal:write']);
    ctx.terminal.registerSuggestionProvider(async () => []);
    removeAllContributions(PID);
    expect(getSuggestionProviders()).toHaveLength(0);
  });
});

describe('permission enforcement', () => {
  it('rejects onUserInput without terminal:observe', () => {
    const ctx = makeCtx(['terminal:write', 'connection:read']);
    expect(() => ctx.terminal.onUserInput(() => {})).toThrow(PluginPermissionError);
  });

  it('rejects registerSuggestionProvider without terminal:write', () => {
    const ctx = makeCtx(['terminal:observe']);
    expect(() => ctx.terminal.registerSuggestionProvider(async () => [])).toThrow(
      PluginPermissionError
    );
  });
});
