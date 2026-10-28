/** Config section `worlds.cua-bridge`: defaults and the WebUI config group. */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export const CUA_ID = 'cua-bridge';

/** The bridge's discovery file stays under `cua/` so an installed plugin keeps finding it after the World id changed. */
export const CUA_STATE_DIR = 'cua';

/** When the person is asked before the screen is read or the mouse moves. Same ladder as the computer-control World. */
export const ASK_LEVELS = ['ask-each-command', 'ask-each-turn', 'ask-once', 'never-ask'] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

export interface CuaNames {
  /** The pet bot's name; empty = the name the app is configured with (`displayName`). */
  coo: string;
  /** The other bot on the tunnel: AstrBot. */
  astrbot: string;
  /** The person at this computer; empty = the name the introduction stored (`worlds.desktop-pet.user`), else "使用者". */
  user: string;
}

export interface CuaConfigSection extends WorldSection {
  /**
   * Whether Coo itself gets these tools. Off by default: the World exists so that *another*
   * program on this machine (AstrBot) can use the screen through the bridge, not so the bot can
   * drive the desktop. Turn it on only if you want both.
   */
  exposeToBot: boolean;
  /** Legacy ladder used when `askRead` or `askAct` is empty: every call, once per turn, once per `grantMinutes`, or never. */
  ask: AskLevel;
  /** Ladder for read tools (screenshot, windows); empty = use `ask`. */
  askRead: AskLevel | '';
  /** Ladder for act tools (click, type, key, focus); empty = use `ask`. */
  askAct: AskLevel | '';
  /** How long an 「ask-once」 yes holds. */
  grantMinutes: number;
  /** An act call waits until the keyboard and mouse have been idle this long. */
  actIdleMs: number;
  /** How long an act call waits for the person to stop using the machine. */
  actWaitMs: number;
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
  screenshot: {
    maxWidth: number;
    maxHeight: number;
    quality: number;
  };
  /** AstrBot OpenAPI the pet can post to; empty URL keeps the mailbox. */
  chat: {
    astrbotUrl: string;
    apiKey: string;
    username: string;
    sessionId: string;
    /** AstrBot config_id; empty = the default config. */
    configId: string;
    waitMs: number;
  };
}

export const CUA_DEFAULTS: CuaConfigSection = {
  enabled: false,
  exposeToBot: false,
  ask: 'ask-once',
  askRead: '',
  askAct: '',
  grantMinutes: 30,
  actIdleMs: 1500,
  actWaitMs: 5000,
  port: 17901,
  bridge: true,
  bridgeHosts: '127.0.0.1,localhost,[::1]',
  timeoutMs: 30_000,
  screenshot: { maxWidth: 1280, maxHeight: 800, quality: 75 },
  chat: { astrbotUrl: '', apiKey: '', username: 'coo', sessionId: 'coo-astrbot', configId: '', waitMs: 90_000 },
  names: { coo: '', astrbot: 'AstrBot', user: '' },
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
        type: 'string', title: '默认询问档位', enum: [...ASK_LEVELS], 'x-hot': true,
        description: 'askRead / askAct 留空时用这一档。ask-each-command:每次调用前都弹框问;ask-each-turn:每一轮第一次调用前问一次;ask-once:问一次,同意后「同意管多久」内不再问;never-ask:都不问。弹框是桌面上系统原生的「是/否」确认窗(默认按钮是「否」,关闭窗口、60 秒不答都按拒绝算)。',
      },
      [`${K}.askRead`]: {
        type: 'string', title: '看屏幕前', enum: ['', ...ASK_LEVELS], 'x-hot': true,
        description: '截图、列窗口用这一档；留空跟随默认。',
      },
      [`${K}.askAct`]: {
        type: 'string', title: '动鼠标键盘前', enum: ['', ...ASK_LEVELS], 'x-hot': true,
        description: '点击、输入、按键、切窗口用这一档；留空跟随默认。',
      },
      [`${K}.actIdleMs`]: {
        type: 'integer', title: '键鼠空闲多久才动手', minimum: 0, maximum: 60000, 'x-suffix': 'ms', 'x-hot': true,
        description: '动鼠标键盘前等使用者停手这么久；0 = 不等。',
      },
      [`${K}.actWaitMs`]: {
        type: 'integer', title: '最多等使用者多久', minimum: 0, maximum: 60000, 'x-suffix': 'ms', 'x-hot': true,
        description: '使用者一直在用电脑时，超过这个时间就放弃这次操作。',
      },
      [`${K}.chat.astrbotUrl`]: {
        type: 'string', title: 'AstrBot OpenAPI 地址', 'x-hot': true,
        description: '例如 https://host:6185；Coo 主动找 AstrBot 时走 /api/v1/chat。留空则把消息放进信箱，由插件轮询取走。',
      },
      [`${K}.chat.apiKey`]: {
        type: 'string', title: 'AstrBot API Key', 'x-hot': true,
        description: 'abk_...；只需要 chat scope，不要用管理员 ID。像密码一样保管。',
      },
      [`${K}.chat.username`]: { type: 'string', title: '对话用的用户名', 'x-hot': true },
      [`${K}.chat.sessionId`]: { type: 'string', title: '对话用的 session', 'x-hot': true },
      [`${K}.chat.configId`]: {
        type: 'string', title: 'AstrBot 配置文件', 'x-hot': true,
        description: 'AstrBot 的 config_id（Dashboard → 配置文件里的 id，例如 default）。留空用默认配置；填错 AstrBot 会拒绝这次对话。',
      },
      [`${K}.chat.waitMs`]: { type: 'integer', title: '等 AstrBot 回复的上限', minimum: 5000, maximum: 300000, 'x-suffix': 'ms', 'x-hot': true },
      [`${K}.grantMinutes`]: { type: 'integer', title: '同意管多久', minimum: 1, maximum: 1440, 'x-suffix': '分钟', description: '只对 ask-once 有效。', 'x-hot': true },
      [`${K}.port`]: {
        type: 'integer', title: '桥接端口', minimum: 0, maximum: 65535, 'x-hot': true,
        description: '本机其他程序(比如 AstrBot 插件)调用的端口,只监听 127.0.0.1;被占用会顺延。实际端口与令牌写在数据目录的 cua/bridge.json 里。填 0 表示随便挑一个。',
      },
      [`${K}.bridge`]: {
        type: 'boolean', title: '允许本机其他程序调用', 'x-hot': true,
        description: '开启后本 World 会在 127.0.0.1 上开一个小 HTTP 服务,令牌文件 cua/bridge.json 受部署目录 ACL 保护。关掉就只剩 Coo 自己能调用这些工具。',
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
        description: '坐着这台电脑的人。留空时用启动引导里填的名字（worlds.desktop-pet.user）；那里也没有就叫「使用者」。只影响本 World 的提示词。',
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
