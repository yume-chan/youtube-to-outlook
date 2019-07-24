# YouTube to Outlook Calendar

A "does work" script that grabs YouTube Live Broadcast information (from past, now, and future) and puts into your Outlook Calendar.

I created this for my [vtuber-calendar](https://github.com/yume-chan/vtuber-calendar) project, as fully manually maintenance costs too much time.

- [YouTube to Outlook Calendar](#youtube-to-outlook-calendar)
  - [Configuration](#configuration)
    - [How to get the Google API Key?](#how-to-get-the-google-api-key)
    - [Note for YouTube Data API v3 Quota](#note-for-youtube-data-api-v3-quota)
    - [Want unlimited YouTube Data API v3 Quota?](#want-unlimited-youtube-data-api-v3-quota)
  - [Run](#run)

## Configuration

Create a file called `config` at the root directory, with any file extension that can be `import`ed, including `js`, `ts` and `json`.

In the config file, export an object that comforms to the `Config` interface defined in `src/config.ts`.

Here is a minimal example for `config.json`:

```json
{
    "googleApiKey": "<INSERT YOUR KEY HERE>",
    "youtubeChannels": [
        {
            "id": "UCn14Z641OthNps7vppBvZFA",
            "nickname": "千草はな"
        }
    ],
    "outlookCalendarName": "Vtuber"
}
```

(Yes, I'm a huge fan of Chigusa Hana, a kawaii virtual youtuber).

Check the comments in `src/config.ts` for detailed description.

### How to get the Google API Key?

Please google it.

### Note for YouTube Data API v3 Quota

New projects created nowadays only have 10,000 points of quota for YouTube Data API v3 per day.

When each `youtube.search.list` API call costs 100 points (for only 50 results) and each `youtube.video.list` API call costs 5 (or maybe any other number, I don't really care) points per video, it will blow up your quota limit very very quickly.

So use with your own judgement.

### Want unlimited YouTube Data API v3 Quota?

Luckily, I have found a way to abuse the API Key from Google API Explorer. It's very simple, and you will get literally INFINITE quota.

But I don't want to publish it here.

You may still reach the so called "per user quota", changing your IP address will "resolve" it.

## Run

1. Run

    ```shell
    npx ts-node src/index
    ```

    in your terminal.

2. A browser will open to let you sign into your Microsoft Account.
3. Sit back and pray that no errors will occur.

Yes, I love TypeScript, and I don't want compiling, so the awesome `ts-node` project is always my best saver.
