/** Config section `worlds.cua`: defaults and the WebUI config group. */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export const CUA_ID = 'cua';

/** When the person is asked before the screen is read or the mouse moves. Same ladder as the computer-control World. */
export const ASK_LEVELS = ['ask-each-command', 'ask-each-turn', 'ask-once', 'never-ask'] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

export interface CuaNames {
  /** The pet bot's name; empty = the name the app is configured with (`displayName`). */
  coo: string;
  /** The other bot on the tunnel: AstrBot. */
  astrbot: string;
  /** The person at this computer; empty = "使用者". */
  user: string;
}

export interface CuaChat {
  /**
   * AstrBot 插件的收件地址，例如 https://your-host/api/plug/astrbot_plugin_coopanion/coo/message。
   * 留空时 Coo 只能被动回复（AstrBot 先说话），不能主动发。
   */
  astrbotUrl: string;
  /** 两边共用的口令，随 Authorization: Bearer 发送。请与插件里的 coo_token 一致。 */
  token: string;
}

export interface CuaConfigSection extends WorldSection {
  /**
   * Whether Coo itself gets these tools. Off by default: the World exists so that *another*
   * program on this machine (AstrBot) can use the screen through the bridge, not so the bot can
   * drive the desktop. Turn it on only if you want both.
   */
  exposeToBot: boolean;
  /** Ask on the desktop before a call: every call, once per turn, once per `grantMinutes`, or never. */
  ask: AskLevel;
  /** How long an 「ask-once」 yes holds. */
  grantMinutes: number;
  /** Port of the loopback bridge; 0 = pick a free one and report it in bridge.json. */
  port: number;
  /** Serve the loopback bridge for other programs (AstrBot and friends). */
  bridge: boolean;
  /**
   * Host names the bridge answers, comma separated. Loopback by default. Behind a reverse tunnel
   * or a TLS proxy the Host header is the public name, so add it here (ports are ignored).
   */
  bridgeHosts: string;
  /** Per-call wall clock for the PowerShell engine. */
  timeoutMs: number;
  /**
   * Names used in this World's own prompt and tool texts, so the two bots and the person never
   * get mixed up. Nothing here renames AstrBot itself: it only affects what CUA says.
   */
  names: CuaNames;
  /** How Coo reaches AstrBot when it wants to speak first. */
  chat: CuaChat;
  screenshot: {
    maxWidth: number;
    maxHeight: number;
    quality: number;
  };
}

export const CUA_DEFAULTS: CuaConfigSection = {
  enabled: false,
  exposeToBot: false,
  ask: 'ask-once',
  grantMinutes: 30,
  port: 17901,
  bridge: true,
  bridgeHosts: '127.0.0.1,localhost,[::1]',
  timeoutMs: 30_000,
  screenshot: { maxWidth: 1280, maxHeight: 800, quality: 75 },
  names: { coo: '', astrbot: 'AstrBot', user: '' },
  chat: { astrbotUrl: '', token: '' },
};

const K = `worlds.${CUA_ID}`;

export const CUA_CONFIG_GROUP: ConfigGroup = {
  id: `world:${CUA_ID}`,
  owner: `world:${CUA_ID}`,
  schema: {
    type: 'object',
    title: 'CUA（看屏幕 / 点 / 打字）',
    properties: {
      // Same switch as the World overview, but writable here so the choice survives a restart.
      [`${K}.enabled`]: {
        type: 'boolean', title: '启用本 World', 'x-hot': true,
        description: '和「World 总览」里的开关是同一个值。在这里打开会写进 config.json，重启后仍然生效；关掉则停止桥接与工具。',
      },
      [`${K}.exposeToBot`]: {
        type: 'boolean', title: '也让 Coo 用这些工具', 'x-hot': true,
        description: '默认关闭：这些工具只通过桥接给本机其他程序（AstrBot 等）用，Coo 看不到、也调不到。打开后 Coo 自己也能截屏和操作鼠标键盘。',
      },
      [`${K}.bridgeHosts`]: {
        type: 'string', title: '桥接允许的 Host', 'x-hot': true,
        description: '逗号分隔。桥接只监听 127.0.0.1，所以正常不用改；经 SSH 反向隧道或 TLS 反代进来时，请求的 Host 是公网名字，把那个名字加进来（端口忽略）。',
      },
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
      [`${K}.names.coo`]: {
        type: 'string', title: '桌宠的名字', 'x-hot': true,
        description: 'Coo 在提示词和对 AstrBot 的消息里被这样称呼。留空用应用里配的展示名。只影响本 World 的提示词。',
      },
      [`${K}.names.astrbot`]: {
        type: 'string', title: '另一个 bot 的名字', 'x-hot': true,
        description: '隧道另一头的 AstrBot 在提示词里叫什么。只影响本 World 的提示词。',
      },
      [`${K}.names.user`]: {
        type: 'string', title: '使用者的名字', 'x-hot': true,
        description: '坐着这台电脑的人。留空时叫「使用者」。只影响本 World 的提示词。',
      },
      [`${K}.chat.astrbotUrl`]: {
        type: 'string', title: 'AstrBot 收件地址', 'x-hot': true,
        description: 'Coo 主动给 AstrBot 发消息时 POST 的地址，形如 https://host/api/plug/astrbot_plugin_coopanion/coo/message。留空则 Coo 只能被动回复。',
      },
      [`${K}.chat.token`]: {
        type: 'string', title: '与 AstrBot 的口令', 'x-hot': true,
        description: '两边共用的口令，以 Authorization: Bearer 发送。与插件配置里的 coo_token 填一样。明文保存在 config.json。',
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
