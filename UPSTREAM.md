# Upstream provenance

This repository is a reconstruction for review and cherry-picking. It is not
the canonical Mezo Portal repository and must not be deployed without rebasing
the recovery commit onto Thesis's canonical private head.

## Published project snapshot

The initial commit is the unpacked public npm package
`@mezo-org/contracts@0.4.0-dev.4`:

- Package URL: <https://www.npmjs.com/package/@mezo-org/contracts>
- Registry tarball: <https://registry.npmjs.org/@mezo-org/contracts/-/contracts-0.4.0-dev.4.tgz>
- Registry integrity: `sha512-YH7WTwTMMEiPNUVoqpXYppmOsYt2CJHnXKTfMQbFN3qDIpISRi+aVwPAangz/21naU1bfM/BG0f+u6GWTj5SCg==`
- Registry git head: `36461ed96169742482cb6d3b71883f0ce1ce0f76`
- License declared by the package: `GPL-3.0`

## Live implementation snapshot

The second commit synchronizes the Portal implementation source with the
verified contract currently used by the Ethereum mainnet proxy:

- Portal proxy: `0xAB13B8eecf5AA2460841d75da5d5D861fD5B8A39`
- EIP-1967 implementation at Ethereum block `25849453`:
  `0xb3696cdDDEaa764FEF98Dc109ECe3dEfABaB64d8`
- Verified source: <https://etherscan.io/address/0xb3696cdddeaa764fef98dc109ece3defabab64d8#code>
- Compiler: `v0.8.24+commit.e11b9ed9`
- Optimizer: enabled, 10,000 runs
- EVM version: `paris`
- `contracts/Portal.sol` SHA-256:
  `dbbdfabbd6520265e0590c8369b28aed578d6e4aa82f50c973b26ec9cf2c2382`
- `contracts/interfaces/IUSDT.sol` SHA-256:
  `966d5db577782f925a0fc9d418cb3099965fd954a4a3a29595a56e8bf471bb16`

The other project-local compilation units used by the verified implementation
match the npm package byte-for-byte. The verified live implementation is newer
than the published package's `Portal.sol`, so the recovery work branches from
this synchronized snapshot.

