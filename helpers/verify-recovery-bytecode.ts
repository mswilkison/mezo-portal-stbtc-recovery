import { artifacts, ethers } from "hardhat"

const RECOVERY_FULLY_QUALIFIED_NAME =
  "contracts/PortalStbtcRecovery.sol:PortalStbtcRecovery"

export type RecoveryBytecodeVerification = {
  artifactRuntimeHash: string
  deployedRuntimeHash: string
  maskedImmutableRanges: { name: string; start: number; length: number }[]
}

export type RecoveryImmutableValues = {
  EXPECTED_PORTAL: string
  RECOVERY_AUTHORITY: string
  RECEIPT_PAYER: string
  COLLATERAL_RECIPIENT: string
  EXPECTED_TBTC: string
  EXPECTED_RECEIPT_TOKEN: string
  EXPECTED_MAX_RECOVERY_AMOUNT: bigint
}

const IMMUTABLE_ABI_TYPES: Record<keyof RecoveryImmutableValues, string> = {
  EXPECTED_PORTAL: "address",
  RECOVERY_AUTHORITY: "address",
  RECEIPT_PAYER: "address",
  COLLATERAL_RECIPIENT: "address",
  EXPECTED_TBTC: "address",
  EXPECTED_RECEIPT_TOKEN: "address",
  EXPECTED_MAX_RECOVERY_AMOUNT: "uint96",
}

/// Verifies that the runtime bytecode deployed at `address` is byte-for-byte
/// the locally compiled PortalStbtcRecovery artifact, with the immutable
/// value ranges checked occurrence-by-occurrence against the expected
/// constructor values before they are masked for the remaining bytecode
/// comparison. Checking every occurrence matters because custom initcode can
/// patch different uses of one Solidity immutable to different values while
/// leaving its public getter correct.
export async function verifyRecoveryBytecode(
  provider: {
    getCode(address: string, blockTag?: number | string): Promise<string>
  },
  address: string,
  expectedImmutables: RecoveryImmutableValues,
  blockTag?: number | string,
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

  // The immutable byte ranges come from the build info while the reference
  // bytes come from the artifact; a desynced artifacts/ directory would
  // shift the masked windows, so the two must be the same compilation.
  if (
    artifact.deployedBytecode.toLowerCase() !==
    `0x${deployedBytecodeOutput.object}`.toLowerCase()
  ) {
    throw new Error(
      "artifact deployedBytecode does not match its build info; artifacts/ " +
        "is out of sync — run `npm run clean && npm run build`",
    )
  }

  const expected = ethers.getBytes(artifact.deployedBytecode)
  const deployedCode = await provider.getCode(address, blockTag)
  const actual = ethers.getBytes(deployedCode)

  if (actual.length !== expected.length) {
    throw new Error(
      `deployed recovery bytecode length ${actual.length} does not match ` +
        `the local artifact length ${expected.length}`,
    )
  }

  const sourceAst = buildInfo.output.sources[
    "contracts/PortalStbtcRecovery.sol"
  ].ast as {
    nodes: Array<{
      nodeType: string
      name?: string
      nodes?: Array<{
        id: number
        nodeType: string
        name: string
        mutability?: string
      }>
    }>
  }
  const recoveryDefinition = sourceAst.nodes.find(
    (node) =>
      node.nodeType === "ContractDefinition" &&
      node.name === "PortalStbtcRecovery",
  )
  if (!recoveryDefinition?.nodes) {
    throw new Error("PortalStbtcRecovery AST definition not found")
  }

  const immutableDeclarations = new Map(
    recoveryDefinition.nodes
      .filter(
        (node) =>
          node.nodeType === "VariableDeclaration" &&
          node.mutability === "immutable",
      )
      .map((node) => [node.id.toString(), node.name]),
  )
  const maskedImmutableRanges: {
    name: string
    start: number
    length: number
  }[] = []
  const verifiedNames = new Set<string>()
  const references = deployedBytecodeOutput.immutableReferences ?? {}
  Object.entries(references).forEach(([declarationId, ranges]) => {
    const name = immutableDeclarations.get(declarationId)
    if (!name || !(name in IMMUTABLE_ABI_TYPES)) {
      throw new Error(
        `unrecognized recovery immutable declaration ${declarationId}`,
      )
    }

    const immutableName = name as keyof RecoveryImmutableValues
    if (ranges.length === 0) {
      throw new Error(`recovery immutable ${name} has no bytecode references`)
    }
    const encodedValue = ethers.getBytes(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [IMMUTABLE_ABI_TYPES[immutableName]],
        [expectedImmutables[immutableName]],
      ),
    )
    ranges.forEach(({ start, length }) => {
      if (length !== encodedValue.length || start + length > actual.length) {
        throw new Error(
          `invalid ${name} immutable range at byte ${start} ` +
            `(length ${length})`,
        )
      }
      for (let i = 0; i < length; i += 1) {
        if (actual[start + i] !== encodedValue[i]) {
          throw new Error(
            `deployed recovery immutable ${name} occurrence at byte ${start} ` +
              "does not match the expected constructor value",
          )
        }
      }

      maskedImmutableRanges.push({ name, start, length })
      for (let i = start; i < start + length; i += 1) {
        expected[i] = 0
        actual[i] = 0
      }
    })
    verifiedNames.add(name)
  })

  Object.keys(IMMUTABLE_ABI_TYPES).forEach((name) => {
    if (!verifiedNames.has(name)) {
      throw new Error(`recovery immutable ${name} has no bytecode references`)
    }
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
