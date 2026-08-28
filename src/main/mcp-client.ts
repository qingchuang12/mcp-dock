/**
 * MCP JSON-RPC 客户端
 * 用于 Inspector 功能，通过 stdio 与 MCP Server 通信
 */

import {ChildProcess, execSync, spawn} from 'child_process';
import {EventEmitter} from 'events';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import https from 'https';
import {Readable} from 'stream';

// 缓存 shell 环境变量，避免重复执行
let cachedShellEnv: Record<string, string> | null = null;

interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
    id: number;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
    id: number;
}

interface McpTool {
    name: string;
    description?: string;
    inputSchema?: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

interface McpServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    type?: 'stdio' | 'http' | 'streamable-http' | 'sse';
    headers?: Record<string, string>;
}

export class McpClient extends EventEmitter {
    private process: ChildProcess | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private buffer = '';
    private connected = false;
    private serverInfo: { name?: string; version?: string } | null = null;
    private transportMode: 'stdio' | 'http' = 'stdio';
    private url?: string;
    private httpHeaders?: Record<string, string>;
    private sessionId?: string;
    private abortController?: AbortController;
    // Node 原生 http 请求句柄（用于断开时强制销毁连接）
    private httpReq?: http.ClientRequest;
    // —— SSE 传输（旧版 /sse 模式）相关 ——
    // 服务器经 GET SSE 流下发消息；首次下发的 `endpoint` 事件告知客户端应向哪个地址 POST JSON-RPC。
    private ssePostUrl?: string;
    private sseReader?: ReadableStreamDefaultReader<Uint8Array>;
    private sseBuffer = '';
    private sseEndpointResolve?: () => void;

    constructor() {
        super();
    }

    /**
     * 获取用户的完整 shell 环境变量
     * 通过启动一个交互式 shell 来获取完整的环境配置
     */
    private getShellEnv(): Record<string, string> {
        if (cachedShellEnv) {
            return cachedShellEnv;
        }

        const platform = process.platform;

        if (platform === 'darwin' || platform === 'linux') {
            try {
                // 尝试通过交互式 shell 获取完整的环境变量
                const shell = process.env.SHELL || '/bin/zsh';
                const result = execSync(`${shell} -ilc 'env'`, {
                    encoding: 'utf-8',
                    timeout: 5000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                const env: Record<string, string> = {};
                for (const line of result.split('\n')) {
                    const idx = line.indexOf('=');
                    if (idx > 0) {
                        const key = line.substring(0, idx);
                        const value = line.substring(idx + 1);
                        env[key] = value;
                    }
                }

                cachedShellEnv = env;
                return env;
            } catch (error) {
                console.warn('[MCP] Failed to get shell env, using fallback PATH:', error);
            }
        }

        // 回退方案：使用增强的 PATH
        cachedShellEnv = {
            ...process.env as Record<string, string>,
            PATH: this.getEnhancedPath(),
        };
        return cachedShellEnv;
    }

    /**
     * 获取增强的 PATH 环境变量（回退方案）
     * 包含常见的包管理器安装路径
     */
    private getEnhancedPath(): string {
        const home = os.homedir();
        const platform = process.platform;
        const currentPath = process.env.PATH || '';

        const additionalPaths: string[] = [];

        if (platform === 'darwin' || platform === 'linux') {
            // 添加常见的可执行文件路径
            const commonPaths = [
                '/usr/local/bin',
                '/opt/homebrew/bin',           // Homebrew on Apple Silicon
                '/opt/homebrew/sbin',
                path.join(home, '.local/bin'), // pipx, uv 等
                path.join(home, '.volta/bin'), // volta
                path.join(home, '.pyenv/shims'), // pyenv
                path.join(home, '.cargo/bin'), // rust/cargo
                '/opt/local/bin',              // MacPorts
                '/usr/bin',
                '/bin',
            ];

            // 只添加实际存在的路径
            for (const p of commonPaths) {
                if (fs.existsSync(p)) {
                    additionalPaths.push(p);
                }
            }

            // 尝试查找 nvm 的当前 node 路径
            const nvmDir = path.join(home, '.nvm/versions/node');
            if (fs.existsSync(nvmDir)) {
                try {
                    const versions = fs.readdirSync(nvmDir);
                    if (versions.length > 0) {
                        // 使用最新版本
                        versions.sort().reverse();
                        const latestBin = path.join(nvmDir, versions[0], 'bin');
                        if (fs.existsSync(latestBin)) {
                            additionalPaths.push(latestBin);
                        }
                    }
                } catch {
                    // 忽略错误
                }
            }

            // 尝试查找 fnm 的当前 node 路径
            const fnmDir = path.join(home, '.fnm/node-versions');
            if (fs.existsSync(fnmDir)) {
                try {
                    const versions = fs.readdirSync(fnmDir);
                    if (versions.length > 0) {
                        versions.sort().reverse();
                        const latestBin = path.join(fnmDir, versions[0], 'installation/bin');
                        if (fs.existsSync(latestBin)) {
                            additionalPaths.push(latestBin);
                        }
                    }
                } catch {
                    // 忽略错误
                }
            }
        } else if (platform === 'win32') {
            const commonPaths = [
                path.join(home, 'AppData', 'Roaming', 'npm'),
                path.join(home, '.pyenv', 'pyenv-win', 'shims'),
            ];

            for (const p of commonPaths) {
                if (fs.existsSync(p)) {
                    additionalPaths.push(p);
                }
            }
        }

        return [...additionalPaths, currentPath].join(path.delimiter);
    }

    /**
     * 清理透传给 MCP Server 子进程的环境变量。
     *
     * mcp-dock 自身常在某些宿主环境下被注入 NODE_OPTIONS，例如：
     *  - IDE/调试器启动 mcp-dock 时附带的 `--inspect` / `--inspect-brk`；
     *  - 沙箱环境为安全删除注入的 `--require=.../genie-safe-delete.cjs`。
     * 这些标志若原样透传给用户启动的 MCP Server，会导致子进程 node 停在
     * 断点等待（永不回 initialize）或被沙箱拦截文件操作，最终连接超时。
     * 这里只剔除调试与安全 shim 相关标记，保留用户自定义的环境变量。
     */
    private sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const cleaned: NodeJS.ProcessEnv = {...env};
        const raw = cleaned.NODE_OPTIONS;
        if (raw) {
            const kept = raw
                .split(/\s+/)
                .filter((flag) => {
                    const f = flag.trim();
                    if (!f) return false;
                    // 去掉 Node inspector 调试标记
                    if (/^--inspect(-brk)?(=\S*)?$/.test(f)) return false;
                    if (/^--inspect-port(=\S*)?$/.test(f)) return false;
                    // 去掉沙箱安全删除 shim 的 --require
                    if (f.includes('genie-safe-delete')) return false;
                    return true;
                });
            const joined = kept.join(' ').trim();
            if (joined) cleaned.NODE_OPTIONS = joined;
            else delete cleaned.NODE_OPTIONS;
        }
        return cleaned;
    }

    /**
     * 连接到 MCP Server
     */
    async connect(config: McpServerConfig): Promise<{ name?: string; version?: string }> {
        if (this.connected) {
            throw new Error('Already connected');
        }

        const mode: 'stdio' | 'http' | 'sse' =
            config.type === 'sse' ? 'sse'
                : (config.type && config.type !== 'stdio' ? 'http' : 'stdio');
        this.transportMode = mode === 'sse' ? 'http' : mode;

        if (mode === 'sse') {
            return this.connectSse(config);
        }
        if (mode === 'http') {
            return this.connectHttp(config);
        }
        return this.connectStdio(config);
    }

    private     async connectHttp(config: McpServerConfig): Promise<{ name?: string; version?: string }> {
        if (!config.url) {
            throw new Error('HTTP transport requires a "url"');
        }
        this.url = config.url;
        this.httpHeaders = config.headers;
        this.sessionId = undefined;
        this.abortController = new AbortController();

        // StreamableHTTP：除 POST 请求/响应外，客户端还须打开一条 GET SSE 流，
        // 用于接收 server→client 的消息（含服务器以 202 异步下发的 JSON-RPC 响应）。
        // 若不打开该流，服务器返回 202 时 initialize 永远收不到响应 → 表现为 30s 超时。
        // 对不支持 GET 流的纯请求/响应服务器，下面 fetch 会失败/返回非 SSE，错误被忽略，
        // 不影响 POST 自带响应（200+JSON）的正常工作，向后兼容。
        void this.startHttpGetStream();

        try {
            const initResult = await this.sendRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'AI-Tools Inspector', version: '1.0.0' },
            }) as { serverInfo?: { name?: string; version?: string } };

            this.serverInfo = initResult.serverInfo || null;
            this.connected = true;
            this.sendNotification('notifications/initialized', {});
            this.emit('connected', this.serverInfo);
            return this.serverInfo || {};
        } catch (error) {
            this.connected = false;
            throw error;
        }
    }

    /**
     * 连接到「旧版 SSE」传输的 MCP Server。
     *
     * 与 streamable-http（POST 即响应）不同，SSE 模式：
     *  - 客户端先发 GET 到 url 建立 server→client 的 SSE 消息通道；
     *  - 服务端首条 `event: endpoint` 会携带实际 POST 地址（含 session_id）；
     *  - 之后所有 JSON-RPC 请求都 POST 到该地址，响应经上面的 GET 流回传。
     * 不打开 GET 流直接 POST 会导致 initialize 永远等不到响应（表现为 30s 超时）。
     */
    private async connectSse(config: McpServerConfig): Promise<{ name?: string; version?: string }> {
        if (!config.url) {
            throw new Error('SSE transport requires a "url"');
        }
        this.url = config.url;
        this.httpHeaders = config.headers;
        this.sessionId = undefined;
        this.ssePostUrl = undefined;
        this.sseBuffer = '';
        this.abortController = new AbortController();
        // 复用 httpPost 发送请求，但 POST 目标为握手得到的 ssePostUrl
        this.transportMode = 'http';

        try {
            const sseRes = await this.performRequest('GET', this.url, {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                ...(this.httpHeaders || {}),
            });

            this.startSseRead(Readable.toWeb(sseRes) as unknown as ReadableStream<Uint8Array>);

            // 等待服务端下发 endpoint（含 session_id 的 POST 地址）
            const endpointReceived = new Promise<void>((resolve) => {
                this.sseEndpointResolve = resolve;
            });
            const handshakeTimeout = new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('SSE endpoint handshake timeout')), 10000);
            });
            await Promise.race([endpointReceived, handshakeTimeout]);

            const initResult = await this.sendRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'AI-Tools Inspector', version: '1.0.0' },
            }) as { serverInfo?: { name?: string; version?: string } };

            this.serverInfo = initResult.serverInfo || null;
            this.connected = true;
            this.sendNotification('notifications/initialized', {});
            this.emit('connected', this.serverInfo);
            return this.serverInfo || {};
        } catch (error) {
            this.connected = false;
            this.disconnect();
            throw error;
        }
    }

    /**
     * 持续读取 SSE GET 流：把 `endpoint` 事件解析为 POST 地址，把 `message` 事件当作 JSON-RPC 响应。
     */
    private startSseRead(body: ReadableStream<Uint8Array> | null): void {
        if (!body) return;
        const reader = body.getReader();
        this.sseReader = reader;
        const decoder = new TextDecoder();

        const pump = async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    // 归一化 CRLF→LF：部分服务端（Python MCP SDK / uvicorn）严格按 SSE 规范
                    // 用 \r\n 分隔块，而下方按 '\n\n' 切分块，不归一化会导致块永不切出、
                    // 消息永不解析，表现为 initialize 30s 超时。
                    this.sseBuffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                    let idx;
                    while ((idx = this.sseBuffer.indexOf('\n\n')) !== -1) {
                        const block = this.sseBuffer.slice(0, idx);
                        this.sseBuffer = this.sseBuffer.slice(idx + 2);
                        this.handleSseEvent(block);
                    }
                }
            } catch {
                // 流被关闭/中止，忽略
            }
        };
        void pump();
    }

    /**
     * 打开 StreamableHTTP 的 server→client GET SSE 流。
     * 用途：接收服务器主动下发的消息（通知、日志），以及以 202 异步回传的 JSON-RPC 响应。
     * 复用 startSseRead 的解析逻辑（只处理 `message` 事件；StreamableHTTP 无 `endpoint` 事件）。
     * 若服务器不支持 GET 流（纯请求/响应模式），fetch 会失败或返回非 SSE，错误被忽略，
     * 不影响 POST 自带响应（200+JSON）的正常工作。
     */
    private async startHttpGetStream(): Promise<void> {
        if (!this.url || !this.abortController) return;
        try {
            const res = await this.performRequest('GET', this.url, {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
                ...(this.httpHeaders || {}),
            });
            this.startSseRead(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        } catch (error) {
            if ((error as Error)?.name === 'AbortError') return;
            console.error('[MCP] HTTP GET stream failed (non-fatal):', error);
        }
    }

    private handleSseEvent(block: string): void {
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
                event = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
            }
        }
        const data = dataLines.join('\n');
        if (!data) return;

        if (event === 'endpoint') {
            try {
                this.ssePostUrl = new URL(data, this.url).href;
            } catch {
                this.ssePostUrl = data;
            }
            this.sseEndpointResolve?.();
            this.sseEndpointResolve = undefined;
            return;
        }

        // message / 其它事件：当作 JSON-RPC 响应处理
        try {
            this.handleResponse(JSON.parse(data));
        } catch (e) {
            console.error('[MCP] Failed to parse SSE message:', data, e);
        }
    }

    private async connectStdio(config: McpServerConfig): Promise<{ name?: string; version?: string }> {
        return new Promise((resolve, reject) => {
            try {
                // 获取完整的 shell 环境变量，解决 GUI 启动时环境变量不完整的问题。
                // 只清理「从宿主继承」的环境（避免 IDE/调试器/沙箱注入的 --inspect、
                // 安全删除 shim 透传给子进程导致 server 卡在断点/被拦截）；
                // 用户在该 server 配置里「显式设置」的 env 原样保留，不被误删。
                // [诊断] 打印宿主透传给 mcp-dock 的 NODE_OPTIONS，便于确认 --inspect 来源。
                console.error('[MCP env debug] inherited NODE_OPTIONS =', JSON.stringify(process.env.NODE_OPTIONS));
                const shellEnv = this.sanitizeEnv(this.getShellEnv());
                const env = {
                    ...shellEnv,
                    ...config.env,
                };

                // 启动进程
                // Windows: shell:true 会经 cmd.exe 派生，需 windowsHide 避免弹黑窗，退出时用 taskkill /T 杀整棵进程树；
                // macOS/Linux: detached 建立独立进程组，退出时 kill(-pid) 可一并终止全部子进程。
                this.process = spawn(config.command!, config.args || [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                    cwd: config.cwd || undefined,
                    shell: true,
                    ...(process.platform === 'win32' ? {windowsHide: true} : {detached: true}),
                });

                // 处理 stdout
                this.process.stdout?.on('data', (data: Buffer) => {
                    this.handleData(data.toString());
                });

                // 处理 stderr
                this.process.stderr?.on('data', (data: Buffer) => {
                    const message = data.toString();
                    console.error('[MCP stderr]', message);
                    this.emit('stderr', message);
                });

                // 处理进程退出
                this.process.on('exit', (code) => {
                    this.connected = false;
                    this.emit('disconnected', code ?? 0);
                    this.rejectAllPending(new Error(`Process exited with code ${code}`));
                });

                // 处理错误
                this.process.on('error', (error) => {
                    this.connected = false;
                    this.emit('error', error);
                    reject(error);
                });

                // 发送初始化请求
                this.sendRequest('initialize', {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: {
                        name: 'AI-Tools Inspector',
                        version: '1.0.0',
                    },
                }).then((result: unknown) => {
                    const initResult = result as { serverInfo?: { name?: string; version?: string } };
                    this.serverInfo = initResult.serverInfo || null;
                    this.connected = true;

                    // 发送 initialized 通知
                    this.sendNotification('notifications/initialized', {});

                    this.emit('connected', this.serverInfo);
                    resolve(this.serverInfo || {});
                }).catch((error) => {
                    this.disconnect();
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 统一发送一行 JSON-RPC 消息：stdio 写子进程 stdin，http 走 fetch POST。
     */
    private sendRawMessage(message: string): void {
        if (this.transportMode === 'http') {
            void this.httpPost(message);
        } else {
            this.process?.stdin?.write(message);
        }
    }

    /**
     * 通过 HTTP(S) 发送 JSON-RPC（支持 streamable-http 与 sse）。
     * POST 到 config.url，响应可能是 JSON 或 SSE 流；
     * 服务端可能在响应头返回 mcp-session-id，后续请求需携带。
     */
    private async httpPost(message: string): Promise<void> {
        if (!this.url || !this.abortController) return;
        // SSE 模式下 POST 目标为握手得到的 endpoint 地址；其余情况直接用 url
        const postUrl = this.ssePostUrl || this.url;
        try {
            const res = await this.performRequest('POST', postUrl, {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
                ...(this.httpHeaders || {}),
            }, message);

            const sid = res.headers['mcp-session-id'] || res.headers['mcp-session-id'];
            if (sid) this.sessionId = sid as string;

            const ct = (res.headers['content-type'] as string) || '';
            if (ct.includes('text/event-stream')) {
                await this.readSseStream(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, (msg) => this.handleResponse(msg));
            } else {
                const text = await this.collectText(res);
                if (text) {
                    try {
                        this.handleResponse(JSON.parse(text));
                    } catch (e) {
                        console.error('[MCP] Failed to parse http response:', text, e);
                    }
                }
            }
        } catch (error: unknown) {
            if ((error as Error)?.name === 'AbortError') return;
            const err = error instanceof Error ? error : new Error(String(error));
            this.emit('error', err);
            // 网络层错误：reject 对应 pending 请求，避免调用方永久挂起
            try {
                const id = (JSON.parse(message) as { id?: number }).id;
                const pending = id != null ? this.pendingRequests.get(id) : undefined;
                if (pending) {
                    this.pendingRequests.delete(id!);
                    pending.reject(err);
                }
            } catch {
                // 忽略解析失败
            }
        }
    }

    /**
     * 使用 Node 原生 http/https 发起请求。
     *
     * 重要：刻意不走 Electron 主进程的全局 `fetch`（Chromium 网络栈）。后者在 Windows 上会
     * 遵守系统/会话代理设置，导致 localhost / 127.0.0.1 被发往代理而连接失败（表现为
     * "fetch failed"）。改用 Node 的 http 模块后，行为与普通 curl 一致——直连 OS 网络栈，
     * 不受代理拦截，且默认启用 Happy Eyeballs（autoSelectFamily）可正确处理 IPv4/IPv6。
     *
     * 对 SSE（GET 长连接）在收到响应头后立即 resolve(res)，由调用方继续以流的方式消费。
     */
    private performRequest(
        method: 'GET' | 'POST',
        url: string,
        headers: Record<string, string>,
        body?: string,
    ): Promise<http.IncomingMessage> {
        return new Promise((resolve, reject) => {
            let u: URL;
            try {
                u = new URL(url);
            } catch (e) {
                reject(e);
                return;
            }
            const lib = u.protocol === 'https:' ? https : http;
            const req = lib.request(u, { method, headers }, (res) => resolve(res));
            this.httpReq = req;
            req.on('error', (err) => reject(err));
            // 支持中断：断开时 abortController.abort() 会触发 destroy，关闭底层连接
            if (this.abortController) {
                if (this.abortController.signal.aborted) {
                    req.destroy();
                } else {
                    this.abortController.signal.addEventListener(
                        'abort',
                        () => req.destroy(),
                        { once: true },
                    );
                }
            }
            if (body) req.write(body);
            req.end();
        });
    }

    /** 将 Node 响应体读为完整文本（非 SSE 的 JSON 响应）。 */
    private collectText(res: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            res.on('error', reject);
        });
    }

    /**
     * 解析 SSE 流（text/event-stream），将每条 data: 行作为 JSON-RPC 消息回调。
     */
    private async readSseStream(body: ReadableStream<Uint8Array> | null, onMessage: (msg: JsonRpcResponse) => void): Promise<void> {
        if (!body) return;
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // 归一化 CRLF→LF：兼容按 SSE 规范使用 \r\n 分隔块的服务端（如 uvicorn）。
                // 否则只读 '\n\n' 永远切不出块，initialize 响应无法解析 → 30s 超时。
                buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                let idx;
                while ((idx = buf.indexOf('\n\n')) !== -1) {
                    const chunk = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const dataLines = chunk.split('\n')
                        .filter((l) => l.startsWith('data:'))
                        .map((l) => l.slice(5).trim());
                    const data = dataLines.join('\n');
                    if (data) {
                        try {
                            onMessage(JSON.parse(data));
                        } catch (e) {
                            console.error('[MCP] Failed to parse SSE data:', data, e);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        if (this.transportMode === 'http') {
            this.abortController?.abort();
            // 强制销毁底层 TCP 连接（SSE GET 长连接可能在 abort 事件前已脱离 req 句柄）
            try {
                this.httpReq?.destroy();
            } catch {
                // 忽略
            }
            this.httpReq = undefined;
            this.abortController = undefined;
            // 关闭 SSE GET 流（若存在）
            try {
                this.sseReader?.cancel();
            } catch {
                // 忽略
            }
            this.sseReader = undefined;
            this.sseEndpointResolve = undefined;
            this.ssePostUrl = undefined;
            this.connected = false;
            this.buffer = '';
            this.rejectAllPending(new Error('Disconnected'));
            this.emit('disconnected', 0);
            return;
        }
        if (this.process) {
            this.killProcessTree(this.process);
            this.process = null;
        }
        this.connected = false;
        this.buffer = '';
        this.rejectAllPending(new Error('Disconnected'));
    }

    /**
     * 终止整个子进程树：shell:true 派生的 MCP server 进程若只 kill 外层 shell 会残留。
     * Windows 用 taskkill /T /F 递归终止；macOS/Linux 用进程组负 pid（需 detached 启动）。
     */
    private killProcessTree(child: ChildProcess): void {
        const pid = child.pid;
        if (pid == null) {
            child.kill();
            return;
        }

        if (process.platform === 'win32') {
            try {
                spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true});
            } catch {
                child.kill();
            }
        } else {
            try {
                process.kill(-pid, 'SIGTERM');
            } catch {
                // 进程组不存在（如进程已退出），忽略
            }
            child.kill();
        }
    }

    /**
     * 获取工具列表
     */
    async listTools(): Promise<McpTool[]> {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        const result = await this.sendRequest('tools/list', {}) as { tools: McpTool[] };
        return result.tools || [];
    }

    /**
     * 调用工具
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        });
        return result;
    }

    /**
     * 获取资源列表
     */
    async listResources(): Promise<unknown[]> {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        try {
            const result = await this.sendRequest('resources/list', {}) as { resources: unknown[] };
            return result.resources || [];
        } catch {
            // 如果服务器不支持资源，返回空数组
            return [];
        }
    }

    /**
     * 获取 Prompt 列表
     */
    async listPrompts(): Promise<unknown[]> {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        try {
            const result = await this.sendRequest('prompts/list', {}) as { prompts: unknown[] };
            return result.prompts || [];
        } catch {
            // 如果服务器不支持 prompts，返回空数组
            return [];
        }
    }

    /**
     * 检查是否已连接
     */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * 获取服务器信息
     */
    getServerInfo(): { name?: string; version?: string } | null {
        return this.serverInfo;
    }

    /**
     * 发送 JSON-RPC 请求
     */
    private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (this.transportMode === 'stdio' && !this.process?.stdin) {
                reject(new Error('No stdin available'));
                return;
            }

            const id = ++this.requestId;
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                method,
                params,
                id,
            };

            this.pendingRequests.set(id, {resolve, reject});

            const message = JSON.stringify(request) + '\n';
            this.sendRawMessage(message);

            // 设置超时
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${method}`));
                }
            }, 30000);
        });
    }

    /**
     * 发送通知（无需响应）
     */
    private sendNotification(method: string, params?: Record<string, unknown>): void {
        if (this.transportMode === 'stdio' && !this.process?.stdin) {
            return;
        }

        const notification = {
            jsonrpc: '2.0',
            method,
            params,
        };

        const message = JSON.stringify(notification) + '\n';
        this.sendRawMessage(message);
    }

    /**
     * 处理接收到的数据
     */
    private handleData(data: string): void {
        this.buffer += data;

        // 按行分割处理
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const response = JSON.parse(line) as JsonRpcResponse;
                    this.handleResponse(response);
                } catch (error) {
                    console.error('[MCP] Failed to parse response:', line, error);
                }
            }
        }
    }

    /**
     * 处理 JSON-RPC 响应
     */
    private handleResponse(response: JsonRpcResponse): void {
        // 处理通知（没有 id）
        if (!('id' in response)) {
            this.emit('notification', response);
            return;
        }

        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            console.warn('[MCP] Received response for unknown request:', response.id);
            return;
        }

        this.pendingRequests.delete(response.id);

        if (response.error) {
            pending.reject(new Error(response.error.message));
        } else {
            pending.resolve(response.result);
        }
    }

    /**
     * 拒绝所有待处理的请求
     */
    private rejectAllPending(error: Error): void {
        for (const [, pending] of this.pendingRequests) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
}

// 全局 MCP 客户端实例管理
const clients = new Map<string, McpClient>();

export function getMcpClient(id: string): McpClient | undefined {
    return clients.get(id);
}

export function createMcpClient(id: string): McpClient {
    // 如果已存在，先断开
    const existing = clients.get(id);
    if (existing) {
        existing.disconnect();
    }

    const client = new McpClient();
    clients.set(id, client);
    return client;
}

export function removeMcpClient(id: string): void {
    const client = clients.get(id);
    if (client) {
        client.disconnect();
        clients.delete(id);
    }
}

/**
 * 断开并清理所有 MCP 客户端子进程（应用退出时调用，避免残留进程 / stdio 句柄阻塞主进程退出）
 */
export function disconnectAllClients(): void {
    for (const client of clients.values()) {
        client.disconnect();
    }
    clients.clear();
}
