import { readFileSync, writeFileSync, existsSync } from 'fs';

import { Google } from "./google";
import * as MicrosoftGraph from './microsoft';
import * as Yaml from './yaml';
import config from '../config';
import { stripHtml, EventBody, deepMerge } from './util';
import { AsyncDispatcher } from './async-dispatcher';
import { Calendar as CalendarView } from './calendar';

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

async function searchAll(dispatcher: AsyncDispatcher, params: Google.YouTubeDefinitions.SearchParameters) {
    let list: string[] = [];

    while (true) {
        const result = await retry(() => Google.YouTube.search(dispatcher, params));
        list = list.concat(result.items.map(x => x.id.videoId));

        if (!result.nextPageToken) {
            return list;
        }

        params.pageToken = result.nextPageToken;
    }
}

async function retry<T>(body: () => Promise<T>, max: number = Infinity): Promise<T> {
    let i = 0;
    while (true) {
        try {
            return await body();
        } catch (e) {
            i++;
            if (i === max) {
                console.error(`retry failed ${max} times with last error:`);
                console.error(e);
                throw e;
            }
        }
    }
}

export type PromiseResolverState = 'running' | 'resolved' | 'rejected';

export class PromiseResolver<T>{
    private _promise: Promise<T>;
    public get promise(): Promise<T> { return this._promise; }

    private _resolve!: (value?: T | PromiseLike<T>) => void;
    private _reject!: (reason?: any) => void;

    private _state: PromiseResolverState = 'running';
    public get state(): PromiseResolverState { return this._state; }

    public constructor() {
        this._promise = new Promise<T>((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    public resolve(value?: T | PromiseLike<T>): void {
        this._resolve(value);
        this._state = 'resolved';
    }

    public reject(reason?: any): void {
        this._reject(reason);
        this._state = 'rejected';
    }
}

function bail<T>(promises: Promise<T>[]): Promise<T[]> {
    let completed = 0;
    const results: T[] = [];
    const resolver = new PromiseResolver<T[]>();
    let set: Set<number> = new Set();
    for (let i = 0; i < promises.length; i++) {
        set.add(i);
        promises[i].then(result => {
            results[i] = result;
            completed++;
            console.log(`[bail] task no.${i + 1} completed`);
            console.log(`[bail] ${completed} of ${promises.length} tasks have completed`);

            if (completed === promises.length) {
                resolver.resolve(results);
                return;
            }

            set.delete(i);
            console.log(`[bail] tasks no.${Array.from(set).join(', ')} have not completed`);
        }, error => {
            console.warn(`[bail] bail out with error "${error.stack}"`);
            resolver.reject(error);
        });
    }
    return resolver.promise;
}

function filterTitle(original: string) {
    return original
        .replace(/【(.*?)】/g, '')
        .replace(/\[.*?\]/g, '')
        .trim()
}

function isInvalidVideo(video: Google.YouTubeDefinitions.VideoResponse): boolean {
    if (typeof video.liveStreamingDetails !== 'object' ||
        video.liveStreamingDetails === null) {
        return true;
    }

    if (typeof video.liveStreamingDetails.scheduledStartTime === 'undefined' &&
        typeof video.liveStreamingDetails.actualStartTime === 'undefined') {
        return true;
    }

    return false;
}

(async () => {
    const dispatcher: AsyncDispatcher = new AsyncDispatcher();
    // setInterval(() => {
    //     console.log(dispatcher.activeRequests.map(x => `${dispatcher.requestStatus.get(x)} ${x.path}`).join('\n'));
    // }, 10000);

    let tasks: Promise<any>[];
    const videos: Map<string, Google.YouTubeDefinitions.VideoResponse> = new Map();

    let publishedAfter: { [id: string]: Date } = {};
    for (const item of config.youtubeChannels) {
        publishedAfter[item.id] = new Date('1970-01-01T00:00:00Z');
    }

    const idSet: Set<string> = new Set();

    if (Array.isArray(config.extraVideoIds)) {
        for (const id of config.extraVideoIds) {
            idSet.add(id);
        }
    }

    if (typeof config.ignoreVideoIds === 'undefined') {
        config.ignoreVideoIds = [];
    }

    if (existsSync('youtube.json')) {
        const list = JSON.parse(readFileSync('youtube.json', 'utf-8'));

        for (const video of list) {
            if (config.ignoreVideoIds.includes(video.id)) {
                continue;
            }

            if (isInvalidVideo(video)) {
                console.warn("WTF it's not a live stream? " + video.id);
                continue;
            }

            const publishedAt = new Date(video.snippet.publishedAt);
            if (publishedAfter[video.snippet.channelId] < publishedAt) {
                // publishedAfter[video.snippet.channelId] = publishedAt;
            }

            videos.set(video.id, video);
            idSet.add(video.id);
        }

        console.log(`${idSet.size} known ids before searching`);
    }

    if (typeof config.googleApiProxy === 'string') {
        Google.setProxy(config.googleApiProxy);
    }

    let viewStart = addDays(new Date(), -1).getTime();
    let viewEnd = addDays(new Date(), 1).getTime();
    const videoToUpdate: Google.YouTubeDefinitions.VideoResponse[] = [];

    let mode: 'fetch' | 'cache' | 'none' = 'fetch' as 'fetch' | 'cache' | 'none';
    console.log(`mode is ${mode}`);

    switch (mode) {
        case 'fetch':
            Google.setHeaders(config.googleApiHeaders);
            Google.setApiKey(config.googleApiKey);

            tasks = config.youtubeChannels.reduce((result, channel) => {
                return result.concat(
                    (['completed', 'live', 'upcoming'] as const).map(async eventType => {
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
            }, [] as Promise<void>[]);

            await bail(tasks);
            console.log(`${idSet.size} known ids after searching`);

            tasks = [];
            const ids = Array.from(idSet);
            const pageSize = 50;
            for (let i = 0; i < ids.length; i += pageSize) {
                tasks.push(retry(async () => {
                    const result = await Google.YouTube.videos(dispatcher, {
                        part: ['snippet', 'liveStreamingDetails'],
                        id: ids.slice(i, i + pageSize),
                    });

                    for (const video of result.items) {
                        if (isInvalidVideo(video)) {
                            console.warn("WTF it's not a live stream? " + video.id);
                            continue;
                        }

                        if (videos.has(video.id)) {
                            const old = { ...videos.get(video.id)! };
                            delete old.etag;
                            delete video.etag;

                            // etag can be different even if other fields are the same.
                            // doing a deep equality test without etag field.
                            if (JSON.stringify(old) === JSON.stringify(video)) {
                                continue;
                            }
                        }

                        videoToUpdate.push(video);

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

                        videos.set(video.id, video);
                    }
                }));
            }

            await bail(tasks);

            writeFileSync('youtube.json', JSON.stringify(Array.from(videos.values()), undefined, 4));

            if (videoToUpdate.length === 0) {
                return;
            }
            break;
        case 'cache':
            for (const video of videos.values()) {
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

                videoToUpdate.push(video);
            }
            break;
    }

    if (typeof config.microsoftApiProxy === 'string') {
        MicrosoftGraph.setProxy(config.microsoftApiProxy);
    }
    MicrosoftGraph.setAccessToken(MicrosoftAccessToken);

    const calendarFile = 'calendar.json';
    let calendarView: CalendarView;
    if (existsSync(calendarFile)) {
        calendarView = await CalendarView.open(calendarFile, undefined);
    } else {
        const calendars = await MicrosoftGraph.listCalendars(dispatcher);
        const calendar = calendars.value.find(x => x.name === config.outlookCalendarName);

        if (typeof calendar === 'undefined') {
            throw new Error('cannot find an Outlook Calendar with name ' + config.outlookCalendarName);
        }

        calendarView = await CalendarView.open(calendarFile, calendar.id);
    }

    // const viewStartTime = addDays(new Date(viewStart), -1);
    // const viewEndTime = addDays(new Date(viewEnd), 1);
    // await calendarView.update(dispatcher, viewStartTime, viewEndTime);

    await retry(() => calendarView.getAll(dispatcher));

    let view = calendarView.getEvents();
    console.log(`got calendar view with ${view.length} events`);

    tasks = [];

    let toProcess = view.slice();
    while (toProcess.length !== 0) {
        const item = toProcess[0];
        toProcess = toProcess.slice(1);

        if (item.type === 'occurrence') {
            continue;
        }

        const duplicates = view.filter(x =>
            x.type !== 'occurrence' &&
            x !== item &&
            x.subject === item.subject &&
            x.start.dateTime === item.start.dateTime);
        toProcess = toProcess.filter(x => !duplicates.includes(x));
        view = view.filter(x => !duplicates.includes(x));

        for (const duplicate of duplicates) {
            console.log('deleting', duplicate.subject);
            tasks.push(retry(() => MicrosoftGraph.deleteEvent(dispatcher, duplicate.id)));
        }
    }

    const eventsById: Map<string, MicrosoftGraph.CalendarEvent> = new Map();
    const eventsByName: Map<string, MicrosoftGraph.CalendarEvent[]> = new Map();
    for (const event of view) {
        if (event.type === 'occurrence') {
            continue;
        }

        let [nickname, subject] = event.subject.split('-').map(x => x.trim());

        const alias = config.youtubeChannels.find(x => typeof x.alias !== 'undefined' && x.alias.includes(nickname));
        if (typeof alias !== 'undefined') {
            nickname = alias.nickname;
            event.subject = `${nickname} - ${subject}`;
            tasks.push(retry(() => MicrosoftGraph.updateEvent(dispatcher, event.id, { subject: event.subject })));
        }

        if (!event.body) {
            console.warn(`${event.subject} doesn't have body`);

            if (!eventsByName.has(nickname)) {
                eventsByName.set(nickname, []);
            }
            eventsByName.get(nickname)!.push(event);

            continue;
        }

        event.body.content = stripHtml(event.body.content);

        try {
            const body = Yaml.parse<EventBody>(event.body.content);

            if (typeof body.youtube_id === 'string') {
                eventsById.set(body.youtube_id, event);
                continue;
            }

            if (Array.isArray(body.references)) {
                const url = body.references.find(x => x.includes('youtube.com'));
                if (url) {
                    const parts = url.split('=');
                    const id = parts[parts.length - 1];
                    eventsById.set(id, event);
                    continue;
                }
            }

            if (Array.isArray(body.participants)) {
                let update = false;

                for (let i = 0; i < body.participants.length; i++) {
                    let nickname = body.participants[i];

                    const alias = config.youtubeChannels.find(x => typeof x.alias !== 'undefined' && x.alias.includes(nickname));
                    if (typeof alias !== 'undefined') {
                        body.participants[i] = alias.nickname;
                        update = true;
                    }
                }

                if (update) {
                    tasks.push(retry(() => MicrosoftGraph.updateEvent(dispatcher, event.id, {
                        body: {
                            content: Yaml.stringify(body),
                            contentType: 'text',
                        },
                    })));
                }
            }

            if (!eventsByName.has(nickname)) {
                eventsByName.set(nickname, []);
            }
            eventsByName.get(nickname)!.push(event);
        } catch (e) {
            console.error(`error parsing body for ${event.subject}`);
        }
    }

    for (const video of videoToUpdate) {
        const channel = config.youtubeChannels.find(x => x.id === video.snippet.channelId);
        if (typeof channel === 'undefined') {
            console.warn(`unknwon channel ${video.snippet.channelId}`);
            continue;
        }

        const channelName = channel.nickname;

        const title = video.snippet.title;
        const filtered = filterTitle(title);

        const startTime = video.liveStreamingDetails.actualStartTime ||
            video.liveStreamingDetails.scheduledStartTime;
        const startTimeValue = new Date(startTime).getTime();

        const endTime = video.liveStreamingDetails.actualEndTime ||
            video.liveStreamingDetails.scheduledEndTime ||
            (video.snippet.liveBroadcastContent === 'live'
                ? new Date().toISOString()
                : addHours(new Date(startTime), 1).toISOString());

        let exist: MicrosoftGraph.CalendarEvent | undefined;
        if (eventsById.has(video.id)) {
            exist = eventsById.get(video.id);
        } else if (eventsByName.has(channelName)) {
            exist = eventsByName.get(channelName)!.find(event => {
                const eventStartTime = new Date(event.start.dateTime + 'Z').getTime();
                return Math.abs(eventStartTime - startTimeValue) < 15 * 60 * 1000;
            });
        }

        const body: EventBody = {
            original_title: title,
            references: [`https://www.youtube.com/watch?v=${video.id}`],
            youtube_id: video.id,
        };

        const event: Partial<MicrosoftGraph.CalendarEvent> = {
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
                content: '',
                contentType: 'text',
            },
            recurrence: null,
            reminderMinutesBeforeStart: 5,
        };

        if (!exist) {
            console.log('creating ', event.subject);
            event.body!.content = Yaml.stringify(body);
            tasks.push(retry(() => MicrosoftGraph.createEvent(dispatcher, calendarView.calendarId, event)));
        } else {
            const data: EventBody = Yaml.parse(exist.body.content);
            if (data && data.original_title) {
                const old_filtered = filterTitle(data.original_title);
                if (exist.subject !== `${channelName} - ${old_filtered}`) {
                    event.subject = exist.subject;
                }
            }

            if (Array.isArray(data.references)) {
                let youtubeIdFound = false;
                data.references = data.references.filter(x => {
                    if (!x.includes('youtube.com/')) {
                        return true;
                    }

                    if (!youtubeIdFound) {
                        youtubeIdFound = true;
                        return true;
                    }

                    return false;
                })
            }

            event.body!.content = Yaml.stringify(deepMerge(data, body));

            if (event.subject === exist.subject &&
                new Date(event.start!.dateTime).getTime() === new Date(exist.start.dateTime + 'Z').getTime() &&
                new Date(event.end!.dateTime).getTime() === new Date(exist.end.dateTime + 'Z').getTime() &&
                event.body!.content.trim() === stripHtml(exist.body.content)) {
                continue;
            }

            if (exist.type === 'occurrence' || exist.type === 'exception') {
                tasks.push(retry(() => MicrosoftGraph.deleteEvent(dispatcher, exist!.id)));
                tasks.push(retry(() => MicrosoftGraph.createEvent(dispatcher, calendarView.calendarId, event)));
            } else {
                console.log(`updating ${video.id} ${event.subject}`);
                tasks.push(retry(() => MicrosoftGraph.updateEvent(dispatcher, exist!.id, event)));
            }
        }
    }

    await bail(tasks);

    console.log('done');
})();
