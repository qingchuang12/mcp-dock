/**
 * 宿主 / 内置 Node 运行时探测（Phase 4 轻量方案）。
 *
 * 不内嵌完整 Node 运行时（避免打包体积与维护成本），而是：
 *  - 先探测「内置 Node」占位（process.resourcesPath/node），当前未随包分发故默认不可用；
 *  - 再探测宿主 Node / npx（用 client-probe 的 getEnhancedPathEnv 增强 PATH，覆盖常见安装目录）。
 * 结果缓存为 Promise，供 npm 适配器在详情里附「宿主运行时是否可用」信息，便于 UI 提示。
 */
import {spawn} from 'child_process';
import fs from 'fs';
import path from 'path';
import {getEnhancedPathEnv} from '../config/client-probe';

export interface NodeRuntime {
    /** 宿主或内置 Node 是否可用。 */
    available: boolean;
    /** `node --version` 输出（如 v20.11.0），不可用为 null。 */
    version: string | null;
    nodePath: string | null;
    npxPath: string | null;
    /** 是否探测到随包内置的 Node（当前实现恒为 false，仅为未来扩展预留钩子）。 */
    bundled: boolean;
}

let cache: Promise<NodeRuntime> | null = null;

/** 带超时的命令探测，返回 stdout 去尾空白；失败/超时返回 null。 */
function probe(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
    return new Promise(resolve => {
        let done = false;
        const finish = (v: string | null) => {
            if (!done) {
                done = true;
                resolve(v);
            }
        };
        let child;
        try {
            child = spawn(cmd, args, {
                env: {...process.env, PATH: getEnhancedPathEnv()},
                windowsHide: true,
            });
        } catch {
            return finish(null);
        }
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                /* ignore */
            }
            finish(null);
        }, timeoutMs);
        let out = '';
        child.stdout?.on('data', d => {
            out += d.toString();
        });
        child.stderr?.on('data', d => {
            out += d.toString();
        });
        child.on('error', () => finish(null));
        child.on('close', () => {
            clearTimeout(timer);
            finish(out.trim() || null);
        });
    });
}

/** 探测宿主 Node 运行时（结果缓存）。 */
export function detectNodeRuntime(): Promise<NodeRuntime> {
    if (cache) return cache;
    cache = (async () => {
        let bundled = false;
        try {
            const bundledNode = path.join(process.resourcesPath || '', 'node');
            bundled = fs.existsSync(bundledNode);
        } catch {
            bundled = false;
        }
        const version = await probe('node', ['--version']);
        const npxVersion = await probe('npx', ['--version']);
        return {
            available: !!version,
            version,
            nodePath: version ? 'node' : null,
            npxPath: npxVersion ? 'npx' : null,
            bundled,
        };
    })();
    return cache;
}

/** 仅供测试重置缓存。 */
export function __resetNodeRuntimeCache(): void {
    cache = null;
}
