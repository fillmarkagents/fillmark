// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    IPonsV2Factory,
    IPonsV2Locker,
    IPonsV2MemeHook,
    IV4PoolManager,
    IV4PositionManager,
    IV4UnlockCallback
} from "./interfaces/ExternalV2.sol";

/// Receives Fillmark's per-fill fees in USDG and spends them, and only them, on
/// $FILLMARK from its graduated Pons V2 pool, sending what it buys to 0xdEaD.
/// Nothing can withdraw the USDG. Anyone may call burn(), at most once an hour, and
/// each call buys at most 0.5% of the USDG side of the pool's locked Pons position.
/// That size is the sandwich protection: with the hook's fee on every swap, pushing
/// the price around a buy that small costs more than it can take from it.
contract FillmarkBurner is IV4UnlockCallback {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant INTERVAL = 1 hours;
    uint256 public constant CAP_BPS = 50; // 0.5%
    // A sandwich around a burn loses money while each swap pays at least this much in pool
    // fees (Pons charges its hook fee; the LP fee is 0). The Pons default is 100.
    uint256 public constant MIN_SWAP_FEE_BPS = 100;
    uint8 private constant POOL_CREATED = 2;
    bytes32 private constant POOLS_SLOT = bytes32(uint256(6)); // v4-core StateLibrary
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    address public immutable usdg;
    address public immutable admin; // the timelock; it can only set the token, once
    IPonsV2Factory public immutable pons;
    IV4PoolManager public immutable poolManager;
    IV4PositionManager public immutable positionManager;

    address public token;
    uint256 public positionId; // the Pons-locked full-range position of the pool
    uint64 public lastBurn;
    IV4PoolManager.PoolKey private _key;

    event TokenSet(address indexed token, bytes32 poolId, uint256 positionId);
    event Burned(uint256 usdgIn, uint256 tokenOut);

    error BadConfig();
    error NotAdmin();
    error AlreadySet();
    error BadToken();
    error NoToken();
    error TooSoon();
    error NothingToBurn();
    error NotPoolManager();
    error BadSettle();

    constructor(address usdg_, address admin_, IPonsV2Factory pons_) {
        if (usdg_ == address(0) || admin_ == address(0) || address(pons_) == address(0)) revert BadConfig();
        usdg = usdg_;
        admin = admin_;
        pons = pons_;
        poolManager = IV4PoolManager(pons_.poolManager());
        positionManager = IV4PositionManager(pons_.positionManager());
        if (address(poolManager) == address(0) || address(positionManager) == address(0)) revert BadConfig();
    }

    /// Accepted only for a Pons V2 launch paired with USDG whose pool exists, is
    /// registered with the Pons hook for this token, and whose position Pons locked.
    function setToken(address token_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (token != address(0)) revert AlreadySet();
        if (token_ == address(0)) revert BadToken();
        IPonsV2Factory.LaunchedToken memory l = pons.getLaunchedToken(token_);
        if (!l.exists || l.token != token_ || l.pairToken != usdg || l.phase != POOL_CREATED) revert BadToken();

        IV4PoolManager.PoolKey memory key = IV4PoolManager.PoolKey({
            currency0: token_ < usdg ? token_ : usdg,
            currency1: token_ < usdg ? usdg : token_,
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: pons.memeHook()
        });
        bytes32 id = poolIdOf(key);
        IPonsV2MemeHook.LaunchInfo memory info = IPonsV2MemeHook(key.hooks).launches(id);
        if (!info.registered || info.memecoin != token_ || info.quoteToken != usdg) revert BadToken();
        if (uint256(info.hookFeeBps) + info.creatorTaxBps < MIN_SWAP_FEE_BPS) revert BadToken();

        IPonsV2Locker locker = IPonsV2Locker(pons.locker());
        if (!locker.isLocked(token_)) revert BadToken();
        uint256 pid = locker.lockedPositions(token_);
        if (positionManager.ownerOf(pid) != address(locker) || positionManager.getPositionLiquidity(pid) == 0) {
            revert BadToken();
        }

        token = token_;
        positionId = pid;
        _key = key;
        emit TokenSet(token_, id, pid);
    }

    /// Spends up to 0.5% of the locked position's USDG side on the token and sends it to 0xdEaD.
    function burn() external returns (uint256 usdgIn, uint256 tokenOut) {
        if (token == address(0)) revert NoToken();
        if (block.timestamp < lastBurn + INTERVAL) revert TooSoon();
        lastBurn = SafeCast.toUint64(block.timestamp);
        uint256 amount = Math.min(IERC20(usdg).balanceOf(address(this)), maxBurn());
        if (amount == 0) revert NothingToBurn();
        (usdgIn, tokenOut) = abi.decode(poolManager.unlock(abi.encode(amount)), (uint256, uint256));
        // lastBurn is already set; the pool manager calls back only unlockCallback.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Burned(usdgIn, tokenOut);
    }

    /// Largest USDG amount one burn() may spend now.
    function maxBurn() public view returns (uint256) {
        if (token == address(0)) return 0;
        uint256 liquidity = positionManager.getPositionLiquidity(positionId);
        uint160 sqrtPrice = sqrtPriceX96();
        // The full-range position's USDG amount at the current price.
        uint256 side = _key.currency1 == usdg
            ? Math.mulDiv(liquidity, sqrtPrice, 1 << 96)
            : Math.mulDiv(liquidity, 1 << 96, sqrtPrice);
        return side * CAP_BPS / 1e4;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amount = abi.decode(data, (uint256));
        IV4PoolManager.PoolKey memory key = _key;
        bool usdgIs0 = key.currency0 == usdg;
        int256 delta = poolManager.swap(
            key,
            IV4PoolManager.SwapParams({
                zeroForOne: usdgIs0,
                amountSpecified: -SafeCast.toInt256(amount),
                sqrtPriceLimitX96: usdgIs0 ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 amount0 = int128(delta >> 128);
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 amount1 = int128(delta);
        (int128 paid, int128 got) = usdgIs0 ? (amount0, amount1) : (amount1, amount0);
        uint256 usdgIn = SafeCast.toUint256(-int256(paid));
        uint256 tokenOut = SafeCast.toUint256(int256(got));

        poolManager.sync(usdg);
        IERC20(usdg).safeTransfer(address(poolManager), usdgIn);
        if (poolManager.settle() != usdgIn) revert BadSettle();
        poolManager.take(token, DEAD, tokenOut);
        return abi.encode(usdgIn, tokenOut);
    }

    function poolKey() external view returns (IV4PoolManager.PoolKey memory) {
        return _key;
    }

    function poolId() external view returns (bytes32) {
        return poolIdOf(_key);
    }

    function sqrtPriceX96() public view returns (uint160) {
        bytes32 data = poolManager.extsload(keccak256(abi.encodePacked(poolIdOf(_key), POOLS_SLOT)));
        return uint160(uint256(data));
    }

    function poolIdOf(IV4PoolManager.PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }
}
