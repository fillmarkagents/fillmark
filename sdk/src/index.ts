export { ADDRESSES, ASSETS, CHAIN_ID, ROUTER_DEPLOY_BLOCK, assetOf, type Asset } from "./addresses.js";
export {
  DEFAULT_POLICY,
  fillmarkAgent,
  type AgentOptions,
  type Client,
  type FillIntent,
  type FillResult,
  type FillmarkAgent,
  type Book,
  type Market,
  type Policy,
  type Position,
  type Quote,
  type Session,
} from "./agent.js";
import { accountStatus as status, isPlainKernel as plain } from "./account.js";
import { safely } from "./errors.js";
/// A client account as the router sees it: owner, permission, USDG and the installed agent's book.
export const accountStatus: typeof status = safely(status);
/// Whether an account is a standard Kernel v3.1 account without a hook on the router.
export const isPlainKernel: typeof plain = safely(plain);
export { FillmarkError, REASONS, errorName } from "./errors.js";
export { MIN_NOTIONAL, bucketOf, buyRoom, costFloor, diffPpm, navValue, navValueCeil, priceLimit, spotPrice } from "./math.js";
export { memoryStore, type Store } from "./store.js";
export { feedsAbi, payAbi, routerAbi } from "./generated/abi.js";
