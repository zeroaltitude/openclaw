/**
 * Real-runtime proof for openclaw-1azg.
 *
 * Behavior or issue addressed
 * ---------------------------
 * A gateway-managed CLI run died with
 *   `API Error: 400 tools.<n>.custom.input_schema: input_schema does not support
 *    oneOf, allOf, or anyOf at the top level`
 * followed by `candidate=anthropic/claude-opus-5 reason=unknown next=none`.
 * Two independent defects: a tool schema may reach a provider with a union at its
 * root, and the fallback ladder reported that deterministic 400 as `unknown`.
 *
 * What is real vs stubbed
 * -----------------------
 * Nothing under test is stubbed. The script drives:
 *  - the real `buildMcpToolSchema` from `src/gateway/mcp-http.schema.ts`, which is
 *    what `McpLoopbackToolCache.resolve` publishes as `toolSchema` for MCP
 *    `tools/list` (`src/gateway/mcp-http.runtime.ts`); no later stage rewrites the
 *    schema before it reaches the client,
 *  - the real `normalizeJsonSchemaForTypeBox` from `@openclaw/normalization-core`,
 *    whose `expandJsonSchemaTypeArray` rewrites a root `type: [...]` into a root
 *    `anyOf` at every level including the root,
 *  - the real `findToolInputSchemaTopLevelUnionError` publish-boundary guard,
 *  - the real `classifyFailoverReason` failover classifier and the real
 *    `shouldUseTransientCooldownProbeSlot` policy predicate.
 * There is no vitest, no network, and no mock of any of those seams.
 *
 * Scenarios
 * ---------
 *  1. authored root `anyOf` publishes as one object schema, every branch property
 *     preserved, `required` intersected across branches
 *  2. root `type: [...]` array expanded by the real normalizer into a root `anyOf`
 *     still publishes without a top-level union
 *  3. a plain object schema passes through byte-identical
 *  4. root `allOf` merges, with `required` unioned across branches
 *  5. an empty root union is removed rather than published
 *  6. the guard names a residual top-level union instead of letting it reach a provider
 *  7. the exact observed 400 text classifies as `format`, not `unknown`, and `format`
 *     does not consume a transient cooldown probe slot
 *
 * Run: pnpm tsx scripts/proof-tool-schema-top-level-union.ts
 */
import assert from "node:assert/strict";
import { normalizeJsonSchemaForTypeBox } from "@openclaw/normalization-core/json-schema";
import { shouldUseTransientCooldownProbeSlot } from "../src/agents/failover-policy.js";
import { classifyFailoverReason } from "../src/agents/failover/classify.js";
import { buildMcpToolSchema } from "../src/gateway/mcp-http.schema.js";
import { findToolInputSchemaTopLevelUnionError } from "../src/shared/json-schema-defaults.js";

const OBSERVED_API_ERROR =
  "API Error: 400 tools.2.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level";

function publish(name: string, parameters: Record<string, unknown>): Record<string, unknown> {
  // The projection reads only name, description and parameters off a loopback
  // tool, so a literal carrying exactly those is the honest input here. Same
  // narrowing the sibling unit tests use for this entry point.
  const [entry] = buildMcpToolSchema([{ name, description: "proof", parameters } as never]);
  assert.ok(entry, `expected ${name} to publish a schema entry`);
  return entry.inputSchema;
}

function assertNoTopLevelUnion(scenario: string, schema: Record<string, unknown>): void {
  const error = findToolInputSchemaTopLevelUnionError(schema, scenario);
  assert.equal(
    error,
    undefined,
    `${scenario}: published input_schema still carries a top-level union: ${JSON.stringify(schema)}`,
  );
  assert.equal(
    schema.type,
    "object",
    `${scenario}: published input_schema must be an object schema`,
  );
}

function requiredOf(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required) ? [...(schema.required as string[])].toSorted() : [];
}

// Scenario 1: an authored root union, the shape a discriminated-union output
// schema produces (z.toJSONSchema of a discriminated union emits root anyOf).
{
  const schema = publish("authored_root_union", {
    anyOf: [
      {
        type: "object",
        properties: { kind: { const: "succeeded" }, summary: { type: "string" } },
        required: ["kind", "summary"],
      },
      {
        type: "object",
        properties: { kind: { const: "failed" }, reason: { type: "string" } },
        required: ["kind", "reason"],
      },
    ],
  });
  assertNoTopLevelUnion("authored root union", schema);
  const properties = schema.properties as Record<string, unknown>;
  for (const key of ["kind", "summary", "reason"]) {
    assert.ok(Object.hasOwn(properties, key), `authored root union: lost property "${key}"`);
  }
  assert.deepEqual(
    properties.kind,
    { enum: ["succeeded", "failed"] },
    "authored root union: the discriminator must keep both branch literals",
  );
  // Only `kind` is required by every branch; an alternative-specific key is not.
  assert.deepEqual(requiredOf(schema), ["kind"], "authored root union: required must intersect");
  console.log("ok 1 - authored root union publishes as one object schema");
}

// Scenario 2: a root `type: [...]` array. The real normalizer's
// expandJsonSchemaTypeArray rewrites it into a root anyOf, so the publish
// boundary must survive a union it did not author.
{
  const expanded = normalizeJsonSchemaForTypeBox({
    type: ["object", "null"],
    properties: { value: { type: "string" } },
    required: ["value"],
  }) as Record<string, unknown>;
  assert.ok(
    Array.isArray(expanded.anyOf),
    "expected the real normalizer to expand a root type array into a root anyOf",
  );
  const schema = publish("expanded_type_array", expanded);
  assertNoTopLevelUnion("expanded type array", schema);
  const properties = schema.properties as Record<string, unknown>;
  assert.ok(
    Object.hasOwn(properties, "value"),
    "expanded type array: lost the property carried on every branch",
  );
  assert.deepEqual(
    requiredOf(schema),
    ["value"],
    "expanded type array: a key required by every branch stays required",
  );
  console.log("ok 2 - normalizer-manufactured root anyOf publishes without a top-level union");
}

// Scenario 3: an ordinary object schema must not be rewritten at all.
{
  const parameters = {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
    required: ["query"],
    additionalProperties: false,
  };
  const schema = publish("plain_object", structuredClone(parameters));
  assertNoTopLevelUnion("plain object", schema);
  assert.deepEqual(schema, parameters, "plain object: schema must pass through unchanged");
  console.log("ok 3 - plain object schema passes through unchanged");
}

// Scenario 4: a root allOf. Every branch holds, so required is the union.
{
  const schema = publish("root_all_of", {
    allOf: [
      { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
      { type: "object", properties: { right: { type: "number" } }, required: ["right"] },
    ],
  });
  assertNoTopLevelUnion("root allOf", schema);
  const properties = schema.properties as Record<string, unknown>;
  assert.deepEqual(properties.left, { type: "string" }, "root allOf: lost the first branch");
  assert.deepEqual(properties.right, { type: "number" }, "root allOf: lost the second branch");
  assert.deepEqual(requiredOf(schema), ["left", "right"], "root allOf: required must union");
  console.log("ok 4 - root allOf merges with required unioned across branches");
}

// Scenario 5: an empty root union is still a top-level union to the provider.
{
  const schema = publish("empty_root_union", { oneOf: [] });
  assertNoTopLevelUnion("empty root union", schema);
  console.log("ok 5 - empty root union is removed rather than published");
}

// Scenario 6: the guard names a residual union instead of deferring to a provider.
{
  const error = findToolInputSchemaTopLevelUnionError(
    { type: "object", properties: {}, allOf: [{ type: "object" }] },
    "residual_union_tool",
  );
  assert.ok(error, "expected the publish-boundary guard to reject a residual top-level union");
  assert.match(error, /residual_union_tool/, "the guard must name the offending tool");
  assert.match(error, /allOf/, "the guard must name the offending keyword");
  assert.equal(
    findToolInputSchemaTopLevelUnionError(
      { type: "object", properties: { value: { anyOf: [{ type: "string" }] } } },
      "nested_union_tool",
    ),
    undefined,
    "a nested union is legal and must not be reported",
  );
  console.log("ok 6 - guard names a residual top-level union and ignores nested unions");
}

// Scenario 7: the fallback ladder must not call this deterministic 400 unknown.
{
  const reason = classifyFailoverReason(OBSERVED_API_ERROR, { provider: "anthropic" });
  assert.equal(
    reason,
    "format",
    `expected the observed tool-definition 400 to classify as format, got ${String(reason)}`,
  );
  assert.equal(
    classifyFailoverReason("tools.7.custom.input_schema: unexpected keyword", {
      provider: "anthropic",
    }),
    "format",
    "the whole tools.<n>.input_schema family must classify as format",
  );
  assert.equal(
    shouldUseTransientCooldownProbeSlot(reason),
    false,
    "a tool-definition 400 is deterministic and must not spend a transient probe slot",
  );
  console.log("ok 7 - observed tool-definition 400 classifies as format, not unknown");
}

console.log("All runtime assertions passed.");
