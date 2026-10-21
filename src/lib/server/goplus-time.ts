// GoPlus отдаёт end_time в locked_detail как unix-время в секундах строкой (не ISO-дату и не миллисекунды):
// см. https://docs.gopluslabs.io/reference/response-details — "end_time describes when the token will be
// unlocked" в виде секунд с эпохи. Date.parse на такой строке всегда даёт NaN. Чистая функция без
// "server-only", чтобы её было легко тестировать отдельно от остального scan-lp.ts.
export function goplusEndTimeMs(endTime?: string): number | undefined {
  if (!endTime) return undefined;
  const sec = Number(endTime);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
}
