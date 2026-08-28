import { expect } from "chai"
import { artifacts, ethers } from "hardhat"
import { recoveryManifest } from "../helpers/recovery-manifest"

// RECOVERY.md's first review gate: the Portal source reconstructed in this
// repository must compile to exactly the runtime bytecode installed behind
// the live proxy. This requires solc 0.8.24, optimizer runs 10000, and
// evmVersion "paris" (see UPSTREAM.md) — all pinned in hardhat.config.ts.
// The check needs no network: it compares the local artifact against the
// hash recorded in the reviewed manifest.
describe("Portal - provenance", () => {
  it("compiles to the live implementation's runtime bytecode hash", async () => {
    const artifact = await artifacts.readArtifact("Portal")
    expect(ethers.keccak256(artifact.deployedBytecode)).to.equal(
      recoveryManifest.implementationRuntimeHash,
    )
  })
})
