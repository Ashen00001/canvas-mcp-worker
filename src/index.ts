import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { GitHubHandler } from "./github-handler";
import { registerTools } from "./tools";
import { isAllowed, type Props } from "./utils";

function createServer() {
	const server = new McpServer({ name: "Canvas (read-only)", version: "1.0.0" });
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (props && isAllowed(props.login, env.ALLOWED_GITHUB_USERS)) {
		registerTools(server, { baseUrl: env.CANVAS_BASE_URL, token: env.CANVAS_API_TOKEN });
	}
	return server;
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		const props = (ctx as any).props as Props | undefined;
		if (!props || !isAllowed(props.login, bindings.ALLOWED_GITHUB_USERS)) {
			return new Response("Forbidden", { status: 403 });
		}
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
