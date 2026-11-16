import { GraphQLScalarType, Kind } from "graphql";

/**
 * Onchain integers (uint256 amounts, block numbers) don't fit in a GraphQL Int (32-bit) or Float (precision loss).
 * Serialize as decimal strings and parse back into bigint.
 */
/** Arbitrary JSON (decoded arguments, webhook payloads). Output only. */
export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value.",
  serialize: (value) => value,
});

export const BigIntScalar = new GraphQLScalarType<bigint, string>({
  name: "BigInt",
  description: "Arbitrary-precision integer, serialized as a base-10 string.",
  serialize(value) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" && /^-?\d+$/.test(value)) return value; // pg int8/numeric come back as strings
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    throw new TypeError(`BigInt cannot serialize ${typeof value}: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    throw new TypeError("BigInt must be an integer string or a safe integer");
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
      if (/^-?\d+$/.test(ast.value)) return BigInt(ast.value);
    }
    throw new TypeError("BigInt literal must be an integer");
  },
});
