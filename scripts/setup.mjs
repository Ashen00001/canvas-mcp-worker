#!/usr/bin/env node
// Usage:
//   node scripts/setup.mjs init --canvas-url https://school.instructure.com --github-user someone [--name canvas-mcp] [--subdomain pick-one]
//   node scripts/setup.mjs status
//   node scripts/setup.mjs deploy
// Exit codes: 0 ok, 1 error, 2 needs a human step (message says which).
import { randomBytes } from "node:crypto";
import { accountId, cfApi, isLoggedIn, readConfig, REQUIRED_SECRETS, secretNames, step, wrangler, writeConfig } from "./lib.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
	if (rest[i].startsWith("--")) args[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i];
}

function human(msg) {
	console.log(`\nNEEDS A HUMAN: ${msg}`);
	process.exit(2);
}
function fail(msg) {
	console.error(`\nERROR: ${msg}`);
	process.exit(1);
}

async function getSubdomain(acct) {
	const { status, body } = await cfApi(`/accounts/${acct}/workers/subdomain`);
	if (status === 200 && body.result?.subdomain) return body.result.subdomain;
	return null;
}

async function init() {
	const canvasUrl = String(args["canvas-url"] ?? "").replace(/\/+$/, "");
	const githubUsers = String(args["github-user"] ?? "").trim();
	const name = String(args.name ?? "canvas-mcp");
	if (!/^https:\/\/[a-z0-9.-]+$/i.test(canvasUrl)) fail("--canvas-url must look like https://yourschool.instructure.com (no path).");
	if (!/^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$/.test(githubUsers)) fail("--github-user must be a GitHub username (comma-separate several).");
	if (!/^[a-z0-9-]{1,54}$/.test(name)) fail("--name must be lowercase letters, numbers and dashes.");

	if (!isLoggedIn()) human("Cloudflare login. Run `npx wrangler login` and click Allow in the browser, then rerun this command.");
	step(true, "Cloudflare login");

	const acct = await accountId();
	let sub = await getSubdomain(acct);
	if (!sub) {
		if (!args.subdomain || args.subdomain === true) {
			human(
				"This Cloudflare account has no workers.dev subdomain yet. Ask the user to pick one (it becomes part of the URL, " +
					"https://<name>.<subdomain>.workers.dev), then rerun with --subdomain <pick>.",
			);
		}
		const { status, body } = await cfApi(`/accounts/${acct}/workers/subdomain`, {
			method: "PUT",
			body: JSON.stringify({ subdomain: String(args.subdomain).toLowerCase() }),
		});
		if (status !== 200) fail(`Could not register subdomain (HTTP ${status}): ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
		sub = body.result.subdomain;
	}
	step(true, `workers.dev subdomain: ${sub}`);

	const existing = readConfig();
	let kvId = existing?.kv_namespaces?.find((k) => k.binding === "OAUTH_KV")?.id;
	if (!/^[0-9a-f]{32}$/.test(kvId ?? "")) {
		writeConfig({ name, main: "src/index.ts", compatibility_date: "2026-10-01" });
		const { code, out } = wrangler(["kv", "namespace", "create", "OAUTH_KV"]);
		kvId = out.match(/"id":\s*"([0-9a-f]{32})"/)?.[1];
		if (!kvId) {
			const list = wrangler(["kv", "namespace", "list"]).out;
			const found = JSON.parse(list.slice(list.indexOf("["))).find((n) => n.title === `${name}-OAUTH_KV` || n.title === "OAUTH_KV");
			kvId = found?.id;
		}
		if (!kvId) fail(`Could not create the KV namespace (exit ${code}):\n${out.slice(-600)}`);
	}
	step(true, `KV namespace for OAuth state: ${kvId}`);

	const base = `https://${name}.${sub}.workers.dev`;
	writeConfig({
		$schema: "node_modules/wrangler/config-schema.json",
		name,
		main: "src/index.ts",
		compatibility_date: "2026-10-01",
		compatibility_flags: ["nodejs_compat"],
		workers_dev: true,
		preview_urls: false,
		vars: { MCP_RESOURCE: `${base}/mcp`, CANVAS_BASE_URL: canvasUrl, ALLOWED_GITHUB_USERS: githubUsers },
		kv_namespaces: [{ binding: "OAUTH_KV", id: kvId }],
		observability: { enabled: true },
		dev: { port: 8788 },
		secrets: { required: REQUIRED_SECRETS },
	});
	step(true, "wrote wrangler.jsonc");

	if (!secretNames().includes("COOKIE_ENCRYPTION_KEY")) {
		const { code, out } = wrangler(["secret", "put", "COOKIE_ENCRYPTION_KEY"], { input: randomBytes(32).toString("hex") });
		if (code !== 0) fail(`Could not set COOKIE_ENCRYPTION_KEY:\n${out.slice(-600)}`);
	}
	step(true, "COOKIE_ENCRYPTION_KEY (random, generated here, never shown)");

	console.log(`
SETUP_RESULT ${JSON.stringify({ url: base, mcp: `${base}/mcp`, callback: `${base}/callback` })}

Next, a human makes a GitHub OAuth App at https://github.com/settings/applications/new with:
  Application name:           Canvas MCP
  Homepage URL:               ${base}
  Authorization callback URL: ${base}/callback
  (leave Enable Device Flow unchecked)
Then store GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and CANVAS_API_TOKEN with scripts/set-secret.mjs (or set-secret.ps1 on Windows),
then run: node scripts/setup.mjs deploy`);
}

async function status() {
	const cfg = readConfig();
	const logged = isLoggedIn();
	step(logged, "Cloudflare login");
	step(!!cfg?.vars?.MCP_RESOURCE?.startsWith("https://"), `wrangler.jsonc configured${cfg?.vars?.MCP_RESOURCE ? ` (${cfg.vars.MCP_RESOURCE})` : ""}`);
	const have = logged && cfg ? secretNames() : [];
	for (const s of REQUIRED_SECRETS) step(have.includes(s), `secret ${s}`);
	if (cfg?.vars?.MCP_RESOURCE?.startsWith("https://")) {
		const r = await fetch(cfg.vars.MCP_RESOURCE, { method: "POST" }).catch(() => null);
		step(r?.status === 401, `deployed and answering (${r ? `POST /mcp -> ${r.status}` : "unreachable"})`);
	}
}

async function deploy() {
	const cfg = readConfig();
	if (!cfg?.vars?.MCP_RESOURCE?.startsWith("https://")) fail("Run `node scripts/setup.mjs init ...` first.");
	if (!isLoggedIn()) human("Cloudflare login. Run `npx wrangler login`, then rerun.");
	const missing = REQUIRED_SECRETS.filter((s) => !secretNames().includes(s));
	if (missing.length) human(`These secrets are not set yet: ${missing.join(", ")}. Use scripts/set-secret.mjs <NAME> (or set-secret.ps1 on Windows).`);
	const { code, out } = wrangler(["deploy"]);
	if (code !== 0) fail(`wrangler deploy failed:\n${out.slice(-1200)}`);
	step(true, "deployed");

	const mcp = cfg.vars.MCP_RESOURCE;
	const base = new URL(mcp).origin;
	const r1 = await fetch(mcp, { method: "POST" });
	step(r1.status === 401, `unauthenticated POST /mcp is refused (${r1.status})`);
	const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json().catch(() => ({}));
	step(prm.resource === mcp, "OAuth resource metadata points at this URL");
	const reg = await fetch(`${base}/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ redirect_uris: ["https://example.com/oauth/callback"], client_name: "setup smoke test", token_endpoint_auth_method: "none" }),
	});
	step(reg.status === 201 || reg.status === 200, `dynamic client registration works (${reg.status})`);
	if (r1.status !== 401 || prm.resource !== mcp) fail("Smoke test failed, see the unchecked lines above.");
	console.log(`\nDEPLOY_OK ${JSON.stringify({ connector_url: mcp })}
Add it to your AI app as a remote MCP server / custom connector with this URL (OAuth, Streamable HTTP): ${mcp}
  claude.ai: Settings > Connectors > Add custom connector
Optional full test with real Canvas data: node scripts/e2e.mjs`);
}

const run = { init, status, deploy }[cmd];
if (!run) {
	console.log("usage: node scripts/setup.mjs init --canvas-url <url> --github-user <user> [--name canvas-mcp] [--subdomain <pick>]\n       node scripts/setup.mjs status\n       node scripts/setup.mjs deploy");
	process.exit(cmd ? 1 : 0);
}
await run();
