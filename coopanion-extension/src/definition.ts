/** The WorldDefinition: id, defaults, the Windows preflight, self-description, and the factory. */
import { spawnSync } from 'node:child_process';
import { describeTools, type WorldContext, type WorldDefinition } from 'cortico/world.ts';
import { CUA_DEFAULTS, CUA_ID, type CuaConfigSection } from './config.ts';
import { CUA_TOOL_SPECS, CuaWorld } from './world.ts';

export const CUA: WorldDefinition<CuaConfigSection> = {
  id: CUA_ID,
  label: 'CUA',
  describe: {
    tools: describeTools(CUA_TOOL_SPECS, {
      cua_screenshot: { zh: '截一块显示器，附指针位置与前台窗口标题', en: 'Capture one display with the pointer position and foreground window title' },
      cua_windows: { zh: '列出可见的顶层窗口', en: 'List the visible top-level windows' },
      cua_click: { zh: '把鼠标移到某处并点击', en: 'Move the mouse to a point and click' },
      cua_type: { zh: '在当前输入焦点输入文字', en: 'Type text at the current input focus' },
      cua_key: { zh: '按一个键或组合键', en: 'Press a key or a key combination' },
      cua_focus: { zh: '把一个窗口切到前台', en: 'Bring a window to the foreground' },
    }),
    events: [],
  },
  defaults: () => ({ ...CUA_DEFAULTS, screenshot: { ...CUA_DEFAULTS.screenshot } }),
  preflight: () => {
    if (process.platform !== 'win32') {
      throw new Error('CUA 目前只支持 Windows：截图、点击与窗口枚举都走 PowerShell + user32，其他平台还没有实现。');
    }
    const probe = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (probe.status !== 0 || !probe.stdout.trim()) {
      throw new Error('找不到 Windows PowerShell（powershell.exe）。CUA 的引擎就是它，装好或把它放进 PATH 再启用本 World。');
    }
  },
  create: (ctx) => new CuaWorld({
    cfg: ctx.cfg,
    botName: ctx.botName,
    // The deployment directory, not the code checkout: an installed app's repoRoot is its own
    // program folder, which an update replaces and the bot must not scribble in.
    dataDir: dataDirFor(ctx),
  }),
};

/** Per-deployment data root; the bridge token and port live under <it>/cua/. */
function dataDirFor(ctx: WorldContext<CuaConfigSection>): string {
  return ctx.dataDir || ctx.botDir || ctx.repoRoot;
}
