import {
  Address,
  BigInt,
  Bytes,
  ethereum,
} from "@graphprotocol/graph-ts"

import {
  SwappingPackSale__previewResultResStruct as PackPreview,
} from "../generated/templates/PackSaleForShop/SwappingPackSale"

/* Bound the gas and response size of each call, especially for previews.  */
export const PACK_BATCH_SIZE = 25

/**
 * Multicall3 on Polygon, deployed at block 25770160, before PACK_START_HEIGHT.
 * All reads use Graph Node's current block, just like the individual calls.
 * aggregate reverts if any read fails; a failed read must never hide a pack.
 *
 * The binding is explicit because graph codegen omits payable methods, even
 * though they can be used through eth_call without sending a transaction.
 */
class Multicall extends ethereum.SmartContract
{
  constructor ()
  {
    super ("Multicall3",
           Address.fromString ("0xcA11bde05977b3631167028862bE2a173976CA11"))
  }

  read (target: Address, data: Bytes[]): Bytes[]
  {
    if (data.length == 0)
      return []
    assert (data.length <= PACK_BATCH_SIZE, "Pack read batch is too large")

    const calls: ethereum.Tuple[] = []
    for (let i = 0; i < data.length; ++i)
      {
        const call = new ethereum.Tuple ()
        call.push (ethereum.Value.fromAddress (target))
        call.push (ethereum.Value.fromBytes (data[i]))
        calls.push (call)
      }

    const result = super.call ("aggregate",
        "aggregate((address,bytes)[]):(uint256,bytes[])",
        [ethereum.Value.fromTupleArray (calls)])[1].toBytesArray ()
    assert (result.length == data.length, "Incomplete pack read batch")
    return result
  }
}

/**
 * Read authoritative availability before requesting any previews.  Sold-out
 * clubs can make preview revert, and saved availability can be stale.
 */
export function readMaxPacks (tier: Address, clubs: i32[]): i32[]
{
  const selector = Bytes.fromHexString ("0x93c30f9f") /* getMaxPacks(uint256) */
  const calls: Bytes[] = []
  for (let i = 0; i < clubs.length; ++i)
    calls.push (selector.concat (ethereum.encode (
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (clubs[i])))!))

  const data = new Multicall ().read (tier, calls)
  const result: i32[] = []
  for (let i = 0; i < data.length; ++i)
    result.push (ethereum.decode ("uint256", data[i])!.toBigInt ().toI32 ())
  return result
}

/**
 * Read preview(clubId, 1) for clubs with positive availability.  Reuse the
 * generated tuple type so the batched and individual paths share pack writes.
 */
export function readPreviews (tier: Address, clubs: i32[]): PackPreview[]
{
  const selector = Bytes.fromHexString ("0xf7575a4b") /* preview(uint256,uint256) */
  const calls: Bytes[] = []
  for (let i = 0; i < clubs.length; ++i)
    {
      const args = new ethereum.Tuple ()
      args.push (ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (clubs[i])))
      args.push (ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (1)))
      calls.push (selector.concat (
          ethereum.encode (ethereum.Value.fromTuple (args))!))
    }

  const data = new Multicall ().read (tier, calls)
  const result: PackPreview[] = []
  for (let i = 0; i < data.length; ++i)
    result.push (changetype<PackPreview> (ethereum.decode (
        "(uint256,uint256,uint256,uint256,(uint256,uint256)[],uint256[])",
        data[i])!.toTuple ()))
  return result
}
