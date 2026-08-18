export function safeParseArray(data: string | null): any[] {
  if (!data) return [];
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed.filter(item => item !== null && typeof item === 'object');
    }
  } catch (e) {}
  return [];
}

export function safeParseObject(data: string | null, fallback: any = {}): any {
  if (!data) return fallback;
  try {
    const parsed = JSON.parse(data);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...fallback, ...parsed };
    }
  } catch (e) {}
  return fallback;
}