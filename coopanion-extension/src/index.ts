/** Package entry: the default export is the WorldDefinition; the loader keys off `cortico.kind === 'world'`. */
import { CUA } from './definition.ts';

export default CUA;
export { CUA };
export { CUA_DEFAULTS, CUA_CONFIG_GROUP, CUA_ID, ASK_LEVELS } from './config.ts';
export type { CuaConfigSection, AskLevel } from './config.ts';
export { CuaWorld, CUA_TOOL_SPECS, describeShot, describeWindows, ASK_TIMEOUT_MS } from './world.ts';
export { Bridge, type BridgeOptions, type BridgeOutcome } from './bridge.ts';
export { runCua, askDesktop, CuaFailure, type CuaOp, type ShotResult, type ScreenInfo, type WindowEntry } from './engine.ts';
