import { artifacts, ethers } from "hardhat"

const RECOVERY_FULLY_QUALIFIED_NAME =
  "contracts/PortalStbtcRecovery.sol:PortalStbtcRecovery"

export type RecoveryBytecodeVerification = {
  artifactRuntimeHash: string
  deployedRuntimeHash: string
  maskedImmutableRanges: { start: number; length: number }[]
}

/// Verifies that the runtime bytecode deployed at `address` is byte-for-byte
/// the locally compiled PortalStbtcRecovery artifact, with the immutable
/// value ranges masked out on both sides (the artifact keeps them zeroed;
/// the deployment bakes the constructor arguments in). Combined with the
/// immutable getter read-backs this proves the deployed implementation is
/// exactly the reviewed source, not just a contract with matching getters.
export async function verifyRecoveryBytecode(
  provider: { getCode(address: string): Promise<string> },
  address: string,
): Promise<RecoveryBytecodeVerification> {
  const artifact = await artifacts.readArtifact("PortalStbtcRecovery")
  const buildInfo = await artifacts.getBuildInfo(RECOVERY_FULLY_QUALIFIED_NAME)
  if (!buildInfo) {
    throw new Error(
      "PortalStbtcRecovery build info not found; run `npm run build` first",
    )
  }

  const deployedBytecodeOutput = buildInfo.output.contracts[
    "contracts/PortalStbtcRecovery.sol"
  ].PortalStbtcRecovery.evm.deployedBytecode as {
    object: string
    immutableReferences?: Record<string, { start: number; length: number }[]>
  }

  const expected = ethers.getBytes(artifact.deployedBytecode)
  const deployedCode = await provider.getCode(address)
  const actual = ethers.getBytes(deployedCode)

  if (actual.length !== expected.length) {
    throw new Error(
      `deployed recovery bytecode length ${actual.length} does not match ` +
        `the local artifact length ${expected.length}`,
    )
  }

  const maskedImmutableRanges: { start: number; length: number }[] = []
  const references = deployedBytecodeOutput.immutableReferences ?? {}
  Object.values(references).forEach((ranges) => {
    ranges.forEach(({ start, length }) => {
      maskedImmutableRanges.push({ start, length })
      for (let i = start; i < start + length; i += 1) {
        expected[i] = 0
        actual[i] = 0
      }
    })
  })

  const mismatchIndex = expected.findIndex((byte, i) => byte !== actual[i])
  if (mismatchIndex !== -1) {
    throw new Error(
      "deployed recovery bytecode diverges from the local artifact at byte " +
        `${mismatchIndex} (outside the immutable value ranges)`,
    )
  }

  return {
    artifactRuntimeHash: ethers.keccak256(artifact.deployedBytecode),
    deployedRuntimeHash: ethers.keccak256(deployedCode),
    maskedImmutableRanges,
  }
}
