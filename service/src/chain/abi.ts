import { parseAbi } from "viem";

/**
 * The three Vault V2 timelock events (reference/vault-v2/src/libraries/EventsLib.sol).
 * The emitting address is the vault, so one getLogs over many vault addresses covers them all.
 */
export const timelockEventsAbi = parseAbi([
  "event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)",
  "event Accept(bytes4 indexed selector, bytes data)",
  "event Revoke(address indexed sender, bytes4 indexed selector, bytes data)",
]);

/**
 * Every timelocked function on Vault V2 (reference/vault-v2/src/interfaces/IVaultV2.sol).
 * `submit(data)` stores calldata for one of these; `accept` happens by calling it once the timelock has passed.
 */
export const timelockedFunctionsAbi = parseAbi([
  "function setIsAllocator(address account, bool newIsAllocator)",
  "function setReceiveSharesGate(address newReceiveSharesGate)",
  "function setSendSharesGate(address newSendSharesGate)",
  "function setReceiveAssetsGate(address newReceiveAssetsGate)",
  "function setSendAssetsGate(address newSendAssetsGate)",
  "function setAdapterRegistry(address newAdapterRegistry)",
  "function addAdapter(address account)",
  "function removeAdapter(address account)",
  "function increaseTimelock(bytes4 selector, uint256 newDuration)",
  "function decreaseTimelock(bytes4 selector, uint256 newDuration)",
  "function abdicate(bytes4 selector)",
  "function setPerformanceFee(uint256 newPerformanceFee)",
  "function setManagementFee(uint256 newManagementFee)",
  "function setPerformanceFeeRecipient(address newPerformanceFeeRecipient)",
  "function setManagementFeeRecipient(address newManagementFeeRecipient)",
  "function increaseAbsoluteCap(bytes idData, uint256 newAbsoluteCap)",
  "function increaseRelativeCap(bytes idData, uint256 newRelativeCap)",
  "function setForceDeallocatePenalty(address adapter, uint256 newForceDeallocatePenalty)",
]);

/**
 * Functions that are NOT timelocked but show up in real Submit calldata anyway: `submit` accepts any bytes.
 * Known only so we can name them; such submissions can never be accepted (see research §5).
 */
export const nonTimelockedFunctionsAbi = parseAbi([
  "function setName(string newName)",
  "function setSymbol(string newSymbol)",
  "function setIsSentinel(address account, bool newIsSentinel)",
  "function setLiquidityAdapterAndData(address newLiquidityAdapter, bytes newLiquidityData)",
  "function setOwner(address newOwner)",
  "function setCurator(address newCurator)",
  "function setMaxRate(uint256 newMaxRate)",
  "function decreaseAbsoluteCap(bytes idData, uint256 newAbsoluteCap)",
  "function decreaseRelativeCap(bytes idData, uint256 newRelativeCap)",
]);

export const vaultReadAbi = parseAbi([
  "function name() view returns (string)",
  "function asset() view returns (address)",
]);

export const erc20ReadAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
