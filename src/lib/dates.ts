import { he } from "../copy/he";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatAbsoluteDate(date: Date): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function formatLocalDateTime(date: Date, now: Date = new Date()): string {
  const time = formatClock(date);
  const dayDiff = Math.round(
    (startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000,
  );

  if (dayDiff === 0) {
    return `${he.today}, ${time}`;
  }

  if (dayDiff === 1) {
    return `${he.yesterday}, ${time}`;
  }

  return `${formatAbsoluteDate(date)}, ${time}`;
}
