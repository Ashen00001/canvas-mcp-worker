import http from "node:http";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools";

const methods = new Set<string>();
const paths: string[] = [];

const server = http.createServer((req, res) => {
	methods.add(req.method!);
	const url = new URL(req.url!, "http://x");
	paths.push(url.pathname + url.search);
	const json = (body: unknown, link?: string) => {
		res.writeHead(200, { "content-type": "application/json", ...(link ? { Link: link } : {}) });
		res.end(JSON.stringify(body));
	};
	if (req.headers.authorization !== "Bearer good") return res.writeHead(401).end("{}");
	const p = url.pathname;
	if (p === "/api/v1/courses" && url.searchParams.get("page") !== "2")
		return json(
			[{ id: 1, name: "Chem", course_code: "CH", term: { name: "Fall" }, enrollments: [{ type: "student", computed_current_score: 91.2, computed_current_grade: "A-" }] }],
			`<http://127.0.0.1:${port}/api/v1/courses?page=2&per_page=100>; rel="next"`,
		);
	if (p === "/api/v1/courses") return json([{ id: 2, name: "Bio", enrollments: [{ type: "student", computed_current_score: 80 }] }, { id: 3 }]);
	if (p === "/api/v1/courses/1") return json({ id: 1, name: "Chem", syllabus_body: "<p>Week 1</p><script>x</script>", enrollments: [{ type: "student", computed_current_score: 91.2 }] });
	if (p === "/api/v1/courses/1/assignments")
		return json([
			{ id: 10, name: "Lab 1", due_at: "2026-11-01T07:00:00Z", points_possible: 20, submission: { score: 18, grade: "18", late: false, missing: false, workflow_state: "graded" } },
			{ id: 11, name: "Ungraded note", points_possible: 0, submission: null },
		]);
	if (p === "/api/v1/courses/1/assignments/10") return json({ id: 10, name: "Lab 1", description: "<p>Do &amp; write</p>", points_possible: 20, submission: { score: 18 } });
	if (p === "/api/v1/users/self/missing_submissions") return json([{ id: 12, name: "Essay", course_id: 1, course: { name: "Chem" }, due_at: "2026-11-05T07:00:00Z" }]);
	if (p === "/api/v1/planner/items") return json([{ plannable_type: "assignment", plannable: { title: "Quiz 3", points_possible: 10 }, context_name: "Chem", course_id: 1, plannable_date: "2026-11-12", submissions: { submitted: false, missing: false, graded: false }, html_url: "/courses/1/assignments/13" }]);
	if (p === "/api/v1/courses/1/modules") return json([{ id: 5, name: "Unit 1", items: [{ title: "Lab 1", type: "Assignment" }] }]);
	if (p === "/api/v1/announcements") return json([{ title: "No class", posted_at: "2026-11-09", message: "<b>Enjoy</b>", author: { display_name: "Ms. K" } }]);
	if (p === "/api/v1/courses/1/quizzes") return json([{ id: 7, title: "Quiz 3", points_possible: 10 }]);
	if (p === "/api/v1/courses/404/assignments") return res.writeHead(404).end("{}");
	res.writeHead(500).end("{}");
});

let port = 0;
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
port = (server.address() as any).port;

const handlers: Record<string, any> = {};
const annotations: Record<string, any> = {};
const fake = { registerTool: (name: string, cfg: any, fn: any) => { handlers[name] = fn; annotations[name] = cfg.annotations; } };
const base = `http://127.0.0.1:${port}`;
registerTools(fake as any, { baseUrl: base, token: "good" });

const call = async (name: string, args: any = {}) => {
	const r = await handlers[name](args);
	return { err: !!r.isError, text: r.content[0].text, data: r.isError ? null : JSON.parse(r.content[0].text) };
};

const expected = ["list_courses", "get_grades", "list_assignments", "get_assignment", "list_missing_work", "list_upcoming", "get_syllabus", "list_modules", "list_announcements", "list_quizzes"];
assert.deepEqual(Object.keys(handlers).sort(), [...expected].sort());
for (const n of expected) assert.equal(annotations[n]?.readOnlyHint, true, `${n} readOnlyHint`);

let r = await call("list_courses", { include_past: false });
assert.equal(r.data.length, 2, "pagination followed, nameless course dropped");
assert.equal(r.data[0].grade.computed_current_grade, "A-");

r = await call("get_grades", {});
assert.equal(r.data[1].grade.computed_current_score, 80);

r = await call("get_grades", { course_id: 1 });
assert.equal(r.data.assignments.length, 1, "0-point ungraded item filtered");
assert.equal(r.data.assignments[0].score, 18);

r = await call("list_assignments", { course_id: 1, bucket: "upcoming" });
assert.equal(r.data[0].submission.score, 18);
assert.ok(paths.some((p) => p.includes("bucket=upcoming")));

r = await call("get_assignment", { course_id: 1, assignment_id: 10 });
assert.equal(r.data.description, "Do & write");

r = await call("list_missing_work");
assert.equal(r.data[0].course, "Chem");

r = await call("list_upcoming", { days: 14, include_past_days: 0 });
assert.equal(r.data[0].title, "Quiz 3");
assert.equal(r.data[0].url, `${base}/courses/1/assignments/13`);

r = await call("get_syllabus", { course_id: 1 });
assert.equal(r.data.syllabus, "Week 1");

r = await call("list_modules", { course_id: 1 });
assert.equal(r.data[0].items[0].title, "Lab 1");

r = await call("list_announcements", { course_id: 1, days: 14 });
assert.equal(r.data[0].message, "Enjoy");

r = await call("list_quizzes", { course_id: 1 });
assert.equal(r.data[0].title, "Quiz 3");

r = await call("list_assignments", { course_id: 404 });
assert.ok(r.err && r.text.includes("Not found"));

const bad: Record<string, any> = {};
registerTools({ registerTool: (n: string, _c: any, fn: any) => (bad[n] = fn) } as any, { baseUrl: base, token: "expired" });
const b = await bad.list_courses({ include_past: false });
assert.ok(b.isError && b.content[0].text.includes("token is invalid or expired"));

assert.deepEqual([...methods], ["GET"], "only GET requests ever sent");
server.close();
console.log(`PASS: ${expected.length} tools, all readOnly, ${paths.length} Canvas requests, methods=${[...methods]}`);
