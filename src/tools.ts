import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	assignmentSummary,
	CanvasError,
	canvasGet,
	canvasGetAll,
	type CanvasConfig,
	pick,
	stripHtml,
	submissionSummary,
} from "./canvas";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const courseId = z.coerce.number().int().positive().describe("Canvas course id (from list_courses)");

function ok(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
}

function fail(e: unknown) {
	if (!(e instanceof CanvasError)) console.error(`tool error: ${e instanceof Error ? e.message : String(e)}`);
	const msg = e instanceof CanvasError ? e.message : e instanceof Error ? e.message : String(e);
	return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
	return async (args: A) => {
		const t0 = Date.now();
		try {
			const out = ok(await fn(args));
			console.warn(`tool ok ${Date.now() - t0}ms, ${out.content[0].text.length} chars`);
			return out;
		} catch (e) {
			return fail(e);
		}
	};
}

function enrollmentGrade(c: any) {
	const e = (c.enrollments ?? []).find((x: any) => x.type === "student") ?? c.enrollments?.[0];
	if (!e) return undefined;
	return pick(e, [
		"computed_current_score",
		"computed_current_grade",
		"computed_final_score",
		"computed_final_grade",
		"current_period_computed_current_score",
		"current_period_computed_current_grade",
	]);
}

export function registerTools(server: McpServer, cfg: CanvasConfig) {
	server.registerTool(
		"list_courses",
		{
			description:
				"List my Canvas courses with their current grade. Defaults to active courses; set include_past to also list concluded ones.",
			inputSchema: z.object({
				include_past: z.boolean().default(false).describe("Also include completed/concluded courses"),
			}),
			annotations: RO,
		},
		wrap(async ({ include_past }: { include_past: boolean }) => {
			const courses = await canvasGetAll(cfg, "api/v1/courses", {
				enrollment_state: include_past ? undefined : "active",
				"include[]": ["total_scores", "term", "current_grading_period_scores"],
			});
			return courses
				.filter((c: any) => c.name)
				.map((c: any) => ({
					...pick(c, ["id", "name", "course_code"]),
					term: c.term?.name,
					grade: enrollmentGrade(c),
				}));
		}),
	);

	server.registerTool(
		"get_grades",
		{
			description:
				"My grades. Without course_id: overall current grade for every active course. With course_id: every graded assignment in that course with my score, points possible, late/missing flags, plus the course total.",
			inputSchema: z.object({ course_id: courseId.optional() }),
			annotations: RO,
		},
		wrap(async ({ course_id }: { course_id?: number }) => {
			if (!course_id) {
				const courses = await canvasGetAll(cfg, "api/v1/courses", {
					enrollment_state: "active",
					"include[]": ["total_scores", "current_grading_period_scores"],
				});
				return courses
					.filter((c: any) => c.name)
					.map((c: any) => ({ id: c.id, name: c.name, grade: enrollmentGrade(c) }));
			}
			const [course, assignments] = await Promise.all([
				canvasGet(cfg, `api/v1/courses/${course_id}`, { "include[]": ["total_scores"] }),
				canvasGetAll(cfg, `api/v1/courses/${course_id}/assignments`, {
					"include[]": ["submission"],
					order_by: "due_at",
				}),
			]);
			return {
				course: course.name,
				total: enrollmentGrade(course),
				assignments: assignments
					.filter((a: any) => a.points_possible || a.submission?.score != null)
					.map((a: any) => ({
						id: a.id,
						name: a.name,
						due_at: a.due_at,
						points_possible: a.points_possible,
						...submissionSummary(a.submission),
					})),
			};
		}),
	);

	server.registerTool(
		"list_assignments",
		{
			description:
				"List assignments in a course with my submission status. Optional bucket filter: past, overdue, undated, ungraded, unsubmitted, upcoming, future.",
			inputSchema: z.object({
				course_id: courseId,
				bucket: z
					.enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"])
					.optional(),
				search: z.string().max(100).optional().describe("Filter by assignment name"),
			}),
			annotations: RO,
		},
		wrap(async ({ course_id, bucket, search }: { course_id: number; bucket?: string; search?: string }) => {
			const list = await canvasGetAll(cfg, `api/v1/courses/${course_id}/assignments`, {
				"include[]": ["submission"],
				order_by: "due_at",
				bucket,
				search_term: search,
			});
			return list.map(assignmentSummary);
		}),
	);

	server.registerTool(
		"get_assignment",
		{
			description: "Full details for one assignment: instructions (as text), due/lock dates, points, and my submission.",
			inputSchema: z.object({
				course_id: courseId,
				assignment_id: z.coerce.number().int().positive(),
			}),
			annotations: RO,
		},
		wrap(async ({ course_id, assignment_id }: { course_id: number; assignment_id: number }) => {
			const a = await canvasGet(cfg, `api/v1/courses/${course_id}/assignments/${assignment_id}`, {
				"include[]": ["submission"],
			});
			return {
				...assignmentSummary(a),
				...pick(a, ["unlock_at", "allowed_attempts", "grading_type"]),
				description: stripHtml(a.description),
				rubric: a.rubric?.map((r: any) => pick(r, ["description", "points", "long_description"])),
			};
		}),
	);

	server.registerTool(
		"list_missing_work",
		{
			description: "Everything Canvas currently marks as missing for me, across all courses, with course name and due date.",
			inputSchema: z.object({}),
			annotations: RO,
		},
		wrap(async () => {
			const list = await canvasGetAll(cfg, "api/v1/users/self/missing_submissions", {
				"include[]": ["course"],
				"filter[]": ["current_grading_period"],
			});
			return list.map((a: any) => ({
				course: a.course?.name,
				course_id: a.course_id,
				...pick(a, ["id", "name", "due_at", "points_possible", "html_url"]),
			}));
		}),
	);

	server.registerTool(
		"list_upcoming",
		{
			description:
				"My to-do / planner items (assignments, quizzes, discussions, events) due in the next N days, with whether each is submitted or marked done.",
			inputSchema: z.object({
				days: z.coerce.number().int().min(1).max(60).default(14),
				include_past_days: z.coerce.number().int().min(0).max(30).default(0).describe("Also look back this many days"),
			}),
			annotations: RO,
		},
		wrap(async ({ days, include_past_days }: { days: number; include_past_days: number }) => {
			const now = Date.now();
			const items = await canvasGetAll(cfg, "api/v1/planner/items", {
				start_date: new Date(now - include_past_days * 864e5).toISOString(),
				end_date: new Date(now + days * 864e5).toISOString(),
			});
			return items.map((i: any) => ({
				type: i.plannable_type,
				title: i.plannable?.title ?? i.plannable?.name,
				course: i.context_name,
				course_id: i.course_id,
				due: i.plannable_date,
				points_possible: i.plannable?.points_possible,
				submitted: i.submissions ? i.submissions.submitted : undefined,
				missing: i.submissions ? i.submissions.missing : undefined,
				graded: i.submissions ? i.submissions.graded : undefined,
				marked_done: i.planner_override?.marked_complete || undefined,
				url: i.html_url ? new URL(i.html_url, cfg.baseUrl).href : undefined,
			}));
		}),
	);

	server.registerTool(
		"get_syllabus",
		{
			description: "A course's syllabus as plain text.",
			inputSchema: z.object({ course_id: courseId }),
			annotations: RO,
		},
		wrap(async ({ course_id }: { course_id: number }) => {
			const c = await canvasGet(cfg, `api/v1/courses/${course_id}`, { "include[]": ["syllabus_body"] });
			return { course: c.name, syllabus: stripHtml(c.syllabus_body, 12000) || "(no syllabus posted)" };
		}),
	);

	server.registerTool(
		"list_modules",
		{
			description: "A course's modules and the items inside each (pages, assignments, quizzes, links).",
			inputSchema: z.object({ course_id: courseId }),
			annotations: RO,
		},
		wrap(async ({ course_id }: { course_id: number }) => {
			const mods = await canvasGetAll(cfg, `api/v1/courses/${course_id}/modules`, { "include[]": ["items"] });
			return mods.map((m: any) => ({
				...pick(m, ["id", "name", "state", "unlock_at"]),
				items: (m.items ?? []).map((i: any) =>
					pick(i, ["title", "type", "content_id", "html_url", "completion_requirement"]),
				),
			}));
		}),
	);

	server.registerTool(
		"list_announcements",
		{
			description: "Recent announcements. Pass course_id for one course, or omit for all active courses.",
			inputSchema: z.object({
				course_id: courseId.optional(),
				days: z.coerce.number().int().min(1).max(120).default(14),
			}),
			annotations: RO,
		},
		wrap(async ({ course_id, days }: { course_id?: number; days: number }) => {
			let ids: number[];
			if (course_id) ids = [course_id];
			else {
				const courses = await canvasGetAll(cfg, "api/v1/courses", { enrollment_state: "active" });
				ids = courses.filter((c: any) => c.name).map((c: any) => c.id);
			}
			if (!ids.length) return [];
			const list = await canvasGetAll(cfg, "api/v1/announcements", {
				"context_codes[]": ids.map((i) => `course_${i}`),
				start_date: new Date(Date.now() - days * 864e5).toISOString(),
				end_date: new Date().toISOString(),
			});
			return list.map((a: any) => ({
				...pick(a, ["title", "posted_at", "context_code", "html_url"]),
				author: a.author?.display_name,
				message: stripHtml(a.message, 2000),
			}));
		}),
	);

	server.registerTool(
		"list_quizzes",
		{
			description: "Quizzes in a course with due dates and points.",
			inputSchema: z.object({ course_id: courseId }),
			annotations: RO,
		},
		wrap(async ({ course_id }: { course_id: number }) => {
			const list = await canvasGetAll(cfg, `api/v1/courses/${course_id}/quizzes`);
			return list.map((q: any) =>
				pick(q, ["id", "title", "due_at", "lock_at", "points_possible", "question_count", "time_limit", "html_url"]),
			);
		}),
	);
}
