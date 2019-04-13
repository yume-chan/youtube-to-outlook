import { globalAgent, Agent } from 'https';
import { URLSearchParams } from 'url';
import HttpsProxyAgent from 'https-proxy-agent';
import { OutgoingHttpHeaders } from 'http';
import { AsyncDispatcher } from './async-dispatcher';
import request, { isJsonRequestError } from './json-request';

let accessToken: string;

let agent: Agent = globalAgent;

export function setProxy(value: string) {
    agent = new HttpsProxyAgent(value);
}

async function requestApi(
    dispatcher: AsyncDispatcher,
    method: string,
    path: string,
    params: object
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
    value: T;
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

export interface Event {
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
): Promise<Event[]> {
    const data = await requestApi(dispathcer, 'GET', `/me/calendars/${id}/calendarView`, {
        startDateTime: startDateTime.toISOString(),
        endDateTime: endDateTime.toISOString(),
        $count: true,
        $top: 0,
    });

    const count: number = data['@odata.count'];
    // const tasks: Promise<Response<Event[]>>[] = [];
    const pageSize: number = 1000;

    let result: Event[] = [];
    for (let i = 0; i < count; i += pageSize) {
        const page = await retry(() => requestApi(dispathcer, 'GET', `/me/calendars/${id}/calendarView`, {
            startDateTime: startDateTime.toISOString(),
            endDateTime: endDateTime.toISOString(),
            $count: true,
            $top: pageSize,
            $skip: i,
        })) as Response<Event[]>;

        result = result.concat(page.value);
    }

    // const results = await Promise.all(tasks);

    // // keep order
    // return results.reduce<Event[]>((list, result) => list.concat(result.value), []);

    return result;
}

export function createEvent(dispathcer: AsyncDispatcher, id: string, event: Partial<Event>): Promise<Event> {
    return requestApi(dispathcer, 'POST', `/me/calendars/${id}/events`, event);
}

export function updateEvent(dispathcer: AsyncDispatcher, id: string, event: Partial<Event>): Promise<Event> {
    return requestApi(dispathcer, 'PATCH', `/me/events/${id}`, event);
}

export function deleteEvent(dispathcer: AsyncDispatcher, id: string): Promise<void> {
    return requestApi(dispathcer, 'DELETE', `/me/events/${id}`, {});
}
