import type { ToolModule } from "@osiris/core/tools/module.ts";
import { ImageError } from "./errors.ts";
import { ComfyUploadApi } from "./http.ts";
import { ImageService, type ImageOptions } from "./service.ts";
import { ImageJobStore } from "./store.ts";
import { imageTools } from "./tools.ts";

export interface ImagesToolOptions extends ImageOptions {
  /** Optional runtime bootstrap credential; sealed into the project vault at init, never sent to the model. */
  comfyApiKey?: string;
}

/** Image generation and editing through the Comfy Cloud MCP server (needs the features `files` and `mcp`). */
export function imagesModule({ comfyApiKey, ...options }: ImagesToolOptions = {}): ToolModule {
  const server = options.server ?? "comfy-cloud";
  const keyName = options.uploadApiKeySecret ?? "COMFY_API_KEY";
  return {
    name: "images",
    feature: "files",
    create: (host) => {
      const { features, usage, files, mcp, secrets, mcpServers } = host;
      const images = new ImageService(
        new ImageJobStore(host.records),
        files,
        mcp,
        host.models.tools,
        {
          ...options,
          uploadApi: options.uploadApi ?? (options.apiUploadFallback ? new ComfyUploadApi(secrets, options.uploadApiKeySecret, host.fetch) : undefined),
          authorize: async (ctx) => {
            const on = await features.get(), q = await features.quotas();
            if (!on.files || !on.mcp || ctx.channel === "public") throw new ImageError("IMAGE_ACCESS_DISABLED");
            if (
              (q.tokensPerMonth !== null && (await usage.tokens()) >= q.tokensPerMonth) ||
              (q.tokensPerUserMonth !== null && (await usage.tokens(Date.now(), { user: ctx.user_id })) >= q.tokensPerUserMonth)
            )
              throw new ImageError("TOKEN_QUOTA_EXHAUSTED");
            await options.authorize?.(ctx);
          },
        },
        (ctx, tokens) => usage.add(tokens, Date.now(), { user: ctx.user_id }),
      );
      return {
        tools: imageTools(images, files),
        usable: async (_ctx, on) => () => on.mcp,
        // The agent uses the image tools, never the image server's raw MCP tools.
        hidesMcpTool: (name) => name.startsWith(`${server}_`),
        init: async () => {
          if (comfyApiKey) {
            if (!(await secrets.list("")).some((s) => s.name === keyName))
              await secrets.put(keyName, "", { value: comfyApiKey, allowedHosts: ["cloud.comfy.org"], description: "Comfy Cloud runtime credential" });
            if (!(await mcpServers.get(server, ""))) {
              await mcpServers.put(server, "", { url: "https://cloud.comfy.org/mcp", auth: "headers", enabled: true, headers: { "X-API-Key": `{{secret:${keyName}}}` } });
              mcp.invalidate("");
            }
          }
          await images.cleanup();
        },
      };
    },
  };
}

export * from "./errors.ts";
export * from "./http.ts";
export * from "./service.ts";
export * from "./store.ts";
export * from "./tools.ts";
