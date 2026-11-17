import { describe, expect, it } from "vitest";
import { createYoga } from "graphql-yoga";
import { schema, type GraphQLContext } from "./schema.js";
import { graphiqlPage, playgroundTabs, PLAYGROUND_VERSION } from "./playground.js";
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

  it("every tab gets a distinct title (GraphiQL's own title rule, else it shows <untitled>)", () => {
    // Copied from GraphiQL: the first non-comment line with `query|mutation|subscription <Name>`.
    const title = (q: string) => /^(?!#).*(query|subscription|mutation)\s+([a-zA-Z0-9_]+)/m.exec(q)?.[2] ?? null;
    const titles = playgroundTabs.map((t) => title(t.query));
    expect(titles.every((t) => t !== null)).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles[0]).toBe("Step1_IsItHealthy");
  });

  it("the page resets saved GraphiQL tabs before GraphiQL loads", () => {
    const html = graphiqlPage({ title: "t", defaultTabs: playgroundTabs });
    const reset = html.indexOf("watcher:playground-version");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(html.indexOf("yoga-graphiql")); // runs before the GraphiQL bundle
    expect(html).toContain(PLAYGROUND_VERSION);
  });

  it("does not expose a GraphQL subscription root (webhook subscribers are a separate type)", () => {
    expect(schema.getSubscriptionType()).toBeFalsy();
  });
});
