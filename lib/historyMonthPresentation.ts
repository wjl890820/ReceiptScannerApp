export type HistoryMonthRow = {
  transaction_at?: number | null;
  created_at: number;
};

export type HistoryMonthSection<T extends HistoryMonthRow> = {
  key: string;
  title: string;
  data: T[];
};

const LOCALE_TAGS = {
  zh: 'zh-CN',
  ja: 'ja-JP',
  en: 'en-US',
} as const;

function toDate(timestamp: number): Date {
  return new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
}

export function buildHistoryMonthSections<T extends HistoryMonthRow>(
  rows: readonly T[],
  locale: keyof typeof LOCALE_TAGS
): HistoryMonthSection<T>[] {
  const sections = new Map<string, HistoryMonthSection<T>>();
  const titleFormatter = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    year: 'numeric',
    month: 'long',
    timeZone: 'Asia/Tokyo',
  });
  const keyFormatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    timeZone: 'Asia/Tokyo',
  });

  for (const row of rows) {
    const date = toDate(row.transaction_at ?? row.created_at);
    const key = keyFormatter.format(date);
    const section = sections.get(key) ?? {
      key,
      title: titleFormatter.format(date),
      data: [],
    };
    section.data.push(row);
    sections.set(key, section);
  }

  return Array.from(sections.values());
}
