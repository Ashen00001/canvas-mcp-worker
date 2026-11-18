export type CanvasConfig = { baseUrl: string; token: string };

export class CanvasError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

const MAX_PAGES = 10;

function nextLink(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(",")) {
		const m = part.match(/<([^>]+)>;\s*rel="next"/);
		if (m) return m[1];
	}
	return null;
}

async function getOnce(cfg: CanvasConfig, url: string): Promise<Response> {
	const t0 = Date.now();
	const path = new URL(url).pathname;
	let res: Response;
	console.warn(`canvas START GET ${path}`);
	try {
		res = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${cfg.token}`,
				Accept: "application/json",
				"User-Agent": "canvas-mcp-worker/1.0 (read-only)",
			},
			signal: AbortSignal.timeout(15000),
		});
	} catch (e) {
		console.error(`canvas FETCH-FAIL ${Date.now() - t0}ms GET ${path}: ${e instanceof Error ? e.name + " " + e.message : e}`);
		throw new CanvasError(0, "Couldn't reach Canvas (timed out or network error). Try again in a moment.");
	}
	console.warn(`canvas ${res.status} ${Date.now() - t0}ms GET ${path}`);
	if (!res.ok) {
		const hint =
			res.status === 401
				? "Canvas token is invalid or expired. Generate a new one and update the CANVAS_API_TOKEN secret."
				: res.status === 403
					? "Canvas says this resource is not visible to this account."
					: res.status === 404
						? "Not found. Check the course/assignment id."
						: `Canvas returned HTTP ${res.status}.`;
		throw new CanvasError(res.status, hint);
	}
	return res;
}

function buildUrl(cfg: CanvasConfig, path: string, params?: Record<string, string | string[] | undefined>) {
	const url = new URL(path, cfg.baseUrl.replace(/\/+$/, "") + "/");
	if (!url.href.startsWith(cfg.baseUrl.replace(/\/+$/, "") + "/api/v1/")) {
		throw new Error("Refusing to call a non-API Canvas path");
	}
	for (const [k, v] of Object.entries(params ?? {})) {
		if (v === undefined) continue;
		if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
		else url.searchParams.set(k, v);
	}
	return url.href;
}

export async function canvasGet<T = any>(
	cfg: CanvasConfig,
	path: string,
	params?: Record<string, string | string[] | undefined>,
): Promise<T> {
	const res = await getOnce(cfg, buildUrl(cfg, path, params));
	return (await res.json()) as T;
}

export async function canvasGetAll<T = any>(
	cfg: CanvasConfig,
	path: string,
	params?: Record<string, string | string[] | undefined>,
): Promise<T[]> {
	const out: T[] = [];
	let url: string | null = buildUrl(cfg, path, { per_page: "100", ...params });
	const origin = new URL(cfg.baseUrl).origin;
	for (let i = 0; url && i < MAX_PAGES; i++) {
		const res = await getOnce(cfg, url);
		const page = (await res.json()) as T[];
		out.push(...page);
		const next = nextLink(res.headers.get("Link"));
		url = next && new URL(next).origin === origin ? next : null;
	}
	return out;
}

export function stripHtml(html: string | null | undefined, max = 4000): string {
	if (!html) return "";
	const text = html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
	return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

export function pick<T extends object>(o: T, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const v = (o as any)[k];
		if (v !== undefined && v !== null && v !== "") out[k] = v;
	}
	return out;
}

export function submissionSummary(s: any) {
	if (!s) return undefined;
	return pick(s, [
		"workflow_state",
		"submitted_at",
		"score",
		"grade",
		"late",
		"missing",
		"excused",
		"points_deducted",
		"graded_at",
	]);
}

export function assignmentSummary(a: any) {
	return {
		...pick(a, ["id", "name", "due_at", "lock_at", "points_possible", "submission_types", "html_url"]),
		submission: submissionSummary(a.submission),
	};
}
