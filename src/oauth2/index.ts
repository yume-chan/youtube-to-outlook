import fs from 'fs';
import { createServer } from 'http';
import { URL, URLSearchParams } from 'url';

import fetch from 'node-fetch';
import open from 'open';
import { url } from 'inspector';

export interface OAuth2AuthorizationCodeFlowConfig {
    clientId: string;

    scope: string[];

    redirectUri: string;

    authorizeEndpoint: string;

    authorizeParameters?: Record<string, string>;

    tokenEndpoint: string;

    tokenParameters?: Record<string, string>;
}

export interface OAuth2AuthorizationCodeFlowStore {
    accessToken: string;

    expireAt: number;

    refreshToken?: string;
}

export default class OAuth2AuthorizationCodeFlow {
    private _config: OAuth2AuthorizationCodeFlowConfig;

    private _storeFilePath: string;

    private _store: OAuth2AuthorizationCodeFlowStore | undefined;

    public constructor(config: OAuth2AuthorizationCodeFlowConfig, storeFilePath: string) {
        this._config = config;
        this._storeFilePath = storeFilePath;
    }

    private async setStore(response: any): Promise<void> {
        this._store = {
            accessToken: response['access_token'],
            expireAt: Date.now() + response['expires_in'] * 1000,
            refreshToken: response['refresh_token'],
        };

        await fs.promises.writeFile(this._storeFilePath, JSON.stringify(this._store, undefined, 2));
    }

    private async fetchAccessToken(code: string): Promise<void> {
        const response = await fetch(this._config.tokenEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                // rfc6749 4.1.3. Access Token Request
                grant_type: 'authorization_code',
                ...this._config.tokenParameters,
                code,
                redirect_uri: this._config.redirectUri,
                client_id: this._config.clientId,
            }).toString(),
        });
        const body = await response.json();

        if (response.status === 200) {
            await this.setStore(body);
        } else {
            throw new Error(body['error_description'] || body['error']);
        }
    }

    private authroize(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const redirectUri = new URL(this._config.redirectUri);

            const server = createServer((request, response) => {
                const url = new URL(`http://${request.headers['host']}${request.url}`);
                if (url.pathname !== redirectUri.pathname) {
                    response.writeHead(404).end();
                    return;
                }

                response.writeHead(200, 'OK', {
                    'Content-Type': 'text/html',
                }).end('<script>window.close()</script>');

                if (url.searchParams.has('error')) {
                    reject(new Error(url.searchParams.get('error_description') || url.searchParams.get('error')!));
                    return;
                }

                server.close();
                resolve(this.fetchAccessToken(url.searchParams.get('code')!));
            });
            server.listen(Number.parseInt(redirectUri.port || '80'), () => {
                open(`${
                    this._config.authorizeEndpoint
                    }?${
                    new URLSearchParams({
                        // rfc6749 4.1.1. Authroization Request
                        response_type: 'code',
                        ...this._config.authorizeParameters,
                        client_id: this._config.clientId,
                        scope: this._config.scope,
                        redirect_uri: this._config.redirectUri,
                    }).toString()
                    }`);
            });
        })
    }

    private async refreshToken(): Promise<void> {
        const response = await fetch(this._config.tokenEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                ...this._config.tokenParameters,
                client_id: this._config.clientId,
                scope: this._config.scope.join(' '),
                redirect_uri: this._config.redirectUri,
                refresh_token: this._store!.refreshToken,
            }).toString(),
        });
        const body = await response.json();

        if (response.status === 200) {
            await this.setStore(body);
        } else {
            throw new Error(body['error_description'] || body['error']);
        }
    }

    public async getAccessToken(mode: 'normal' | 'non-interactive' | 'ignore-store' = 'normal'): Promise<string> {
        if (mode !== 'ignore-store') {
            if (!this._store) {
                if (fs.existsSync(this._storeFilePath)) {
                    try {
                        const storeFile = await fs.promises.readFile(this._storeFilePath, 'utf8');
                        this._store = JSON.parse(storeFile);
                    } catch (e) {
                        // do nothing
                    }
                }
            }

            if (this._store) {
                const now = Date.now();
                if (now < this._store!.expireAt) {
                    return this._store!.accessToken;
                }

                try {
                    if (this._store!.refreshToken) {
                        await this.refreshToken();
                        return this._store!.accessToken;
                    }
                } catch (e) {
                    // do nothing
                }
            }

            if (mode === 'non-interactive') {
                throw new Error('interaction required');
            }
        }

        await this.authroize();
        return this._store!.accessToken;
    }
}
