#!/usr/bin/env node
// Usage (a human runs this in a real terminal, input is hidden):
//   node scripts/set-secret.mjs CANVAS_API_TOKEN
//   node scripts/set-secret.mjs GITHUB_CLIENT_ID
//   node scripts/set-secret.mjs GITHUB_CLIENT_SECRET
// The Canvas token is checked against Canvas before it is saved.
import { createInterface } from "node:readline";
import { readConfig, REQUIRED_SECRETS, wrangler } from "./lib.mjs";

const name = process.argv[2];
if (!REQUIRED_SECRETS.includes(name) || name === "COOKIE_ENCRYPTION_KEY") {
	console.log("usage: node scripts/set-secret.mjs CANVAS_API_TOKEN | GITHUB_CLIENT_ID | GITHUB_CLIENT_SECRET");
	process.exit(1);
}
if (!process.stdin.isTTY) {
	console.error("This needs a real terminal so the value can be typed or pasted hidden. Open a terminal window and run it there.");
	process.exit(2);
}

function askHidden(question) {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		rl._writeToOutput = (s) => {
			if (s.includes(question)) process.stdout.write(s);
		};
		rl.question(question, (v) => {
			rl.close();
			process.stdout.write("\n");
			resolve(v);
		});
	});
}

const value = (await askHidden(`Paste ${name} (hidden) and press Enter: `)).replace(/^\s*Bearer\s+/i, "").trim();
if (!value) {
	console.log("Nothing pasted, nothing saved.");
	process.exit(1);
}

if (name === "CANVAS_API_TOKEN") {
	const base = readConfig()?.vars?.CANVAS_BASE_URL;
	if (!base) {
		console.error("Run setup first (wrangler.jsonc has no CANVAS_BASE_URL).");
		process.exit(1);
	}
	process.stdout.write("Checking the token with Canvas... ");
	const res = await fetch(`${base}/api/v1/users/self`, { headers: { Authorization: `Bearer ${value}` } }).catch(() => null);
	if (res?.status !== 200) {
		console.log(`rejected (${res ? res.status : "no response"}). You pasted ${value.length} characters; a Canvas token is usually about 70 and has a ~ in it.`);
		process.exit(1);
	}
	console.log("valid.");
}

const { code, out } = wrangler(["secret", "put", name], { input: value });
if (code !== 0) {
	console.error(`Saving failed:\n${out.slice(-600)}`);
	process.exit(1);
}
console.log(`${name} saved to Cloudflare.`);
