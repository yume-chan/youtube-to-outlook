import { readFileSync, writeFileSync } from 'fs';

import * as MicrosoftGraph from './microsoft';
import * as Yaml from './yaml';
import { stripHtml, EventBody } from './util';

import config from '../config';
import { AsyncDispatcher } from './async-dispatcher';

const MicrosoftAccessToken = readFileSync('./www/token.txt', 'utf-8').trim();

(async () => {
    const dispatcher = new AsyncDispatcher();

    MicrosoftGraph.setAccessToken(MicrosoftAccessToken);

    const calendars = await MicrosoftGraph.listCalendars(dispatcher);
    const calendar = calendars.value.find(x => x.name === config.outlookCalendarName)!;

    const viewStartTime = new Date('2019-04-01T00:00:00+08:00');
    const viewEndTime = new Date('2019-04-08T00:00:00+08:00');

    const view = await MicrosoftGraph.getCalendarView(dispatcher, calendar.id, viewStartTime, viewEndTime);

    let list: { time: string; name: string; title: string, url?: string }[] = [];

    view.forEach((item) => {
        const [name, title] = item.subject.split('-').map(x => x.trim());
        const body = Yaml.parse<EventBody>(stripHtml(item.body.content));
        const url = body.references && body.references.find(x => x.includes('youtube.com'));
        list.push({ time: item.start.dateTime, name, title, url });
    });

    writeFileSync('week.csv', list.map(x => `${x.time},${x.name},${x.title || ''},${x.url || ''}`).join('\r\n'), 'utf8');
})();
