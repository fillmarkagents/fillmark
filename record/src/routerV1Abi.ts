// Generated from the FillmarkRouter build in github.com/fillmarkagents/fillmark (agent/src/abi.generated.ts).
export const routerV1Abi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "identity_",
        "type": "address",
        "internalType": "contract IIdentityRegistry"
      },
      {
        "name": "reputation_",
        "type": "address",
        "internalType": "contract IReputationRegistry"
      },
      {
        "name": "factory_",
        "type": "address",
        "internalType": "contract IUniswapV3Factory"
      },
      {
        "name": "usdg_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "feeds_",
        "type": "address",
        "internalType": "contract FillmarkFeeds"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "INTENT_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_SLIP_LIMIT_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_NOTIONAL",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "VALUE_DECIMALS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bucketOf",
    "inputs": [
      {
        "name": "usdgAmount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "configs",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "maxSlipBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "installId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "installed",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "maxPerTrade",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "dailyLimit",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "spentToday",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "day",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "eip712Domain",
    "inputs": [],
    "outputs": [
      {
        "name": "fields",
        "type": "bytes1",
        "internalType": "bytes1"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "chainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "verifyingContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "extensions",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "execute",
    "inputs": [
      {
        "name": "it",
        "type": "tuple",
        "internalType": "struct FillmarkRouter.FillIntent",
        "components": [
          {
            "name": "agentId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "installId",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "fee",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "minOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refSqrtPriceX96",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "maxDevBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "sqrtPriceLimitX96",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "amountOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "factory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IUniswapV3Factory"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeds",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract FillmarkFeeds"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashIntent",
    "inputs": [
      {
        "name": "it",
        "type": "tuple",
        "internalType": "struct FillmarkRouter.FillIntent",
        "components": [
          {
            "name": "agentId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "installId",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "tokenIn",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenOut",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "fee",
            "type": "uint24",
            "internalType": "uint24"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "minOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refSqrtPriceX96",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "maxDevBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "sqrtPriceLimitX96",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "identity",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IIdentityRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isAllowed",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "stock",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isInitialized",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isModuleType",
    "inputs": [
      {
        "name": "moduleTypeId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "navValueOf",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "stockDecimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "nonceUsed",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "onInstall",
    "inputs": [
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "onUninstall",
    "inputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "pricesOf",
    "inputs": [
      {
        "name": "f",
        "type": "tuple",
        "internalType": "struct FillmarkRouter.Fill",
        "components": [
          {
            "name": "agentId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "stock",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buy",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "usdgAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "stockAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "stockDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "sqrtPriceX96",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "roundId",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "answer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "updatedAt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "session",
            "type": "uint8",
            "internalType": "enum FillmarkFeeds.Session"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct FillmarkRouter.Prices",
        "components": [
          {
            "name": "nav",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "spot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "fill",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shortfall",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "premium",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "impact",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "cost",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "reputation",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IReputationRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "spotPrice",
    "inputs": [
      {
        "name": "sqrtPriceX96",
        "type": "uint160",
        "internalType": "uint160"
      },
      {
        "name": "stockIsToken0",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "stockDecimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "stats",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "fills",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "notional",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "worst",
        "type": "int64",
        "internalType": "int64"
      },
      {
        "name": "sumCost",
        "type": "int128",
        "internalType": "int128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "statsKey",
    "inputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "stock",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "bucket",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "extended",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "statsOf",
    "inputs": [
      {
        "name": "agentId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "stock",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct FillmarkRouter.Stats",
        "components": [
          {
            "name": "fills",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "notional",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "worst",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "sumCost",
            "type": "int128",
            "internalType": "int128"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "uniswapV3SwapCallback",
    "inputs": [
      {
        "name": "amount0Delta",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "amount1Delta",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "usdg",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "EIP712DomainChanged",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Filled",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "agentId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "stock",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "pool",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "fillId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "fill",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct FillmarkRouter.Fill",
        "components": [
          {
            "name": "agentId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "stock",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "buy",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "usdgAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "stockAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "stockDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "sqrtPriceX96",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "roundId",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "answer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "updatedAt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "session",
            "type": "uint8",
            "internalType": "enum FillmarkFeeds.Session"
          }
        ]
      },
      {
        "name": "prices",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct FillmarkRouter.Prices",
        "components": [
          {
            "name": "nav",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "spot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "fill",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shortfall",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "premium",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "impact",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "cost",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Installed",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "agentId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "wallet",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "installId",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "maxSlipBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "maxPerTrade",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "dailyLimit",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Uninstalled",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyInstalled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadCallback",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadFeed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadPair",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DecimalsChanged",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MultiplierNotPriced",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPool",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonceUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotInstalled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OraclePaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverDailyLimit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverTradeLimit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PartialFill",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PaymentFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PriceMoved",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentered",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedIntDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedIntToUint",
    "inputs": [
      {
        "name": "value",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintToInt",
    "inputs": [
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "StaleFeed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StockNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "TooLittleOut",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownStock",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WalletChanged",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WorseThanNav",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongAgent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongInstall",
    "inputs": []
  }
] as const;
