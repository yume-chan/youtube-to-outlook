import { readFileSync, writeFileSync } from 'fs';
import { Google } from "./google";
import * as MicrosoftGraph from './microsoft';
import * as Yaml from './yaml';
import config from '../config';

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

async function searchAll(params: Google.YouTubeDefinitions.SearchParameters) {
    let list: string[] = [];

    while (true) {
        const result = await Google.YouTube.search(params);
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

async function parallel(tasks: (() => Promise<any>)[], concurrency: number = 10): Promise<void> {
    while (tasks.length > 0) {
        await Promise.all(tasks.splice(0, concurrency).map(x => x()));
    }
}

function filterTitle(original: string) {
    return original
        .replace(/【(.*?)】/g, '')
        .replace(/\[.*?\]/g, '')
        .trim()
}

(async () => {
    if (typeof config.googleApiProxy === 'string') {
        Google.setProxy(config.googleApiProxy);
    }
    Google.setHeaders(config.googleApiHeaders);
    Google.setApiKey(config.googleApiKey);

    let details: Google.YouTubeDefinitions.VideoResponse[] = [];

    if (false) {
        let ids: string[] = [];
        await Promise.all(config.youtubeChannels.map(channel => {
            return Promise.all((['completed', 'live', 'upcoming'] as const).map(async eventType => {
                await retry(async () => {
                    const result = await searchAll({
                        part: ['id'],
                        channelId: channel.id,
                        type: 'video',
                        eventType,
                        order: "date",
                        maxResults: 50,
                    });

                    ids = ids.concat(result);
                });
            }));
        }));

        details = [];
        const tasks = [];
        const slice = Math.ceil(ids.length / 50);
        for (let i = 0; i < slice; i++) {
            tasks.push(retry(async () => {
                const result = await Google.YouTube.videos({
                    part: ['snippet', 'liveStreamingDetails'],
                    id: ids.slice(i * 50, (i + 1) * 50),
                });

                details = details.concat(result.items);
            }));
        }

        await Promise.all(tasks);

        writeFileSync('youtube.json', JSON.stringify(details, undefined, 4));
    } else {
        details = JSON.parse(readFileSync('youtube.json', 'utf-8'));
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

    const tasks: (() => Promise<unknown>)[] = [];

    let toProcess = view.slice();
    while (toProcess.length !== 0) {
        const item = toProcess[0];
        toProcess = toProcess.slice(1);

        const duplicates = view.filter(x => x !== item && x.subject === item.subject && x.start.dateTime === item.start.dateTime);
        toProcess = toProcess.filter(x => !duplicates.includes(x));
        view = view.filter(x => !duplicates.includes(x));

        for (const duplicate of duplicates) {
            console.log('deleting', duplicate.subject);
            tasks.push(() => MicrosoftGraph.deleteEvent(duplicate.id));
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
            if (x.body.content.includes(video.id)) {
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
            tasks.push(() => retry(() => MicrosoftGraph.createEvent(calendar.id, event)));
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
                event.body!.content.trim() === exist.bodyPreview.trim()) {
                continue;
            }

            console.log('updating ', event.subject);
            tasks.push(() => retry(() => MicrosoftGraph.updateEvent(exist.id, event)));
        }
    }

    await parallel(tasks);
})();
