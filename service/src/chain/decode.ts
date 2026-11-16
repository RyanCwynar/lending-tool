import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  toFunctionSelector,
  type Hex,
} from "viem";
import { nonTimelockedFunctionsAbi, timelockedFunctionsAbi } from "./abi.js";

/** Risk id behind a cap. Ids are keccak256(idData); the Blue market adapter uses these three shapes. */
export type CapId =
  | { kind: "adapter"; adapter: `0x${string}` }
  | { kind: "collateral"; token: `0x${string}` }
  | {
      kind: "market";
      adapter: `0x${string}`;
      loanToken: `0x${string}`;
      collateralToken: `0x${string}`;
      oracle: `0x${string}`;
      irm: `0x${string}`;
      lltv: bigint; // WAD: 1e18 = 100%
    }
  | { kind: "unknown"; tag: string | null };

const marketParamsTuple = {
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;

/**
 * Decode cap idData. Shapes from reference/vault-v2/src/adapters/MorphoMarketV1AdapterV2.sol:
 *   abi.encode("this", adapter)                        → adapter id
 *   abi.encode("collateralToken", token)               → collateral id
 *   abi.encode("this/marketParams", adapter, params)   → market id
 * Anything else (other adapter types, garbage) is returned as unknown instead of throwing.
 */
export function decodeCapId(idData: Hex): CapId {
  let tag: string;
  try {
    [tag] = decodeAbiParameters([{ type: "string" }], idData);
  } catch {
    return { kind: "unknown", tag: null };
  }
  try {
    if (tag === "this") {
      const [, adapter] = decodeAbiParameters([{ type: "string" }, { type: "address" }], idData);
      return { kind: "adapter", adapter: getAddress(adapter) };
    }
    if (tag === "collateralToken") {
      const [, token] = decodeAbiParameters([{ type: "string" }, { type: "address" }], idData);
      return { kind: "collateral", token: getAddress(token) };
    }
    if (tag === "this/marketParams") {
      const [, adapter, mp] = decodeAbiParameters(
        [{ type: "string" }, { type: "address" }, marketParamsTuple],
        idData,
      );
      return {
        kind: "market",
        adapter: getAddress(adapter),
        loanToken: getAddress(mp.loanToken),
        collateralToken: getAddress(mp.collateralToken),
        oracle: getAddress(mp.oracle),
        irm: getAddress(mp.irm),
        lltv: mp.lltv,
      };
    }
  } catch {
    // fall through: tag looked right but the body didn't decode
  }
  return { kind: "unknown", tag };
}

const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Curators set "no limit" as type(uint128).max or type(uint256).max (both seen onchain). */
export function isUnlimitedCap(value: bigint): boolean {
  return value === UINT128_MAX || value === UINT256_MAX;
}

/** selector → function name, for both timelocked functions and the non-timelocked ones seen in the wild. */
const selectorNames = new Map<string, string>(
  [...timelockedFunctionsAbi, ...nonTimelockedFunctionsAbi].map((f) => [toFunctionSelector(f), f.name]),
);
const timelockedNames = new Set<string>(timelockedFunctionsAbi.map((f) => f.name));

export function selectorName(selector: Hex): string | null {
  return selectorNames.get(selector.toLowerCase()) ?? null;
}

/** JSON-safe value: bigints become decimal strings, nested arrays/objects are converted recursively. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export function toJson(value: unknown): JsonValue {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return (value ?? null) as JsonValue;
}

export interface DecodedTimelockCall {
  selector: Hex;
  /** Function name, or null if the selector is not one we know. */
  functionName: string | null;
  /** False for calldata that `accept` can never execute (not a timelocked function, or undecodable). */
  isTimelockedFunction: boolean;
  /** Decoded named arguments (JSON-safe), or null if the calldata didn't decode. */
  args: Record<string, JsonValue> | null;
  /** Extra interpretation for cap increases and timelock changes. */
  capId: CapId | null;
  unlimited: boolean;
  targetFunction: string | null; // for increaseTimelock / decreaseTimelock / abdicate
}

/**
 * Decode the calldata stored by `submit(data)`. Never throws: real vaults contain submissions of
 * non-timelocked functions and we must still record them (research §5, lesson 3).
 */
export function decodeTimelockCall(data: Hex): DecodedTimelockCall {
  const selector = (data.length >= 10 ? data.slice(0, 10) : data).toLowerCase() as Hex;
  const result: DecodedTimelockCall = {
    selector,
    functionName: selectorName(selector),
    isTimelockedFunction: false,
    args: null,
    capId: null,
    unlimited: false,
    targetFunction: null,
  };

  for (const abi of [timelockedFunctionsAbi, nonTimelockedFunctionsAbi]) {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi, data });
    } catch {
      continue;
    }
    const fn = abi.find((f) => f.name === decoded.functionName);
    const args: Record<string, JsonValue> = {};
    fn?.inputs.forEach((input, i) => {
      args[input.name ?? `arg${i}`] = toJson(decoded.args?.[i]);
    });
    result.functionName = decoded.functionName;
    result.isTimelockedFunction = timelockedNames.has(decoded.functionName);
    result.args = args;

    if (decoded.functionName === "increaseAbsoluteCap" || decoded.functionName === "increaseRelativeCap") {
      const [idData, newCap] = decoded.args as readonly [Hex, bigint];
      result.capId = decodeCapId(idData);
      result.unlimited = decoded.functionName === "increaseAbsoluteCap" && isUnlimitedCap(newCap);
    }
    if (
      decoded.functionName === "increaseTimelock" ||
      decoded.functionName === "decreaseTimelock" ||
      decoded.functionName === "abdicate"
    ) {
      const target = (decoded.args as readonly unknown[])[0] as Hex;
      result.targetFunction = selectorName(target) ?? target;
    }
    return result;
  }
  return result;
}
