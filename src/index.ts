import { readFileSync, writeFileSync, existsSync } from 'fs';

import { Google } from "./google";
import * as MicrosoftGraph from './microsoft';
import * as Yaml from './yaml';
import config from '../config';
import { stripHtml } from './util';

const MicrosoftAccessToken = readFileSync('./www/token.txt', 'utf-8').trim();

function addSeconds(date: Date, value: number): Date {
    return new Date(date.getTime() + value * 1000);
}

function addMinutes(date: Date, value: number): Date {
    return addSeconds(date, value * 60);
}

function addHours(date: Date, value: number): Date {
    return addMinutes(date, value * 60);
}

function addDays(date: Date, value: number): Date {
    return addHours(date, value * 24);
}

function detailType(value: any) {
    switch (typeof value) {
        case 'object':
            if (value === null) {
                return 'null';
            }
            if (Array.isArray(value)) {
                return 'array';
            }
            return 'object';
        default:
            return typeof value;
    }
}

function deepMerge(...args: any[]): any {
    args = args.filter(x => typeof x !== 'undefined' && x !== null);

    const keySet: Set<string> = new Set();
    for (const arg of args) {
        for (const key of Object.keys(arg)) {
            keySet.add(key);
        }
    }

    const keys = Array.from(keySet);
    keys.sort();

    const result: any = {};
    for (const key of keys) {
        let type: string | undefined;
        for (const arg of args) {
            const thisType = detailType(arg[key]);
            if (thisType === 'undefined') {
                if (Object.prototype.hasOwnProperty.call(arg, key)) {
                    delete result[key];
                }
                continue;
            }

            if (type !== undefined) {
                if (thisType !== type) {
                    throw new TypeError();
                }
            }

            type = thisType;
            if (type === 'array') {
                if (Array.isArray(result[key])) {
                    const set = new Set();
                    for (const item of result[key]) {
                        set.add(item);
                    }
                    for (const item of arg[key]) {
                        set.add(item);
                    }
                    const list = Array.from(set);
                    list.sort();
                    result[key] = list;
                    continue;
                }
            }

            if (type === 'object') {
                result[key] = deepMerge(result[key], arg[key]);
            }

            result[key] = arg[key];
        }
    }

    return result;
}

async function searchAll(dispatcher: AsyncDispatcher, params: Google.YouTubeDefinitions.SearchParameters) {
    let list: string[] = [];

    while (true) {
        const result = await retry(() => dispatcher.run(() => Google.YouTube.search(params)));
        list = list.concat(result.items.map(x => x.id.videoId));

        if (!result.nextPageToken) {
            return list;
        }

        params.pageToken = result.nextPageToken;
    }
}

async function retry<T>(body: () => Promise<T>, max: number = 10): Promise<T> {
    let i = 0;
    while (true) {
        try {
            return await body();
        } catch (e) {
            i++;
            if (i === max) {
                throw e;
            }
        }
    }
}

function filterTitle(original: string) {
    return original
        .replace(/【(.*?)】/g, '')
        .replace(/\[.*?\]/g, '')
        .trim()
}

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

class AsyncDispatcher {
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
            this._semaphore.notify();
        }
    }

    public async all<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
        return Promise.all(tasks.map(item => this.run(item)));
    }

    public async map<T, U>(values: T[], task: (item: T) => Promise<U>): Promise<U[]> {
        return Promise.all(values.map(item => this.run(task, item)));
    }
}

(async () => {
    const dispatcher: AsyncDispatcher = new AsyncDispatcher();

    let details: Google.YouTubeDefinitions.VideoResponse[] = [];

    let publishedAfter: { [id: string]: Date } = {};
    for (const item of config.youtubeChannels) {
        publishedAfter[item.id] = new Date('1970-01-01T00:00:00Z');
    }

    const idSet: Set<string> = new Set();

    if (existsSync('youtube.json')) {
        details = JSON.parse(readFileSync('youtube.json', 'utf-8'));

        for (const item of details) {
            const publishedAt = new Date(item.snippet.publishedAt);
            if (publishedAfter[item.snippet.channelId] < publishedAt) {
                publishedAfter[item.snippet.channelId] = publishedAt;
            }

            idSet.add(item.id);
        }

        console.log(`${idSet.size} known ids before searching`);
    }

    if (typeof config.googleApiProxy === 'string') {
        Google.setProxy(config.googleApiProxy);
    }

    if (true) {
        Google.setHeaders(config.googleApiHeaders);
        Google.setApiKey(config.googleApiKey);

        await Promise.all(config.youtubeChannels.map(channel => {
            return Promise.all((['completed', 'live', 'upcoming'] as const).map(async eventType => {
                const result = await searchAll(dispatcher, {
                    part: ['id'],
                    channelId: channel.id,
                    type: 'video',
                    eventType,
                    order: "date",
                    publishedAfter: publishedAfter[channel.id].toISOString(),
                    maxResults: 50,
                });

                for (const item of result) {
                    idSet.add(item);
                }
            }));
        }));

        console.log(`${idSet.size} known ids after searching`);

        details = [];
        const tasks: Promise<void>[] = [];

        const ids = Array.from(idSet);
        const slice = Math.ceil(ids.length / 50);
        for (let i = 0; i < slice; i++) {
            tasks.push(retry(() => dispatcher.run(async () => {
                const result = await Google.YouTube.videos({
                    part: ['snippet', 'liveStreamingDetails'],
                    id: ids.slice(i * 50, (i + 1) * 50),
                });

                details = details.concat(result.items);
            })));
        }

        await Promise.all(tasks);

        writeFileSync('youtube.json', JSON.stringify(details, undefined, 4));
    }

    if (details.length === 0) {
        return;
    }

    let viewStart = Infinity;
    let viewEnd = 0;

    for (const video of details) {
        const eventTime = new Date(
            video.liveStreamingDetails.actualStartTime ||
            video.liveStreamingDetails.scheduledStartTime)
            .getTime();

        if (eventTime < viewStart) {
            viewStart = eventTime;
        }

        if (eventTime > viewEnd) {
            viewEnd = eventTime;
        }
    }

    if (typeof config.microsoftApiProxy === 'string') {
        MicrosoftGraph.setProxy(config.microsoftApiProxy);
    }
    MicrosoftGraph.setAccessToken(MicrosoftAccessToken);

    const calendars = await MicrosoftGraph.listCalendars();
    const calendar = calendars.value.find(x => x.name === config.outlookCalendarName);

    if (typeof calendar === 'undefined') {
        throw new Error('cannot find an Outlook Calendar with name ' + config.outlookCalendarName);
    }

    const viewStartTime = addDays(new Date(viewStart), -1);
    const viewEndTime = addDays(new Date(viewEnd), 1);

    let view = await MicrosoftGraph.getCalendarView(calendar.id, viewStartTime, viewEndTime);

    const tasks: Promise<unknown>[] = [];

    let toProcess = view.slice();
    while (toProcess.length !== 0) {
        const item = toProcess[0];
        toProcess = toProcess.slice(1);

        const duplicates = view.filter(x => x !== item && x.subject === item.subject && x.start.dateTime === item.start.dateTime);
        toProcess = toProcess.filter(x => !duplicates.includes(x));
        view = view.filter(x => !duplicates.includes(x));

        for (const duplicate of duplicates) {
            console.log('deleting', duplicate.subject);
            tasks.push(dispatcher.run(() => MicrosoftGraph.deleteEvent(duplicate.id)));
        }
    }

    for (const video of details) {
        const channelName = config.youtubeChannels.find(x => x.id === video.snippet.channelId)!.nickname;

        const title = video.snippet.title;
        const filtered = filterTitle(title);

        const startTime = video.liveStreamingDetails.actualStartTime ||
            video.liveStreamingDetails.scheduledStartTime;

        const endTime = video.liveStreamingDetails.actualEndTime ||
            video.liveStreamingDetails.scheduledEndTime ||
            (video.snippet.liveBroadcastContent === 'live'
                ? new Date().toISOString()
                : addHours(new Date(startTime), 1).toISOString());

        const exist = view.find((x): boolean => {
            if (stripHtml(x.body.content).includes(video.id)) {
                return true;
            }

            const xStartTime = new Date(x.start.dateTime + 'Z').getTime();
            if (x.subject.startsWith(channelName) &&
                Math.abs(xStartTime - new Date(startTime).getTime()) < 10 * 60 * 1000) {
                return true;
            }

            return false;
        });

        const event: Partial<MicrosoftGraph.Event> = {
            subject: `${channelName} - ${filtered}`,
            start: {
                dateTime: startTime,
                timeZone: 'UTC',
            },
            end: {
                dateTime: endTime,
                timeZone: 'UTC',
            },
            body: {
                content: Yaml.stringify({
                    original_title: title,
                    references: [`https://www.youtube.com/watch?v=${video.id}`],
                }),
                contentType: 'text',
            },
            reminderMinutesBeforeStart: 5,
        };

        if (!exist) {
            console.log('creating ', event.subject);
            tasks.push(retry(() => dispatcher.run(() => MicrosoftGraph.createEvent(calendar.id, event))));
        } else {
            const data: any = Yaml.parse(exist.bodyPreview);
            if (data && data.title) {
                const old_filtered = filterTitle(data.title);
                if (exist.subject !== `${channelName} - ${old_filtered}`) {
                    event.subject = exist.subject;
                }
            }

            event.body!.content = Yaml.stringify(deepMerge(data, {
                original_title: title,
                references: [`https://www.youtube.com/watch?v=${video.id}`],
            }));

            if (event.subject === exist.subject &&
                new Date(event.start!.dateTime).getTime() === new Date(exist.start.dateTime + 'Z').getTime() &&
                new Date(event.end!.dateTime).getTime() === new Date(exist.end.dateTime + 'Z').getTime() &&
                event.body!.content.trim() === stripHtml(exist.body.content)) {
                continue;
            }

            console.log('updating ', event.subject);
            tasks.push(retry(() => dispatcher.run(() => MicrosoftGraph.updateEvent(exist.id, event))));
        }
    }

    await Promise.all(tasks);
})();
