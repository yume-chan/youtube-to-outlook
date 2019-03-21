export function parse<T extends object>(text: string): T {
    let list: string[] | undefined;
    const result: any = {};

    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('  ')) {
            const parts = line.split(':');
            if (parts[1]) {
                result[parts[0]] = parts[1].trim();
            } else {
                result[line.substring(0, line.length - 1)] = list = [];
            }
        } else {
            list!.push(line.trim().substring(2));
        }
    }

    return result;
}

export function stringify(object: object): string {
    let result = '';

    for (const [key, value] of Object.entries(object)) {
        if (Array.isArray(value)) {
            result += `${key}:\n`;
            for (const item of value) {
                result += `  - ${item}\n`;
            }
        } else {
            result += `${key}: ${value}\n`;
        }
    }

    return result;
}
