import { request, globalAgent, Agent } from 'https';
import { URLSearchParams } from 'url';
import HttpsProxyAgent from 'https-proxy-agent';

let accessToken: string;

let agent: Agent = globalAgent;

export function setProxy(value: string) {
    agent = new HttpsProxyAgent(value);
}

function requestApi(method: string, path: string, params: object): Promise<any> {
    return new Promise((resolve, reject) => {
        let fullPath = `/v1.0${path}`;
        if (method === 'GET') {
            fullPath += `?${new URLSearchParams(params as any)}`;
        }

        let headers: any = {
            Authorization: `Bearer ${accessToken}`,
        };
        if (method !== 'GET') {
            headers['Content-Type'] = 'application/json';
        }

        const req = request({
            method,
            host: 'graph.microsoft.com',
            path: fullPath,
            headers: headers,
            timeout: 10000,
            agent,
        }, (response) => {
            console.log(response.statusCode, response.statusMessage, fullPath);

            response.setEncoding('utf8');

            const responseBody: string[] = [];

            response.on('data', (chunk: string) => {
                responseBody.push(chunk);
            });

            response.on('end', () => {
                try {
                    let result;

                    if (responseBody.length !== 0) {
                        result = JSON.parse(responseBody.join(''));
                    }

                    if (response.statusCode! < 200 ||
                        response.statusCode! >= 300) {
                        const message = result.error.message;
                        const error = new Error(message);
                        (error as any).response = result;
                        reject(error);
                        return;
                    }

                    resolve(result);
                } catch (e) {
                    requestApi(method, path, params).then(resolve, reject);
                }
            });
        }).on('timeout', () => {
            req.abort();
        });

        req.end(method !== 'GET' ? JSON.stringify(params) : undefined);
    });
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

export function listCalendars(): Promise<Response<Calendar[]>> {
    return requestApi('GET', '/me/calendars', {});
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
    subject: string;
}

export async function getCalendarView(id: string, startDateTime: Date, endDateTime: Date): Promise<Event[]> {
    const result = await requestApi('GET', `/me/calendars/${id}/calendarView`, {
        startDateTime: startDateTime.toISOString(),
        endDateTime: endDateTime.toISOString(),
        $count: true,
        $top: 0,
    });

    const count = result['@odata.count'];
    const tasks: Promise<Response<Event[]>>[] = [];
    for (let i = 0; i < count; i += 1000) {
        tasks.push(requestApi('GET', `/me/calendars/${id}/calendarView`, {
            startDateTime: startDateTime.toISOString(),
            endDateTime: endDateTime.toISOString(),
            $count: true,
            $top: 1000,
            $skip: i,
        }));
    }
    const results = await Promise.all(tasks);

    // keep order
    return results.reduce<Event[]>((list, result) => list.concat(result.value), []);
}

export function createEvent(id: string, event: Partial<Event>): Promise<Event> {
    return requestApi('POST', `/me/calendars/${id}/events`, event);
}

export function updateEvent(id: string, event: Partial<Event>): Promise<Event> {
    return requestApi('PATCH', `/me/events/${id}`, event);
}

export function deleteEvent(id: string): Promise<void> {
    return requestApi('DELETE', `/me/events/${id}`, {});
}
