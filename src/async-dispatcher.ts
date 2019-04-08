import { Agent, request } from "https";
import { OutgoingHttpHeaders, IncomingMessage } from "http";
import { URLSearchParams } from "url";

class AsyncSemaphore {
    private _queue: Array<() => void> = [];

    public wait(): Promise<void> {
        const promise = new Promise<void>(resolve => {
            this._queue.push(resolve);
        });
        return promise;
    }

    public notify() {
        if (this._queue.length === 0) {
            return;
        }

        this._queue.shift()!();
    }
}

export interface HttpsRequestOptions {
    method?: string;
    host: string;
    path: string;
    headers?: OutgoingHttpHeaders;
    body?: string | Buffer;
    agent?: Agent;
    timeout?: number;
}

export interface HttpsRequestError extends Error {
    statusCode?: number;
    statusMessage?: string;
    body?: Buffer;
}

export function isHttpsRequestError(value: unknown): value is HttpsRequestError {
    const error = value as HttpsRequestError;
    return typeof error === 'number' && typeof error !== 'undefined';
}

export class AsyncDispatcher {
    private _concurrency: number;
    public get concurrency(): number { return this._concurrency; }

    private _running: number = 0;

    private _semaphore: AsyncSemaphore = new AsyncSemaphore();

    private _activeRequests: Set<HttpsRequestOptions> = new Set();
    public get activeRequests(): HttpsRequestOptions[] { return Array.from(this._activeRequests); };

    private _requestStatus: Map<HttpsRequestOptions, 'running' | 'success' | 'failed'> = new Map();
    public get requestStatus(): Map<HttpsRequestOptions, 'running' | 'success' | 'failed'> { return this._requestStatus; };

    constructor(concurrency: number = 10) {
        this._concurrency = concurrency;
    }

    public async run<T, U extends any[]>(task: (...args: U) => Promise<T>, ...args: U): Promise<T> {
        if (this._running === this._concurrency) {
            await this._semaphore.wait();
        }

        this._running++;
        try {
            return await task(...args);
        } finally {
            this._running--;
            this._semaphore.notify();
        }
    }

    public async all<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
        return Promise.all(tasks.map(item => this.run(item)));
    }

    public async map<T, U>(values: T[], task: (item: T) => Promise<U>): Promise<U[]> {
        return Promise.all(values.map(item => this.run(task, item)));
    }

    public async request(options: HttpsRequestOptions): Promise<Buffer> {
        return this.run(() => {
            return new Promise<Buffer>((resolve, reject) => {
                const { method, body, timeout, ...others } = options;

                const outgoing = request({
                    method,
                    ...others
                });

                outgoing.on('response', async (response: IncomingMessage) => {
                    console.log(`${response.statusCode} ${response.statusMessage} ${options.path}`);

                    try {
                        const body: Buffer[] = [];
                        for await (const chunk of response as AsyncIterable<Buffer>) {
                            body.push(chunk);
                        }

                        this._activeRequests.delete(options);
                        this._requestStatus.set(options, 'success');
                        clearTimeout(timeoutId);

                        if (response.statusCode! >= 200 && response.statusCode! < 300) {
                            resolve(Buffer.concat(body));
                            return;
                        }

                        const error: HttpsRequestError = new Error(`${response.statusCode} ${response.statusMessage}`);
                        error.statusCode = response.statusCode;
                        error.statusMessage = response.statusMessage;
                        error.body = Buffer.concat(body);
                        reject(error);
                    } catch (err) {
                        this._activeRequests.delete(options);
                        this._requestStatus.set(options, 'failed');
                        clearTimeout(timeoutId);

                        reject(err);
                    }
                });

                outgoing.on('error', (err) => {
                    this._activeRequests.delete(options);
                    this._requestStatus.set(options, 'failed');
                    clearTimeout(timeoutId);

                    reject(err);
                });

                if (method !== 'GET' && typeof body !== 'undefined') {
                    outgoing.write(body);
                }

                outgoing.end();

                this._activeRequests.add(options);
                this._requestStatus.set(options, 'running');

                let timeoutId: NodeJS.Timeout;
                if (typeof timeout === 'number' && timeout !== 0) {
                    timeoutId = setTimeout(() => {
                        outgoing.abort();
                    }, timeout);
                }
            });
        });
    }

    public async retry<T, U extends any[]>(limit: number, task: (...args: U) => Promise<T>, ...args: U): Promise<T> {
        let count = 0;
        while (true) {
            try {
                return await this.run(task, ...args);
            } catch (e) {
                count++;

                if (count === limit) {
                    throw e;
                }
            }
        }
    }
}

export function delay(time: number): Promise<void> {
    return new Promise<void>(resolve => {
        setTimeout(resolve, time);
    })
}
