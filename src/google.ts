import { request, globalAgent, Agent } from 'https';
import { URLSearchParams } from 'url';
import HttpsProxyAgent from 'https-proxy-agent';

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
            ? (params: Params) => Promise<Response>
            : Api<T[K]>);
    }

    type ApiDefinitions = {
        [api: string]: ApiDefinition<any, any> | ApiDefinitions;
    }

    const host = 'content.googleapis.com';

    function requestApi(path: string, params: object): Promise<any> {
        return new Promise((resolve, reject) => {
            const normalized: any = {};
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

            const search = new URLSearchParams({
                key: key,
                ...normalized,
            });

            const fullPath = `${path}?${search.toString()}`;

            request({
                hostname: host,
                path: fullPath,
                headers,
                agent: agent,
            }, (response) => {
                console.log(response.statusCode, response.statusMessage, fullPath);

                response.setEncoding('utf8');

                const responseBody: string[] = [];

                response.on('data', (chunk: string) => {
                    responseBody.push(chunk);
                });

                response.on('end', () => {
                    try {
                        const result = JSON.parse(responseBody.join(''));

                        if (response.statusCode !== 200) {
                            if (result.error.errors.find((x: any) => x.reason === 'quotaExceeded')) {
                                setTimeout(() => {
                                    requestApi(path, params).then(resolve, reject);
                                }, 1000);
                                return;
                            }

                            const message = result.error.message;
                            const error = new Error(message);
                            (error as any).response = result;
                            reject(error);
                            return;
                        }

                        resolve(result);
                    } catch (e) {
                        setTimeout(() => {
                            requestApi(path, params).then(resolve, reject);
                        }, 1000);
                    }
                });
            }).end();
        });
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
            maxResults?: number;
        }

        export interface VideoResponse {
            id: string;

            snippet: {
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
