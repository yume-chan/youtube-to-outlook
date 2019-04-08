import { AsyncDispatcher, HttpsRequestOptions, isHttpsRequestError } from "./async-dispatcher";
import { URLSearchParams } from "url";

export interface JsonRequestError<T> extends Error {
    statusCode?: number;
    statusMessage?: string;
    body: T;
}

export function isJsonRequestError<T>(value: unknown): value is JsonRequestError<T> {
    const error = value as JsonRequestError<T>;
    return typeof error === 'number' && typeof error !== 'undefined';
}

async function request<T>(dispatcher: AsyncDispatcher, options: HttpsRequestOptions): Promise<T> {
    try {
        const response = await dispatcher.request(options);
        return JSON.parse(response.toString('utf8')) as T;
    } catch (err) {
        if (isHttpsRequestError(err)) {
            const json = JSON.parse(err.body!.toString('utf8'));
            err.body = json;
        }

        throw err;
    }
}

function noBody<T>(
    method: string,
    dispatcher: AsyncDispatcher,
    options: HttpsRequestOptions,
    params: { [key: string]: string }
): Promise<T> {
    options = {
        ...options,
        method,
        path: `${options.path}?${new URLSearchParams(params || {}).toString()}`
    };

    return request<T>(dispatcher, options);
}

function hasBody<T>(
    method: string,
    dispatcher: AsyncDispatcher,
    options: HttpsRequestOptions,
    params: object
): Promise<T> {
    options = {
        ...options,
        method,
        headers: {
            ...options.headers || {},
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
    };

    return request<T>(dispatcher, options);
}

export default <T>(
    method: string,
    dispatcher: AsyncDispatcher,
    options: HttpsRequestOptions,
    params: any
): Promise<T> => {
    switch (method) {
        case 'GET':
            return noBody(method, dispatcher, options, params);
        case 'POST':
        case 'PUT':
        case 'PATCH':
            return hasBody(method, dispatcher, options, params);
        default:
            throw new Error(`unknown value for argument \`method\`, got ${method}`);
    }
}
