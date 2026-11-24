export type MatchMode = 'any' | 'all';
export type GateMode = 'stopOnMatch' | 'allowOnlyOnMatch';

export interface DayOfWeekRule {
	type: 'dayOfWeek';
	days: number[]; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
	startTime?: string; // HH:mm
	endTime?: string; // HH:mm
}

export interface HolidayRule {
	type: 'holiday';
	/**
	 * Comma-separated patterns:
	 * - MM-DD-* (e.g. 01-01-*, 12-25-*)
	 * - MM-DD (e.g. 01-01, 12-25)
	 * - YYYY-MM-DD (e.g. 2026-11-26)
	 */
	patterns: string;
}

export interface DateTimeRangeRule {
	type: 'dateTimeRange';
	startDateTime: string; // ISO-like string, e.g. 2026-12-24T18:00
	endDateTime: string; // ISO-like string, e.g. 2026-12-26T08:00
}

export interface TimeWindowRule {
	type: 'timeWindow';
	startTime: string; // HH:mm
	endTime: string; // HH:mm
}

export type CalendarRule =
	| DayOfWeekRule
	| HolidayRule
	| DateTimeRangeRule
	| TimeWindowRule;

export interface ZonedDateParts {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
	hour: number; // 0-23
	minute: number; // 0-59
	dayOfWeek: number; // 0-6 (0 = Sunday)
}

export interface EvaluationResult {
	matched: boolean;
	shouldStop: boolean;
	matchedRules: number[];
	evaluatedAt: string;
	timezone: string;
}

const WEEKDAY_MAP: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

export function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		weekday: 'short',
		hour12: false,
	});

	const parts = formatter.formatToParts(date);
	const lookup: Record<string, string> = {};
	for (const part of parts) {
		if (part.type !== 'literal') {
			lookup[part.type] = part.value;
		}
	}

	const hourRaw = Number(lookup.hour);
	return {
		year: Number(lookup.year),
		month: Number(lookup.month),
		day: Number(lookup.day),
		hour: hourRaw === 24 ? 0 : hourRaw,
		minute: Number(lookup.minute),
		dayOfWeek: WEEKDAY_MAP[lookup.weekday] ?? date.getUTCDay(),
	};
}

function parseTimeToMinutes(timeStr: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	return hours * 60 + minutes;
}

function isWithinTimeWindow(
	currentMinutes: number,
	startTime?: string,
	endTime?: string,
): boolean {
	if (!startTime || !endTime) return true;
	const start = parseTimeToMinutes(startTime);
	const end = parseTimeToMinutes(endTime);
	if (start === null || end === null) return false;

	if (start <= end) {
		return currentMinutes >= start && currentMinutes <= end;
	}
	// Overnight window (e.g. 22:00 to 06:00)
	return currentMinutes >= start || currentMinutes <= end;
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function matchesHolidayPattern(parts: ZonedDateParts, rawPattern: string): boolean {
	const pattern = rawPattern.trim();
	if (!pattern) return false;

	const mm = pad2(parts.month);
	const dd = pad2(parts.day);
	const yyyy = String(parts.year);

	// MM-DD-* (e.g. 01-01-*, 12-25-*)
	const recurringWildcard = /^(\d{2})-(\d{2})-\*$/.exec(pattern);
	if (recurringWildcard) {
		return recurringWildcard[1] === mm && recurringWildcard[2] === dd;
	}

	// MM-DD (shorthand)
	const recurringShort = /^(\d{2})-(\d{2})$/.exec(pattern);
	if (recurringShort) {
		return recurringShort[1] === mm && recurringShort[2] === dd;
	}

	// YYYY-MM-DD (exact date)
	const exactDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pattern);
	if (exactDate) {
		return exactDate[1] === yyyy && exactDate[2] === mm && exactDate[3] === dd;
	}

	return false;
}

export function evaluateRule(
	rule: CalendarRule,
	now: Date,
	parts: ZonedDateParts,
): boolean {
	const currentMinutes = parts.hour * 60 + parts.minute;

	switch (rule.type) {
		case 'dayOfWeek': {
			if (!rule.days.includes(parts.dayOfWeek)) {
				return false;
			}
			return isWithinTimeWindow(currentMinutes, rule.startTime, rule.endTime);
		}
		case 'holiday': {
			const patterns = rule.patterns
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean);
			return patterns.some((p) => matchesHolidayPattern(parts, p));
		}
		case 'dateTimeRange': {
			const startMs = Date.parse(rule.startDateTime);
			const endMs = Date.parse(rule.endDateTime);
			if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
				return false;
			}
			const nowMs = now.getTime();
			return nowMs >= startMs && nowMs <= endMs;
		}
		case 'timeWindow': {
			return isWithinTimeWindow(currentMinutes, rule.startTime, rule.endTime);
		}
	}
}

export function evaluateCalendarGate(
	rules: CalendarRule[],
	options: {
		date?: Date;
		timezone?: string;
		matchMode?: MatchMode;
		gateMode?: GateMode;
	} = {},
): EvaluationResult {
	const now = options.date ?? new Date();
	const timezone = options.timezone || 'UTC';
	const matchMode = options.matchMode ?? 'any';
	const gateMode = options.gateMode ?? 'stopOnMatch';

	const parts = getZonedDateParts(now, timezone);
	const matchedRules: number[] = [];

	rules.forEach((rule, index) => {
		if (evaluateRule(rule, now, parts)) {
			matchedRules.push(index);
		}
	});

	let matched = false;
	if (rules.length > 0) {
		matched =
			matchMode === 'all'
				? matchedRules.length === rules.length
				: matchedRules.length > 0;
	}

	const shouldStop = gateMode === 'stopOnMatch' ? matched : !matched;

	return {
		matched,
		shouldStop,
		matchedRules,
		evaluatedAt: now.toISOString(),
		timezone,
	};
}
