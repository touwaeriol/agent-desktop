/** Replace only the active @ token before the caret, preserving text on both sides. */
export function insertFileMention(value: string, caret: number, file: string): { text: string; caret: number } {
  const before = value.slice(0, caret).replace(/@[^\s@]*$/, '')
  const mention = '@' + file + ' '
  return { text: before + mention + value.slice(caret), caret: before.length + mention.length }
}
