import { promises as fs, existsSync } from 'fs';
import { CalendarEvent, getDeltaInitial, getDelta, getCalendarView } from "./microsoft";
import { AsyncDispatcher } from "./async-dispatcher";

interface CalendarSlice {
    startDateTime: Date;
    endDateTime: Date;
    deltaLink: string;
}

interface CalendarFile {
    calendarId: string;
    sliceDuration: number;
    slices: CalendarSlice[];
    events: { [id: string]: CalendarEvent };
}

function compare(a: any, b: any) {
    if (a < b)
        return -1;

    if (a === b)
        return 0;

    return 1;
}

function sortObject(input: any) {
    if (typeof input !== "object" || input === null)
        return input;

    if (input instanceof Date) {
        return input;
    }

    const keys = Object.keys(input).sort(compare);
    const output: any = {};
    for (const key of keys) {
        let value = input[key];
        if (Array.isArray(value))
            for (const index in value)
                value[parseInt(index)] = sortObject(value[index]);
        else if (typeof value === "object")
            value = sortObject(value);
        output[key] = value;
    }
    return output;
}

export class Calendar {
    public static async open(path: string, calendarId?: string, sliceDuration: number = 30 * 24 * 60 * 60 * 1000): Promise<Calendar> {
        if (existsSync(path)) {
            const file = JSON.parse(await fs.readFile(path, 'utf8')) as CalendarFile;
            for (const item of file.slices) {
                item.startDateTime = new Date(item.startDateTime);
                item.endDateTime = new Date(item.endDateTime);
            }
            return new Calendar(file.calendarId, file.sliceDuration, file.slices, file.events, path);
        }

        if (typeof calendarId !== 'string') {
            throw new TypeError('calendarId is required');
        }

        return new Calendar(calendarId, sliceDuration, [], {}, path);
    }

    private _calendarId: string;
    public get calendarId(): string { return this._calendarId; }

    private _sliceDuration: number;

    private _slices: CalendarSlice[] = [];

    private _path: string;

    private _events: { [id: string]: CalendarEvent };

    private constructor(
        calendarId: string,
        sliceDuration: number,
        slices: CalendarSlice[],
        events: { [id: string]: CalendarEvent },
        path: string
    ) {
        this._calendarId = calendarId;
        this._sliceDuration = sliceDuration;
        this._slices = slices;
        this._events = events;
        this._path = path;
    }

    private async save(): Promise<void> {
        const file: CalendarFile = {
            calendarId: this._calendarId,
            sliceDuration: this._sliceDuration,
            slices: this._slices,
            events: this._events,
        };
        const content = JSON.stringify(sortObject(file), undefined, 4);
        await fs.writeFile(this._path, content);
    }

    public async update(dispatcher: AsyncDispatcher, startDateTime: Date, endDateTime: Date): Promise<void> {
        let start = startDateTime.getTime();
        let end = endDateTime.getTime();

        start -= start % this._sliceDuration;
        end += this._sliceDuration - end % this._sliceDuration;

        const fetch: { start: Date, end: Date }[] = [];
        const update: CalendarSlice[] = [];

        for (let i = start; i < end; i += this._sliceDuration) {
            const match = this._slices.find(x => x.startDateTime.getTime() === i);
            if (typeof match !== 'undefined') {
                update.push(match);
            } else {
                fetch.push({ start: new Date(i), end: new Date(i + this._sliceDuration) });
            }
        }

        for (const item of fetch) {
            console.log(`getting calendar view from ${item.start.toISOString()} to ${item.end.toISOString()}`);
            const deltaLink = await getDeltaInitial(dispatcher, this._calendarId, item.start, item.end, this._events);
            this._slices.push({
                startDateTime: item.start,
                endDateTime: item.end,
                deltaLink,
            });
            // await this.save();
        }
        this._slices.sort((a, b) => a.startDateTime.getTime() - b.startDateTime.getTime());
        // await this.save();

        for (const item of update) {
            console.log(`updating calendar view from ${item.startDateTime.toISOString()} to ${item.endDateTime.toISOString()}`);
            item.deltaLink = await getDelta(dispatcher, item.deltaLink, this._events);
            // await this.save();
        }

        // await this.save();
    }

    public async getAll(dispatcher: AsyncDispatcher): Promise<void> {
        let startTime = Infinity;
        let endTime = 0;

        for (const slice of this._slices) {
            if (slice.startDateTime.getTime() < startTime) {
                startTime = slice.startDateTime.getTime();
            }

            if (slice.endDateTime.getTime() > endTime) {
                endTime = slice.endDateTime.getTime();
            }
        }

        const events = await getCalendarView(dispatcher, this._calendarId, new Date(startTime), new Date(endTime));
        this._events = {};
        for (const event of events) {
            this._events[event.id] = event;
        }

        await this.save();
    }

    public getEvents(): CalendarEvent[] {
        return Array.from(Object.values(this._events));
    }
}
