import { readFileSync } from 'fs';

import { AsyncDispatcher } from './async-dispatcher';
import { Calendar } from './calendar';
import * as MicrosoftGraph from './microsoft';

const MicrosoftAccessToken = readFileSync('./www/token.txt', 'utf-8').trim();

(async () => {
    MicrosoftGraph.setAccessToken(MicrosoftAccessToken);
    const dispatcher = new AsyncDispatcher();

    const calendars = await MicrosoftGraph.listCalendars(dispatcher);

    const calendarId = calendars.value.find(x => x.name === 'Vtuber')!.id;
    const calendar = await Calendar.open('test-calendar.json', calendarId);
    const startDateTime = new Date('2018-01-01T00:00:00Z');
    const endDateTime = new Date('2019-12-31T00:00:00Z');

    await MicrosoftGraph.getCalendarView(dispatcher, calendarId, startDateTime, endDateTime);
})();
