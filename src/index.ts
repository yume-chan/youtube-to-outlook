import { readFileSync, writeFileSync, existsSync } from 'fs';

import { Google } from "./google";
import * as MicrosoftGraph from './microsoft';
import * as Yaml from './yaml';
import config from '../config';
import { stripHtml, EventBody } from './util';
import { AsyncDispatcher } from './async-dispatcher';

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
        const result = await retry(() => Google.YouTube.search(dispatcher, params));
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

(async () => {
    const dispatcher: AsyncDispatcher = new AsyncDispatcher();

    let tasks: Promise<any>[];
    setInterval(() => {
        console.log(dispatcher.activeRequests.map(x => `${dispatcher.requestStatus.get(x)} ${x.path}`).join('\n'));
    }, 10000);

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
                // publishedAfter[item.snippet.channelId] = publishedAt;
            }

            idSet.add(item.id);
        }

        console.log(`${idSet.size} known ids before searching`);
    }

    if (typeof config.googleApiProxy === 'string') {
        Google.setProxy(config.googleApiProxy);
    }

    if (false) {
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

        await Promise.all(tasks);

        console.log(`${idSet.size} known ids after searching`);

        details = [];

        const ids = Array.from(idSet);
        const slice = Math.ceil(ids.length / 50);
        for (let i = 0; i < slice; i++) {
            tasks.push(retry(async () => {
                const result = await Google.YouTube.videos(dispatcher, {
                    part: ['snippet', 'liveStreamingDetails'],
                    id: ids.slice(i * 50, (i + 1) * 50),
                });

                details = details.concat(result.items);
            }));
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

    const calendars = await MicrosoftGraph.listCalendars(dispatcher);
    const calendar = calendars.value.find(x => x.name === config.outlookCalendarName);

    if (typeof calendar === 'undefined') {
        throw new Error('cannot find an Outlook Calendar with name ' + config.outlookCalendarName);
    }

    const viewStartTime = addDays(new Date(viewStart), -1);
    const viewEndTime = addDays(new Date(viewEnd), 1);

    let view = await MicrosoftGraph.getCalendarView(dispatcher, calendar.id, viewStartTime, viewEndTime);

    tasks = [];
    // let toProcess = view.slice();
    // while (toProcess.length !== 0) {
    //     const item = toProcess[0];
    //     toProcess = toProcess.slice(1);

    //     const duplicates = view.filter(x => x !== item && x.subject === item.subject && x.start.dateTime === item.start.dateTime);
    //     toProcess = toProcess.filter(x => !duplicates.includes(x));
    //     view = view.filter(x => !duplicates.includes(x));

    //     for (const duplicate of duplicates) {
    //         console.log('deleting', duplicate.subject);
    //         tasks.push(dispatcher.run(() => MicrosoftGraph.deleteEvent(duplicate.id)));
    //     }
    // }

    const eventsById: Map<string, MicrosoftGraph.Event> = new Map();
    const eventsByName: Map<string, MicrosoftGraph.Event[]> = new Map();
    for (const event of view) {
        event.body.content = stripHtml(event.body.content);
        const body = Yaml.parse<EventBody>(event.body.content);
        if (Array.isArray(body.references)) {
            const url = body.references.find(x => x.includes('youtube.com'));
            if (url) {
                const parts = url.split('=');
                const id = parts[parts.length - 1];
                eventsById.set(id, event);
            }
        }

        const name = event.subject.split('-').map(x => x.trim())[0];
        if (!eventsByName.has(name)) {
            eventsByName.set(name, []);
        }
        eventsByName.get(name)!.push(event);
    }

    for (const video of details) {
        const channelName = config.youtubeChannels.find(x => x.id === video.snippet.channelId)!.nickname;

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

        let exist: MicrosoftGraph.Event | undefined;
        if (eventsById.has(video.id)) {
            exist = eventsById.get(video.id);
        } else if (eventsByName.has(channelName)) {
            exist = eventsByName.get(channelName)!.find(event => {
                const eventStartTime = new Date(event.start.dateTime + 'Z').getTime();
                return Math.abs(eventStartTime - startTimeValue) < 15 * 60 * 1000;
            });
        }

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
            recurrence: null,
            reminderMinutesBeforeStart: 5,
        };

        if (!exist) {
            console.log('creating ', event.subject);
            tasks.push(retry(() => MicrosoftGraph.createEvent(dispatcher, calendar.id, event)));
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

            if (exist.type === 'occurrence' || exist.type === 'exception') {
                tasks.push(retry(() => MicrosoftGraph.deleteEvent(dispatcher, exist!.id)));
                tasks.push(retry(() => MicrosoftGraph.createEvent(dispatcher, calendar.id, event)));
            } else {
                console.log('updating ', event.subject);
                tasks.push(retry(() => MicrosoftGraph.updateEvent(dispatcher, exist!.id, event)));
            }
        }
    }

    await Promise.all(tasks);

    console.log('done');
})();
