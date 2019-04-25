export default interface Config {
    /**
     * Your Google API Key that can access YouTube Data API v3.
     */
    googleApiKey: string;

    /**
     * If you have set an HTTP referer restriction to your API Key,
     * add a `referer` header here.
     */
    googleApiHeaders?: { [key: string]: string };

    /**
     * The HTTP Proxy to be used for calling Google API.
     */
    googleApiProxy?: string;

    /**
     * The array of channels that you are interested.
     * You can get the `id` field from channel's URL.
     * The `nickname` field will be used in your Outlook Calender.
     */
    youtubeChannels: {
        id: string;
        nickname: string;
    }[];

    extraVideoIds?: string[];

    ignoreVideoIds?: string[];

    /**
     * The calendar name you want the events to go.
     * Your Microsoft Account must have write access.
     * Must exsit, case-sensitive.
     */
    outlookCalendarName: string;

    /**
     * The HTTP Proxy to be used for calling Microsoft Graph API.
     */
    microsoftApiProxy?: string;
}
