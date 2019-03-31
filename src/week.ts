import { readFileSync, writeFileSync } from 'fs';

import * as MicrosoftGraph from './microsoft';
import * as Yaml from './yaml';
import { stripHtml } from './util';

import config from '../config';

const MicrosoftAccessToken = readFileSync('./www/token.txt', 'utf-8').trim();

interface EventBody {
    original_title: string;
    participants: string[];
    references: string[];
}

(async () => {
    MicrosoftGraph.setAccessToken(MicrosoftAccessToken);

    const calendars = await MicrosoftGraph.listCalendars();
    const calendar = calendars.value.find(x => x.name === config.outlookCalendarName)!;

    const viewStartTime = new Date('2019-03-25T00:00:00+08:00');
    const viewEndTime = new Date('2019-03-31T00:00:00+08:00');

    const view = await MicrosoftGraph.getCalendarView(calendar.id, viewStartTime, viewEndTime);

    let list: { time: string; name: string; title: string, url?: string }[] = [];

    view.forEach((item) => {
        const [name, title] = item.subject.split('-').map(x => x.trim());
        const body = Yaml.parse<EventBody>(stripHtml(item.body.content));
        const url = body.references && body.references.find(x => x.includes('youtube.com'));
        list.push({ time: item.start.dateTime, name, title, url });
    });

    writeFileSync('week.csv', list.map(x => `${x.time},${x.name},${x.title || ''},${x.url || ''}`).join('\r\n'), 'utf8');

})();
