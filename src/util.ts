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
