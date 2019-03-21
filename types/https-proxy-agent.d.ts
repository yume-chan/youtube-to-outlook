import { Agent } from 'https';

export default class HttpsProxyAgent extends Agent {
    constructor(url: string);
}
