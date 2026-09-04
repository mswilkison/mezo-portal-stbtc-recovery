import { expect } from "chai"
import { artifacts, ethers } from "hardhat"
import * as anchors from "../helpers/recovery-anchors"
import { loadRecoveryManifest } from "../helpers/recovery-manifest"

// RECOVERY.md's first review gate: the Portal source reconstructed in this
// repository must compile to exactly the runtime bytecode installed behind
// the live proxy. This requires solc 0.8.24, optimizer runs 10000, and
// evmVersion "paris" (see UPSTREAM.md) — all pinned in hardhat.config.ts.
// The check needs no network. It is anchored to the reviewed constant in
// helpers/recovery-anchors.ts, never to the manifest: the generator writes
// the manifest's hash from whatever is live, so anchoring here would let a
// Portal drift plus a regenerated manifest keep this gate green while the
// storage-layout review silently re-based onto a different implementation.
describe("Portal - provenance", () => {
  it("compiles to the reviewed live implementation runtime hash", async () => {
    const artifact = await artifacts.readArtifact("Portal")
    expect(ethers.keccak256(artifact.deployedBytecode)).to.equal(
      anchors.IMPLEMENTATION_RUNTIME_HASH,
    )
  })

  it("pins the manifest to the same reviewed runtime hash", () => {
    expect(loadRecoveryManifest().implementationRuntimeHash).to.equal(
      anchors.IMPLEMENTATION_RUNTIME_HASH,
    )
  })
})
