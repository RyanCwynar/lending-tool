import { describe, expect, it } from "vitest";
import { createYoga } from "graphql-yoga";
import { schema, type GraphQLContext } from "./schema.js";
import { playgroundTabs } from "./playground.js";
import { testConfig } from "../test/harness.js";

/**
 * Every saved GraphiQL query must stay valid against the schema the server actually serves. We send each one through
 * Yoga with a stub database (empty results). GraphQL validation errors come back without a `path`; errors raised
 * while resolving (expected here, the stubs return nothing) carry one. So: no path-less errors = valid query.
 */
const stubContext = {
  pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  rpc: { getChainId: async () => 8453, getBlockNumber: async () => 0n },
  config: testConfig({}),
  encryptionKey: null,
} as unknown as GraphQLContext;
const yoga = createYoga({ schema, context: () => stubContext, logging: false, maskedErrors: false });

describe("GraphiQL saved queries", () => {
  it.each(playgroundTabs.map((t) => [t.query.split("\n").find((l) => /^(query|mutation)/.test(l)) ?? "?", t] as const))(
    "%s is valid against the schema",
    async (_name, t) => {
      const res = await yoga.fetch("http://test/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: t.query, variables: t.variables ? JSON.parse(t.variables) : undefined }),
      });
      const body = (await res.json()) as { errors?: { message: string; path?: unknown }[] };
      const validationErrors = (body.errors ?? []).filter((e) => !e.path).map((e) => e.message);
      expect(validationErrors).toEqual([]);
    },
  );

  it("does not expose a GraphQL subscription root (webhook subscribers are a separate type)", () => {
    expect(schema.getSubscriptionType()).toBeFalsy();
  });
});
