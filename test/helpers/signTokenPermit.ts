import { ethers } from "hardhat"

import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import type { MockERC20WithPermit } from "../../typechain"

/**
 * Signs a permit for a token.
 * @param token The token to sign the permit for.
 * @param owner The owner of the token.
 * @param spender The spender of the token.
 * @param amount The amount of the token to sign the permit for.
 * @param deadline The deadline of the permit.
 */
export default async function signTokenPermit(
  token: MockERC20WithPermit,
  owner: SignerWithAddress,
  spender: string,
  amount: bigint,
  deadline: bigint,
) {
  const name = await token.name()
  const version = "1"
  const { chainId } = await ethers.provider.getNetwork()

  const nonce = await token.nonces(owner.address)

  const domain = {
    name,
    version,
    chainId,
    verifyingContract: await token.getAddress(),
  }

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  }

  const message = {
    owner: owner.address,
    spender,
    value: amount,
    nonce: nonce.toString(),
    deadline,
  }

  const signatureString = await owner.signTypedData(domain, types, message)

  return ethers.Signature.from(signatureString)
}
