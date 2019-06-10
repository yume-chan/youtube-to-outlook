import { readFileSync } from 'fs';

import { AsyncDispatcher } from './async-dispatcher';
import { Calendar } from './calendar';
import * as MicrosoftGraph from './microsoft';

const MicrosoftAccessToken = readFileSync('./www/token.txt', 'utf-8').trim();

(async () => {
    MicrosoftGraph.setAccessToken(MicrosoftAccessToken);

    const calendarId = 'AQMkADAwATMwMAItYjA1OS1lNzU4LTAwAi0wMAoARgAAA7hCBmolaJJAnmVrGmzj-uYHAKOeG3ezB8FFsTidUPunJqMAAAIBBgAAAKOeG3ezB8FFsTidUPunJqMAAAJgjAAAAA==';
    const calendar = await Calendar.open('test-calendar.json', calendarId);
    const dispatcher = new AsyncDispatcher();
    const startDateTime = new Date('2019-01-01T00:00:00Z');
    const endDateTime = new Date('2019-12-31T00:00:00Z');

    await calendar.update(dispatcher, startDateTime, endDateTime);

    // console.log('update');

    // await calendar.update(dispatcher, startDateTime, endDateTime);
    // await calendar.getAll(dispatcher);
})();
