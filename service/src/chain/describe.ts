import { formatUnits } from "viem";
import type { CapId, DecodedTimelockCall } from "./decode.js";

/** What we know about a token, from symbol()/decimals() reads. Missing values fall back to the address. */
export interface TokenInfo {
  symbol: string | null;
  decimals: number | null;
}
export type TokenLookup = (address: string) => TokenInfo | undefined;

const WAD = 10n ** 18n;

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function tokenName(addr: string, tokens: TokenLookup) {
  return tokens(addr.toLowerCase())?.symbol ?? short(addr);
}

/** Percentage from a WAD fraction, e.g. 915000000000000000 → "91.5%". */
export function wadToPercent(value: bigint): string {
  // formatUnits already drops trailing fractional zeros ("100", "91.5"), so no trimming is needed.
  return `${formatUnits(value * 100n, 18)}%`;
}

/** Human label for a cap's risk id. */
export function capIdLabel(id: CapId, tokens: TokenLookup): string {
  switch (id.kind) {
    case "adapter":
      return `adapter ${short(id.adapter)}`;
    case "collateral":
      return `collateral ${tokenName(id.token, tokens)}`;
    case "market":
      return `market ${tokenName(id.collateralToken, tokens)}/${tokenName(id.loanToken, tokens)} @ ${wadToPercent(id.lltv)} LLTV`;
    case "unknown":
      return id.tag ? `id "${id.tag}"` : "unrecognised id";
  }
}

/** Amount in the vault asset's units, with thousands separators; "unlimited" for max-uint caps. */
export function formatAssetAmount(raw: bigint, asset: TokenInfo | undefined, unlimited: boolean): string {
  if (unlimited) return "unlimited";
  if (asset?.decimals == null) return raw.toString();
  const [whole, frac] = formatUnits(raw, asset.decimals).split(".");
  const grouped = BigInt(whole!).toLocaleString("en-US");
  return `${grouped}${frac ? `.${frac.slice(0, 2)}` : ""} ${asset.symbol ?? ""}`.trim();
}

function formatDuration(seconds: bigint): string {
  const s = Number(seconds);
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  return `${s}s`;
}

/**
 * One-line summary of a submitted change, used in the API and in webhook payloads.
 * `asset` is the vault's asset (caps are denominated in it).
 */
export function describeChange(d: DecodedTimelockCall, tokens: TokenLookup, asset: TokenInfo | undefined): string {
  const a = d.args ?? {};
  const str = (k: string) => String(a[k] ?? "");
  switch (d.functionName) {
    case "increaseAbsoluteCap":
      return `Increase absolute cap on ${capIdLabel(d.capId!, tokens)} to ${formatAssetAmount(BigInt(str("newAbsoluteCap")), asset, d.unlimited)}`;
    case "increaseRelativeCap":
      return `Increase relative cap on ${capIdLabel(d.capId!, tokens)} to ${wadToPercent(BigInt(str("newRelativeCap")))}`;
    case "addAdapter":
      return `Add adapter ${str("account")}`;
    case "removeAdapter":
      return `Remove adapter ${str("account")}`;
    case "increaseTimelock":
      return `Increase timelock of ${d.targetFunction} to ${formatDuration(BigInt(str("newDuration")))}`;
    case "decreaseTimelock":
      return `Decrease timelock of ${d.targetFunction} to ${formatDuration(BigInt(str("newDuration")))}`;
    case "abdicate":
      return `Abdicate ${d.targetFunction} (it can never be called again)`;
    case "setIsAllocator":
      return `${a.newIsAllocator ? "Add" : "Remove"} allocator ${str("account")}`;
    case "setPerformanceFee":
      return `Set performance fee to ${wadToPercent(BigInt(str("newPerformanceFee")))}`;
    case "setManagementFee":
      // Stored per second in WAD; show the yearly rate.
      return `Set management fee to ${wadToPercent(BigInt(str("newManagementFee")) * 31_536_000n)} per year`;
    case "setPerformanceFeeRecipient":
      return `Set performance fee recipient to ${str("newPerformanceFeeRecipient")}`;
    case "setManagementFeeRecipient":
      return `Set management fee recipient to ${str("newManagementFeeRecipient")}`;
    case "setForceDeallocatePenalty":
      return `Set force-deallocate penalty for adapter ${str("adapter")} to ${wadToPercent(BigInt(str("newForceDeallocatePenalty")))}`;
    case "setAdapterRegistry":
      return `Set adapter registry to ${str("newAdapterRegistry")}`;
    case "setReceiveSharesGate":
    case "setSendSharesGate":
    case "setReceiveAssetsGate":
    case "setSendAssetsGate":
      return `${d.functionName} to ${Object.values(a)[0]}`;
    default:
      return d.isTimelockedFunction
        ? `${d.functionName}(${Object.values(a).join(", ")})`
        : `Submitted ${d.functionName ?? `unknown selector ${d.selector}`}, which is not a timelocked function and can never be executed`;
  }
}

export { WAD };
