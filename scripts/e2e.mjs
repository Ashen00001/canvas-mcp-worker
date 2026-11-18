#!/usr/bin/env node
// Full test against the deployed server with real Canvas data.
// Opens the sign-in page in the browser; a human clicks Approve, then Authorize on GitHub.
// Prints counts only, never grades or assignment names.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { readConfig } from "./lib.mjs";

const mcp = readConfig()?.vars?.MCP_RESOURCE;
if (!mcp?.startsWith("https://")) {
	console.error("Run setup first.");
	process.exit(1);
}
const B = new URL(mcp).origin;
const PORT = 8799;
const REDIRECT = `http://localhost:${PORT}/cb`;
const b64u = (b) => Buffer.from(b).toString("base64url");

function openBrowser(url) {
	const [cmd, args] =
		process.platform === "win32" ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
	spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

const reg = await (
	await fetch(`${B}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "e2e test", token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
	})
).json();
const verifier = b64u(crypto.randomBytes(32));
const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
const state = b64u(crypto.randomBytes(12));
const auth = new URL(`${B}/authorize`);
for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state, resource: mcp }))
	auth.searchParams.set(k, v);

const code = await new Promise((resolve, reject) => {
	const srv = http.createServer((req, res) => {
		const u = new URL(req.url, `http://localhost:${PORT}`);
		if (u.pathname !== "/cb") return res.writeHead(404).end();
		res.writeHead(200, { "content-type": "text/plain" }).end("Test sign-in done. You can close this tab.");
		srv.close();
		if (u.searchParams.get("state") !== state) return reject(new Error("state mismatch"));
		resolve(u.searchParams.get("code"));
	});
	srv.listen(PORT, () => {
		openBrowser(auth.href);
		console.log(`Opened the sign-in page. Click Approve, then Authorize on GitHub. Waiting up to 5 minutes...\nIf no tab opened, visit: ${auth.href}`);
	});
	setTimeout(() => reject(new Error("timed out waiting for the sign-in")), 300000);
});

const tok = await (
	await fetch(`${B}/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: mcp }),
	})
).json();
if (!tok.access_token) throw new Error("No access token. If GitHub said the account isn't allowed, check ALLOWED_GITHUB_USERS.");
console.log("[x] signed in");

let id = 0;
let session;
async function rpc(method, params) {
	const res = await fetch(mcp, {
		method: "POST",
		headers: {
			authorization: `Bearer ${tok.access_token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			...(session ? { "mcp-session-id": session } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
	});
	session = res.headers.get("mcp-session-id") ?? session;
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
	const line = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() : text;
	const msg = JSON.parse(line);
	if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
	return msg.result;
}
async function call(name, args = {}) {
	const r = await rpc("tools/call", { name, arguments: args });
	return r.isError ? { err: r.content[0].text } : { data: JSON.parse(r.content[0].text) };
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
const tools = (await rpc("tools/list", {})).tools;
console.log(`[x] ${tools.length} tools, all read-only: ${tools.every((t) => t.annotations?.readOnlyHint === true)}`);

let failed = 0;
const report = (label, r, count) => {
	if (r.err) failed++;
	console.log(`${r.err ? "[ ]" : "[x]"} ${label}: ${r.err ? r.err : count(r.data)}`);
};
const courses = await call("list_courses", { include_past: false });
report("list_courses", courses, (d) => `${d.length} active courses`);
report("get_grades", await call("get_grades", {}), (d) => `${d.length} courses`);
const first = courses.data?.[0];
if (first) {
	report("get_grades(course)", await call("get_grades", { course_id: first.id }), (d) => `${d.assignments.length} graded items`);
	report("list_assignments", await call("list_assignments", { course_id: first.id }), (d) => `${d.length}`);
	report("list_modules", await call("list_modules", { course_id: first.id }), (d) => `${d.length}`);
}
report("list_missing_work", await call("list_missing_work"), (d) => `${d.length} missing`);
report("list_upcoming", await call("list_upcoming", { days: 14, include_past_days: 0 }), (d) => `${d.length} items in 14 days`);
report("list_announcements", await call("list_announcements", { days: 14 }), (d) => `${d.length}`);
console.log(failed ? `\nE2E_FAIL ${failed} tool(s) errored` : "\nE2E_OK");
process.exit(failed ? 1 : 0);
