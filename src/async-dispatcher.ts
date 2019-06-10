import fetch, { Request } from 'node-fetch';

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

export interface HttpsRequestError extends Error {
    status?: number;
    statusText?: string;
    body?: Buffer;
}

export function isHttpsRequestError(value: unknown): value is HttpsRequestError {
    const error = value as HttpsRequestError;
    return typeof error.status === 'number' && typeof error.statusText !== 'undefined';
}

export class AsyncDispatcher {
    private _concurrency: number;
    public get concurrency(): number { return this._concurrency; }

    private _running: number = 0;

    private _semaphore: AsyncSemaphore = new AsyncSemaphore();

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

            for (let i = this._running; i < this._concurrency; i++) {
                this._semaphore.notify();
            }
        }
    }

    public async all<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
        return Promise.all(tasks.map(item => this.run(item)));
    }

    public async map<T, U>(values: T[], task: (item: T) => Promise<U>): Promise<U[]> {
        return Promise.all(values.map(item => this.run(task, item)));
    }

    public async request(request: Request): Promise<Buffer> {
        return this.run(async () => {
            const response = await fetch(request);
            if (response.status >= 200 && response.status < 300) {
                return response.buffer();
            } else {
                const error: HttpsRequestError = new Error(`${response.status} ${response.statusText}`);
                error.status = response.status;
                error.statusText = response.statusText;
                error.body = await response.buffer();
                throw error;
            }
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
