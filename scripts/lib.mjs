import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = join(ROOT, "wrangler.jsonc");
export const REQUIRED_SECRETS = ["COOKIE_ENCRYPTION_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "CANVAS_API_TOKEN"];

export function readJsonc(path) {
	const raw = readFileSync(path, "utf8")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(raw);
}

export function readConfig() {
	return existsSync(CONFIG) ? readJsonc(CONFIG) : null;
}

export function writeConfig(cfg) {
	writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
}

export function wrangler(args, { input, quiet = true } = {}) {
	const win = process.platform === "win32";
	const r = spawnSync(win ? `npx --no-install wrangler ${args.join(" ")}` : "npx", win ? [] : ["--no-install", "wrangler", ...args], {
		cwd: ROOT,
		input,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: [input === undefined ? "inherit" : "pipe", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
	});
	return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export function isLoggedIn() {
	const { out } = wrangler(["whoami"]);
	return /You are logged in/i.test(out);
}

export function secretNames() {
	const { code, out } = wrangler(["secret", "list"]);
	if (code !== 0) return [];
	return [...out.matchAll(/"name":\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

function wranglerOAuthToken() {
	if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
	const candidates = [
		process.env.APPDATA && join(process.env.APPDATA, "xdg.config", ".wrangler", "config", "default.toml"),
		join(homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
		join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), ".wrangler", "config", "default.toml"),
		join(homedir(), ".wrangler", "config", "default.toml"),
	].filter(Boolean);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		const m = readFileSync(p, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
		if (m) return m[1];
	}
	return null;
}

export async function cfApi(path, init = {}) {
	const token = wranglerOAuthToken();
	if (!token) throw new Error("No Cloudflare credentials found. Run `npx wrangler login` first.");
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	const body = await res.json().catch(() => ({}));
	return { status: res.status, body };
}

export async function accountId() {
	if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
	const { status, body } = await cfApi("/accounts");
	if (status !== 200 || !body.result?.length) throw new Error(`Could not list Cloudflare accounts (HTTP ${status}).`);
	if (body.result.length > 1) {
		throw new Error(
			`This login has ${body.result.length} Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID to one of: ` +
				body.result.map((a) => `${a.id} (${a.name})`).join(", "),
		);
	}
	return body.result[0].id;
}

export function step(ok, text) {
	console.log(`${ok ? "[x]" : "[ ]"} ${text}`);
}
