// Gateway tests cover MCP loopback schema projection behavior.
import { describe, expect, it } from "vitest";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

describe("buildMcpToolSchema", () => {
  it("keeps union schema properties named like Object prototype keys", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: {
                toString: { type: "string" },
              },
              required: ["toString"],
            },
          ],
        },
      } as never,
    ]);

    const inputSchema = entry?.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    const propertySchema = inputSchema?.properties?.["toString"];

    expect(Object.hasOwn(inputSchema?.properties ?? {}, "toString")).toBe(true);
    expect(propertySchema).toEqual({ type: "string" });
    expect(inputSchema?.required).toEqual(["toString"]);
  });

  it("serializes union schema properties named __proto__ as own keys", () => {
    const protoKey = "__proto__";
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: Object.fromEntries([[protoKey, { type: "string" }]]),
              required: [protoKey],
            },
          ],
        },
      } as never,
    ]);

    const inputSchema = entry?.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;

    expect(Object.hasOwn(inputSchema?.properties ?? {}, protoKey)).toBe(true);
    expect(inputSchema?.properties?.[protoKey]).toEqual({ type: "string" });
    expect(JSON.stringify(inputSchema?.properties)).toContain('"__proto__"');
    expect(inputSchema?.required).toEqual([protoKey]);
  });

  it("does not keep inherited prototype names as required schema keys", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: {
                value: { type: "string" },
              },
              required: ["toString"],
            },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema.required).toEqual([]);
  });

  // openclaw-1azg: native tool definitions reject allOf/anyOf/oneOf at the root of
  // a tool input schema, so every top-level union keyword has to be collapsed here.
  it("merges a top-level allOf and keeps every branch's required keys", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          allOf: [
            { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
            { type: "object", properties: { right: { type: "number" } }, required: ["right"] },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema).toMatchObject({
      type: "object",
      properties: { left: { type: "string" }, right: { type: "number" } },
    });
    expect(Object.hasOwn(entry?.inputSchema ?? {}, "allOf")).toBe(false);
    expect((entry?.inputSchema.required as string[] | undefined)?.toSorted()).toEqual([
      "left",
      "right",
    ]);
  });

  it("keeps root properties and required when a top-level union is flattened", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          type: "object",
          properties: { root: { type: "string" } },
          required: ["root"],
          anyOf: [
            { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema).toMatchObject({
      type: "object",
      properties: { root: { type: "string" }, branch: { type: "string" } },
    });
    expect((entry?.inputSchema.required as string[] | undefined)?.toSorted()).toEqual([
      "branch",
      "root",
    ]);
  });

  it("drops an empty top-level union instead of publishing it", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: { oneOf: [] },
      } as never,
    ]);

    expect(entry?.inputSchema).toEqual({ type: "object", properties: {}, required: [] });
  });

  it("passes a plain object schema through unchanged", () => {
    const parameters = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    };
    const [entry] = buildMcpToolSchema([
      { name: "proof_tool", description: "proof", parameters } as never,
    ]);

    expect(entry?.inputSchema).toEqual(parameters);
  });
});
