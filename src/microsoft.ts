import { globalAgent, Agent } from 'https';
import { URL } from 'url';
import HttpsProxyAgent from 'https-proxy-agent';
import { OutgoingHttpHeaders } from 'http';
import { AsyncDispatcher } from './async-dispatcher';
import request, { isJsonRequestError } from './json-request';
import { deepMerge } from './util';

let accessToken: string;

let agent: Agent = globalAgent;

export function setProxy(value: string) {
    agent = new HttpsProxyAgent(value);
}

async function requestApi(
    dispatcher: AsyncDispatcher,
    method: string,
    path: string,
    params?: object
): Promise<any> {
    let headers: OutgoingHttpHeaders = {
        Authorization: `Bearer ${accessToken}`,
    };

    try {
        return await request(method, dispatcher, {
            host: 'graph.microsoft.com',
            path: `/v1.0${path}`,
            headers,
            agent,
            timeout: 60000,
        }, params);
    } catch (err) {
        if (isJsonRequestError<any>(err)) {
            err.message = err.body.error.message;
        }

        throw err;
    }
}

export function setAccessToken(value: string): void {
    accessToken = value;
}

export interface Calendar {
    id: string;
    name: string;
}

export interface Response<T> {
    ['@odata.nextLink']?: string;
    value: T;
}

interface CalendarViewDeltaResponse {
    ['@odata.nextLink']?: string;
    ['@odata.deltaLink']?: string;
    value: Delta<CalendarEvent>[];
}

export function listCalendars(dispathcer: AsyncDispatcher): Promise<Response<Calendar[]>> {
    return requestApi(dispathcer, 'GET', '/me/calendars', {});
}

interface ItemBody {
    content: string;
    contentType: 'text' | 'HTML';
}

interface DateTimeTimeZone {
    dateTime: string;
    timeZone: string;
}

export interface CalendarEvent {
    body: ItemBody;
    bodyPreview: string;
    id: string;
    end: DateTimeTimeZone;
    reminderMinutesBeforeStart: number;
    start: DateTimeTimeZone;
    recurrence: null;
    subject: string;
    type: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
}

type Delta<T> = Partial<T> & { id: string;['@removed']?: { reason: string } };

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

export async function getCalendarView(
    dispathcer: AsyncDispatcher,
    id: string,
    startDateTime: Date,
    endDateTime: Date
): Promise<CalendarEvent[]> {
    let data: Response<CalendarEvent[]> = await requestApi(dispathcer, 'GET', `/me/calendars/${id}/calendarView`, {
        startDateTime: startDateTime.toISOString(),
        endDateTime: endDateTime.toISOString(),
        $top: 1000,
    });

    const results: CalendarEvent[][] = [data.value];

    while (data['@odata.nextLink']) {
        data = await retry(() => requestApi(dispathcer, 'GET', getPath(data['@odata.nextLink']!)));
        results.push(data.value);
    }

    return ([] as CalendarEvent[]).concat.apply([], results);
}

export function createEvent(dispathcer: AsyncDispatcher, id: string, event: Partial<CalendarEvent>): Promise<CalendarEvent> {
    return requestApi(dispathcer, 'POST', `/me/calendars/${id}/events`, event);
}

export function updateEvent(dispathcer: AsyncDispatcher, id: string, event: Partial<CalendarEvent>): Promise<CalendarEvent> {
    return requestApi(dispathcer, 'PATCH', `/me/events/${id}`, event);
}

export function deleteEvent(dispathcer: AsyncDispatcher, id: string): Promise<void> {
    return requestApi(dispathcer, 'DELETE', `/me/events/${id}`, {});
}

function mergeEvents(events: { [id: string]: CalendarEvent }, delta: Delta<CalendarEvent>[]) {
    for (const item of delta) {
        if (item['@removed']) {
            delete events[item.id];
        } else {
            events[item.id] = deepMerge(events[item.id], item);
        }
    }
}

function getPath(url: string) {
    const parsed = new URL(url);
    return parsed.pathname.substring('/v1.0'.length) + parsed.search;
}

export async function getDeltaInitial(
    dispatcher: AsyncDispatcher,
    id: string,
    startDateTime: Date,
    endDateTime: Date,
    events: { [id: string]: CalendarEvent },
): Promise<string> {
    let data: CalendarViewDeltaResponse = await requestApi(dispatcher, 'GET', `/me/calendars/${id}/calendarView/delta`, {
        startDateTime: startDateTime.toISOString(),
        endDateTime: endDateTime.toISOString(),
    });
    mergeEvents(events, data.value);

    while (data['@odata.nextLink']) {
        data = await retry(() => requestApi(dispatcher, 'GET', getPath(data['@odata.nextLink']!)));
        mergeEvents(events, data.value);
    }

    return data['@odata.deltaLink']!;
}

export async function getDelta(
    dispatcher: AsyncDispatcher,
    deltaLink: string,
    events: { [id: string]: CalendarEvent }
): Promise<string> {
    let data: CalendarViewDeltaResponse = await requestApi(dispatcher, 'GET', getPath(deltaLink));
    mergeEvents(events, data.value);

    while (data['@odata.nextLink']) {
        data = await retry(() => requestApi(dispatcher, 'GET', getPath(data['@odata.nextLink']!)));
        mergeEvents(events, data.value);
    }

    return data['@odata.deltaLink']!;
}
