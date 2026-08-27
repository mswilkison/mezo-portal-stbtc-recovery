# mezo-portal Contracts

Smart contracts powering the bridge to Mezo

## Development

### Installation

This project uses [pnpm](https://pnpm.io/) as a package manager ([installation documentation](https://pnpm.io/installation)).

To install dependencies run:

```bash
pnpm install
```

### Testing

```
$ pnpm test
```

### Environment Setup

This project uses [dotenv-safer](https://github.com/vincentvella/dotenv-safer),
which provides environment variable checking. If there is a field in
`.env.example` but not `.env`, execution will halt early with an error.

Both `pnpm run deploy` and `pnpm test` will automatically create a blank `.env`
from the `.env.example` template, if `.env` does not exist.

To do this manually:

```
$ pnpm run prepare:env
```

### Deploying

We deploy our contracts with
[hardhat-deploy](https://www.npmjs.com/package/hardhat-deploy) via

```
$ pnpm run deploy [--network <network>]
```

Check the `"networks"` entry of `hardhat.config.ts` for supported networks.

Deploying to real chains will require configuring the `.env` environment,
detailed in `.env.example`.

#### Examples:

**In-Memory Hardhat** (great for development)

```
pnpm run deploy
```

**Sepolia**

To deploy contracts on Sepolia run:

```
$ pnpm run deploy --network sepolia
```

Or, alternatively, manually trigger the [`Solidity`
workflow](https://github.com/thesis/mezo-portal/actions/workflows/solidity.yml)
(this will not only deploy the contracts, but also update the values of
`TBTC_CONTRACT_ADDRESS`, `WBTC_CONTRACT_ADDRESS` and `PORTAL_CONTRACT_ADDRESS`
environment variables in the settings of Netlify builds deploying dApp and its
previews).

## Contract Addresses

The official mainnet and testnet contract addresses are listed below.

### Mainnet

| Contract                        | Address                                      |
| ------------------------------- | -------------------------------------------- |
| tBTC                            | `0x18084fbA666a33d37592fA2633fD49a74DD93a88` |
| Bridge (tBTC)                   | `0x5e4861a80B55f035D899f66772117F00FA0E8e7B` |
| TBTCVault (tBTC)                | `0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD` |
| WBTC                            | `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599` |
| Portal Proxy                    | `0xAB13B8eecf5AA2460841d75da5d5D861fD5B8A39` |
| Portal Implementation           | `0xD7097AF27b14e204564C057c636022fae346fE60` |
| Portal ProxyAdmin               | `0x260cA2abeF5d38181E2562F00FA92AD1DC681734` |
| BitcoinDepositor Proxy          | `0x1D50D75933b7b7C8AD94dbfb748B5756E3889C24` |
| BitcoinDepositor Implementation | `0x04B94f55780682478c8D8329368AAAfD320F4D32` |
| BitcoinDepositor ProxyAdmin     | `0x66cE24B68D9fEb092Bc8E6C47C0FA318e48F1267` |
| MezoBridge Proxy                | `0xF6680EA3b480cA2b72D96ea13cCAF2cFd8e6908c` |
| MezoBridge Implementation       | `0x3D282Cc0d69e27fBd4aa59DfD08D6a72B45Ce889` |
| MezoBridge ProxyAdmin           | `0xef619B73F424506b8aDa0E05C2935aB36ec096A2` |

### Sepolia

| Contract                        | Address                                      |
| ------------------------------- | -------------------------------------------- |
| tBTC                            | `0x517f2982701695D4E52f1ECFBEf3ba31Df470161` |
| Bridge (tBTC)                   | `0x9b1a7fE5a16A15F2f9475C5B231750598b113403` |
| TBTCVault (tBTC)                | `0xB5679dE944A79732A75CE556191DF11F489448d5` |
| WBTC (mock)                     | `0xdc5558c2873C6375d5a90551c9D0F853794D357D` |
| Portal Proxy                    | `0x6978E3e11b8Bc34ea836C1706fC742aC4Cb6b0Db` |
| Portal Implementation           | `0x5581c79ac00164D04De090eB72A9B0B08f89643d` |
| Portal ProxyAdmin               | `0x9Aa2e895ABb717822fb72FEeb64010dB6739D720` |
| BitcoinDepositor Proxy          | `0x7205535961649C4F94e1b4BAfBe26d23e2bbDd84` |
| BitcoinDepositor Implementation | `0x6617C61355cA32141950B8F6610C40C613CA7F38` |
| BitcoinDepositor ProxyAdmin     | `0x93c4E8eB2813FD3C13254C31B43a30a9ca9693eC` |
| MezoBridge Proxy                | `0x3a3BaE133739f92a885070DbF3300d61B232497C` |
| MezoBridge Implementation       | `0x2de0566A26B74DcD501Ff5c3b213Bf5a01aC3aC1` |
| MezoBridge ProxyAdmin           | `0xAB940Ce533883a521F467B872a8eD699311c7d86` |

## Rebasing and Fee-on-Transfer Deposit Tokens

The smart contracts are incompatible with rebasing and fee-on-transfer tokens.
Such tokens **must not** be added as supported tokens for deposits to the
`Portal` contract.

This check should be a part of the checklist for the governance when adding new
supported tokens.
