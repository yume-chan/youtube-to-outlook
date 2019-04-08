import { globalAgent, Agent } from 'https';
import HttpsProxyAgent from 'https-proxy-agent';
import { randomBytes } from 'crypto';
import { AsyncDispatcher, delay } from './async-dispatcher';
import request, { isJsonRequestError } from './json-request';

export namespace Google {
    let key: string;

    export function setApiKey(value: string) {
        key = value;
    }

    let agent: Agent = globalAgent;

    export function setProxy(value: string) {
        agent = new HttpsProxyAgent(value);
    }

    let headers: any;

    export function setHeaders(value: any) {
        headers = value;
    }

    interface ApiDefinition<Params, Response> {
        _isApiDefinition: true;

        _params: Params;
        _response: Response;
    }

    function createApiDefinition<Params, Response>(): ApiDefinition<Params, Response> {
        return { _isApiDefinition: true } as ApiDefinition<Params, Response>;
    }

    type Api<T> = {
        [K in keyof T]: (T[K] extends ApiDefinition<infer Params, infer Response>
            ? (dispathcer: AsyncDispatcher, params: Params) => Promise<Response>
            : Api<T[K]>);
    }

    type ApiDefinitions = {
        [api: string]: ApiDefinition<any, any> | ApiDefinitions;
    }

    interface Response {
        error: {
            errors: {
                reason: string,
            }[],
        },
    }

    const host = 'content.googleapis.com';

    async function requestApi(path: string, dispatcher: AsyncDispatcher, params: object): Promise<any> {
        const normalized: any = {
            key: key,
            quotaUser: randomBytes(20).toString('hex'),
        };

        for (const [key, value] of Object.entries(params)) {
            switch (typeof value) {
                case 'undefined':
                    break;
                case 'object':
                    if (value === null) {
                        break;
                    }

                    if (Array.isArray(value)) {
                        normalized[key] = value.join(',');
                        break;
                    }

                    throw new Error('incorrect params ' + key);
                case 'function':
                    throw new Error('incorrect params ' + key);
                default:
                    normalized[key] = value.toString();
            }
        }

        try {
            const result = await request<any>('GET', dispatcher, {
                host,
                path,
                headers,
                agent,
                timeout: 10000,
            }, normalized);

            return result;
        }
        catch (err) {
            if (isJsonRequestError<Response>(err) &&
                err.body.error.errors.find(x => x.reason === 'quotaExceeded')) {
                await delay(2000);
                return await requestApi(path, dispatcher, params);
            }

            throw err;
        }
    }

    function createApi<T extends ApiDefinitions>(definitions: T, base: string): Api<T> {
        const result: any = {};
        for (const [key, value] of Object.entries(definitions)) {
            if ('_isApiDefinition' in value) {
                result[key] = requestApi.bind(undefined, `${base}/${key}`);
            } else {
                result[key] = createApi(value, `${base}/${key}`);
            }
        }
        return result;
    }

    interface List<T> {
        prevPageToken?: string;
        nextPageToken?: string;
        items: T[];
    }

    type SingleOrMultiple<T> = T | T[];

    export namespace YouTubeDefinitions {
        export interface SearchParameters {
            part: SingleOrMultiple<'snippet' | 'id'>;
            channelId: string;
            type: 'video';
            pageToken?: string;
            eventType?: 'completed' | 'live' | 'upcoming';
            order?: 'date';
            publishedAfter?: string;
            maxResults?: number;
        }

        export interface VideoResponse {
            id: string;

            snippet: {
                publishedAt: string;
                channelId: string;
                title: string;
                liveBroadcastContent: 'none' | 'live' | 'upcoming';
            };

            liveStreamingDetails: {
                actualStartTime: string;
                actualEndTime: string;
                scheduledStartTime: string;
                scheduledEndTime: string;
            }
        }

        export const base = '/youtube/v3';
        export const definitions = {
            search: createApiDefinition<SearchParameters, List<{ id: { videoId: string } }>>(),
            videos: createApiDefinition<{
                part: SingleOrMultiple<'snippet' | 'contentDetails' | 'liveStreamingDetails'>,
                id: SingleOrMultiple<string>,
            }, List<VideoResponse>>(),
        };
    }

    export const YouTube = createApi(YouTubeDefinitions.definitions, YouTubeDefinitions.base);
}
