/** Config section `worlds.cua`: defaults and the WebUI config group. */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export const CUA_ID = 'cua';

/** When the person is asked before the screen is read or the mouse moves. Same ladder as the computer-control World. */
export const ASK_LEVELS = ['ask-each-command', 'ask-each-turn', 'ask-once', 'never-ask'] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

export interface CuaConfigSection extends WorldSection {
  /** Ask on the desktop before a call: every call, once per turn, once per `grantMinutes`, or never. */
  ask: AskLevel;
  /** How long an 「ask-once」 yes holds. */
  grantMinutes: number;
  /** Port of the loopback bridge; 0 = pick a free one and report it in bridge.json. */
  port: number;
  /** Serve the loopback bridge for other programs (AstrBot and friends). */
  bridge: boolean;
  /** Per-call wall clock for the PowerShell engine. */
  timeoutMs: number;
  screenshot: {
    maxWidth: number;
    maxHeight: number;
    quality: number;
  };
}

export const CUA_DEFAULTS: CuaConfigSection = {
  enabled: false,
  ask: 'ask-once',
  grantMinutes: 30,
  port: 17901,
  bridge: true,
  timeoutMs: 30_000,
  screenshot: { maxWidth: 1280, maxHeight: 800, quality: 75 },
};

const K = `worlds.${CUA_ID}`;

export const CUA_CONFIG_GROUP: ConfigGroup = {
  id: `world:${CUA_ID}`,
  owner: `world:${CUA_ID}`,
  schema: {
    type: 'object',
    title: 'CUA（看屏幕 / 点 / 打字）',
    properties: {
      [`${K}.ask`]: {
        type: 'string', title: '什么时候先问你', enum: [...ASK_LEVELS], 'x-hot': true,
        description: 'ask-each-command:每次调用前都弹框问;ask-each-turn:每一轮第一次调用前问一次;ask-once:问一次,同意后「同意管多久」内不再问;never-ask:都不问。弹框是桌面上系统原生的「是/否」确认窗(默认按钮是「否」,关闭窗口、60 秒不答都按拒绝算)。',
      },
      [`${K}.grantMinutes`]: { type: 'integer', title: '同意管多久', minimum: 1, maximum: 1440, 'x-suffix': '分钟', description: '只对 ask-once 有效。', 'x-hot': true },
      [`${K}.port`]: {
        type: 'integer', title: '桥接端口', minimum: 0, maximum: 65535, 'x-hot': true,
        description: '本机其他程序(比如 AstrBot 插件)调用的端口,只监听 127.0.0.1;被占用会顺延。实际端口与令牌写在数据目录的 cua/bridge.json 里。填 0 表示随便挑一个。',
      },
      [`${K}.bridge`]: {
        type: 'boolean', title: '允许本机其他程序调用', 'x-hot': true,
        description: '开启后本 World 会在 127.0.0.1 上开一个小 HTTP 服务,令牌文件 cua/bridge.json 只有你读得到。关掉就只剩 Coo 自己能调用这些工具。',
      },
      [`${K}.timeoutMs`]: {
        type: 'integer', title: '单次调用超时', minimum: 1000, maximum: 300000, 'x-suffix': 'ms', 'x-hot': true,
        description: '超过此时长就终止这次调用的 PowerShell 进程,按失败回报。',
      },
      [`${K}.screenshot.maxWidth`]: { type: 'integer', title: '截图最大宽度', minimum: 320, maximum: 3840, 'x-suffix': 'px', 'x-hot': true },
      [`${K}.screenshot.maxHeight`]: { type: 'integer', title: '截图最大高度', minimum: 240, maximum: 2160, 'x-suffix': 'px', 'x-hot': true },
      [`${K}.screenshot.quality`]: { type: 'integer', title: 'JPEG 质量', minimum: 30, maximum: 95, 'x-hot': true },
    },
  },
};
