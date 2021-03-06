﻿import "reflect-metadata";

import { createConnection } from "typeorm";
import equal from 'fast-deep-equal';
import { PromiseResolver } from '@yume-chan/async-operation-manager';

import * as Yaml from './yaml';
import { Google } from "./google";
import * as MicrosoftGraph from './microsoft';
import config from '../config';
import { AsyncDispatcher } from './async-dispatcher';
import { EventBody, stripHtml, deepMerge } from './util';
import OAuth2AuthorizationCodeFlow from './oauth2';
import { Video } from "./entity/video";
import { Snippet } from "./entity/snippet";
import { LiveStreamingDetails } from "./entity/live-streaming-details";

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
            console.warn(e);

            i++;
            if (i === max) {
                console.error(`retried ${max} times but still failed`);
                throw e;
            }
        }
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
            // console.log(`[bail] task no.${i + 1} completed`);
            console.log(`[bail] ${completed} of ${promises.length} tasks have completed`);

            if (completed === promises.length) {
                resolver.resolve(results);
                return;
            }

            set.delete(i);
            // console.log(`[bail] tasks no.${Array.from(set).join(', ')} have not completed`);
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

export async function getCalendarViewSplit(
    dispatcher: AsyncDispatcher,
    id: string,
    startTime: Date,
    endTime: Date,
    split: number,
): Promise<MicrosoftGraph.CalendarEvent[]> {
    const start = startTime.getTime();
    const end = endTime.getTime();

    let result: Map<string, MicrosoftGraph.CalendarEvent> = new Map();

    for (let i = start; i < end; i += split) {
        for (const item of await MicrosoftGraph.getCalendarView(dispatcher, id, new Date(i), new Date(i + split))) {
            result.set(item.id, item);
        }
    }

    return Array.from(result.values());
}

(async () => {
    const dispatcher: AsyncDispatcher = new AsyncDispatcher();

    let tasks: Promise<any>[];
    const videos: Map<string, Video> = new Map();

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

    await createConnection();

    for (const video of await Video.find({ deleted: false })) {
        if (config.ignoreVideoIds.includes(video.id)) {
            continue;
        }

        const publishedAt = addDays(video.snippet.publishedAt, -30);
        if (publishedAfter[video.snippet.channelId] < publishedAt) {
            publishedAfter[video.snippet.channelId] = publishedAt;
        }

        videos.set(video.id, video);
        idSet.add(video.id);
    }
    console.log(`${idSet.size} known ids before searching`);

    if (typeof config.googleApiProxy === 'string') {
        Google.setProxy(config.googleApiProxy);
    }

    let viewStart = addDays(new Date(), -1).getTime();
    let viewEnd = addDays(new Date(), 1).getTime();
    const videoToUpdate: Video[] = [];

    const dataSource = config.youtubeDataSource || 'fetch';
    console.log(`dataSource is ${dataSource}`);

    switch (dataSource) {
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

                    for (const item of result.items) {
                        if (isInvalidVideo(item)) {
                            console.warn("WTF it's not a live stream? " + item.id);
                            continue;
                        }

                        let video: Video | undefined;
                        video = await Video.findOne({ id: item.id });
                        if (!video) {
                            video = new Video();
                            video.snippet = new Snippet();
                            video.liveStreamingDetails = new LiveStreamingDetails();
                        }

                        video.id = item.id;
                        video.deleted = false;

                        const snippet = video.snippet;
                        snippet.title = item.snippet.title;
                        snippet.channelId = item.snippet.channelId;
                        snippet.publishedAt = new Date(item.snippet.publishedAt);
                        snippet.liveBroadcastContent = item.snippet.liveBroadcastContent;

                        const liveStreamingDetails = video.liveStreamingDetails;
                        liveStreamingDetails.scheduledStartTime =
                            item.liveStreamingDetails.scheduledStartTime
                                ? new Date(item.liveStreamingDetails.scheduledStartTime)
                                : undefined;
                        liveStreamingDetails.scheduledEndTime =
                            item.liveStreamingDetails.scheduledEndTime
                                ? new Date(item.liveStreamingDetails.scheduledEndTime)
                                : undefined;
                        liveStreamingDetails.actualStartTime =
                            item.liveStreamingDetails.actualStartTime
                                ? new Date(item.liveStreamingDetails.actualStartTime)
                                : undefined;
                        liveStreamingDetails.actualEndTime =
                            item.liveStreamingDetails.actualEndTime
                                ? new Date(item.liveStreamingDetails.actualEndTime)
                                : undefined;

                        if (videos.has(video.id)) {
                            // do a deep equality test.
                            if (equal(videos.get(video.id), video)) {
                                continue;
                            }
                        }

                        await video.save();
                        videoToUpdate.push(video);

                        const eventTime = (
                            video.liveStreamingDetails.actualStartTime ||
                            video.liveStreamingDetails.scheduledStartTime!)
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

            if (videoToUpdate.length === 0) {
                return;
            }
            videoToUpdate.sort((a, b) => a.snippet.channelId < b.snippet.channelId ? -1 : a.id < b.id ? -1 : 1);
            break;
        case 'cache':
            for (const video of videos.values()) {
                const eventTime = (
                    video.liveStreamingDetails.actualStartTime ||
                    video.liveStreamingDetails.scheduledStartTime!)
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

    const oauth = new OAuth2AuthorizationCodeFlow({
        authorizeEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        clientId: 'afbfb2f7-9e80-4195-a199-7448b22bc8e2',
        redirectUri: 'http://localhost:3000/redirect',
        scope: ['offline_access', 'Calendars.ReadWrite'],
        tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    }, 'ms-auth.json');

    MicrosoftGraph.setAccessTokenProvider(() => {
        return oauth.getAccessToken();
    });

    const calendars = await MicrosoftGraph.listCalendars(dispatcher);
    const calendar = calendars.value.find(x => x.name === config.outlookCalendarName);

    if (typeof calendar === 'undefined') {
        throw new Error('cannot find an Outlook Calendar with name ' + config.outlookCalendarName);
    }

    let view = await retry(() => getCalendarViewSplit(dispatcher, calendar.id, new Date(viewStart), new Date(viewEnd), 1000 * 60 * 60 * 24 * 180));
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
            event.subject = `${alias.nickname}${subject ? ` - ${subject}` : ''}`;
            console.log(`rename ${nickname} to ${alias.nickname}`);
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
            // console.warn(`unknwon channel ${video.snippet.channelId}`);
            continue;
        }

        const channelName = channel.nickname;

        const title = video.snippet.title;
        const filtered = filterTitle(title);

        const startTime = video.liveStreamingDetails.actualStartTime?.toISOString() ??
            video.liveStreamingDetails.scheduledStartTime?.toISOString()!;
        const startTimeValue = new Date(startTime).getTime();

        const endTime = video.liveStreamingDetails.actualEndTime?.toISOString() ||
            video.liveStreamingDetails.scheduledEndTime?.toISOString() ||
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
            body: {
                content: '',
                contentType: 'text',
            },

            start: {
                dateTime: startTime,
                timeZone: 'UTC',
            },
            end: {
                dateTime: endTime,
                timeZone: 'UTC',
            },

            isReminderOn: false,
            reminderMinutesBeforeStart: 5,

            recurrence: null,

            subject: `${channelName} - ${filtered}`,
        };

        if (!exist) {
            console.log('creating ', event.subject);
            event.body!.content = Yaml.stringify(body);
            tasks.push(retry(() => MicrosoftGraph.createEvent(dispatcher, calendar.id, event)));
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
                tasks.push(retry(() => MicrosoftGraph.createEvent(dispatcher, calendar.id, event)));
            } else {
                console.log(`updating ${video.id} ${event.subject}`);
                tasks.push(retry(() => MicrosoftGraph.updateEvent(dispatcher, exist!.id, event)));
            }
        }
    }

    await bail(tasks);

    console.log('done');
})();
