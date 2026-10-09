export function splitList(value: string): string[] {
  return value.split(/[,\s]+/).filter(Boolean)
}
