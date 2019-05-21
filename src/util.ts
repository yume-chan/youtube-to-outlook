export function stripHtml(text: string): string {
    return text
        .replace(/<\/div>/g, '\n')
        .replace(/<br>/g, '\n')
        .replace(/<\/?.*?>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#43;/g, '+')
        .replace(/&quot;/g, '"')
        .replace(/\r\n/g, '')
        .trim();
}

export interface EventBody {
    original_title: string;
    participants?: string[];
    references: string[];
    youtube_id: string;
}

export function detailType(value: any) {
    switch (typeof value) {
        case 'object':
            if (value === null) {
                return 'null';
            }
            if (Array.isArray(value)) {
                return 'array';
            }
            return 'object';
        default:
            return typeof value;
    }
}

export function deepMerge(...args: any[]): any {
    args = args.filter(x => typeof x !== 'undefined' && x !== null);

    if (args.length === 0) {
        return undefined;
    }

    if (args.length === 1) {
        return args[0];
    }

    const keySet: Set<string> = new Set();
    for (const arg of args) {
        for (const key of Object.keys(arg)) {
            keySet.add(key);
        }
    }

    const keys = Array.from(keySet);
    keys.sort();

    const result: any = {};
    for (const key of keys) {
        let type: string | undefined;
        for (const arg of args) {
            const thisType = detailType(arg[key]);
            if (thisType === 'undefined') {
                if (Object.prototype.hasOwnProperty.call(arg, key)) {
                    delete result[key];
                }
                continue;
            }

            if (type !== undefined) {
                if (thisType !== type) {
                    throw new TypeError();
                }
            }

            type = thisType;
            if (type === 'array') {
                if (Array.isArray(result[key])) {
                    const set = new Set();
                    for (const item of result[key]) {
                        set.add(item);
                    }
                    for (const item of arg[key]) {
                        set.add(item);
                    }
                    const list = Array.from(set);
                    list.sort();
                    result[key] = list;
                    continue;
                }
            }

            if (type === 'object') {
                result[key] = deepMerge(result[key], arg[key]);
            }

            result[key] = arg[key];
        }
    }

    return result;
}
