import {
  ReferrerUpdated as ReferrerUpdatedEvent,
} from "../generated/ReferralTracker/ReferralTracker"

import {
  ReferralBonusGiven as ReferralBonusGivenEvent,
} from "../generated/templates/PackSaleForReferrals/SwappingPackSale"

import {
  Referral,
  Referrer,
  ReferrerBonus,
  ReferrerTotal,
} from "../generated/schema"

import {
  PackSaleForReferrals,
} from "../generated/templates"

import {
  Address,
  BigInt,
  ByteArray,
  Bytes,
  ethereum,
  store,
} from "@graphprotocol/graph-ts"

/* ************************************************************************** */

/**
 * Converts a Xaya account name to an associated Bytes ID.
 */
export function accountToBytes (account: String): Bytes
{
  return Bytes.fromUTF8 (account)
}

/**
 * Creates and sets a new ReferrerTotal for the given referrer, updating
 * the values accordingly.
 */
function updateReferrerTotals (
    refId: Bytes, timestamp: BigInt,
    deltaReferrals: i64, deltaBonusShares: i64, deltaUsdSpent: i64): void
{
  const ref = Referrer.load (refId)!
  const prev = ReferrerTotal.load (ref.currentTotal)!
  const newId = ref.id.concatI32 (prev.index.toI32 () + 1)

  const next = new ReferrerTotal (newId)
  next.referrer = prev.referrer
  next.timestamp = timestamp
  next.index = prev.index + BigInt.fromI32 (1)
  next.referrals = prev.referrals + BigInt.fromI64 (deltaReferrals)
  next.bonusShares = prev.bonusShares + BigInt.fromI64 (deltaBonusShares)
  next.usdSpent = prev.usdSpent + BigInt.fromI64 (deltaUsdSpent)
  next.save ()

  ref.currentTotal = newId
  ref.save ()
}

export function handleReferrerUpdated (event: ReferrerUpdatedEvent): void
{
  /* This event is triggered both for new referrals and also when we use
     admin powers to overwrite or clear (referrer set to "") a referrer.

     As a first step, look up the referral instance, and if it exists,
     unlink it from the previous referrer.  */

  const id = accountToBytes (event.params.name)
  let referral = Referral.load (id)
  if (referral != null)
    {
      updateReferrerTotals (referral.referrer, event.block.timestamp, -1, 0, 0)
      store.remove ("Referral", id.toHexString ())
    }

  /* If this is just a removal (referrer is set to "" on the event), nothing
     more to be done.  */
  if (event.params.referrer.length == 0)
    return

  /* We want to add the referral for the referrer.  If the referrer does not
     exist yet, create it first.  Otherwise increment its totals.  */
  const refId = accountToBytes (event.params.referrer)
  if (Referrer.load (refId) == null)
    {
      const totals = new ReferrerTotal (refId.concatI32 (0))
      totals.referrer = refId
      totals.index = BigInt.fromI32 (0)
      totals.referrals = BigInt.fromI32 (1)
      totals.bonusShares = BigInt.fromI32 (0)
      totals.usdSpent = BigInt.fromI32 (0)
      totals.timestamp = event.block.timestamp
      totals.save ()

      const referrer = new Referrer (refId)
      referrer.account = event.params.referrer
      referrer.currentTotal = totals.id
      referrer.save ()
    }
  else
    updateReferrerTotals (refId, event.block.timestamp, 1, 0, 0)

  /* Finally, add the referral entity.  */
  referral = new Referral (id)
  referral.account = event.params.name
  referral.referrer = refId
  referral.timestamp = event.block.timestamp
  referral.save ()
}

export function handleReferralBonus (event: ReferralBonusGivenEvent): void
{
  const id = event.transaction.hash.concatI32 (event.logIndex.toI32 ())

  const referrer = accountToBytes (event.params.referrer)
  const timestamp = event.block.timestamp
  const usdSpent = event.params.cost.toI64 ()
  const bonusShares = event.params.numShares.toI64 ()

  const bonus = new ReferrerBonus (id)
  bonus.referrer = referrer
  bonus.referral = accountToBytes (event.params.buyer)
  bonus.timestamp = timestamp
  bonus.clubId = event.params.clubId
  bonus.packsBought = event.params.numPacksBought
  bonus.usdSpent = BigInt.fromI64 (usdSpent)
  bonus.bonusShares = BigInt.fromI64 (bonusShares)
  bonus.save ()

  updateReferrerTotals (referrer, timestamp, 0, bonusShares, usdSpent)
}

/* ************************************************************************** */

export function createPackSaleTiers (block: ethereum.Block): void
{
  const addresses = [
    "0x8501A9018A5625b720355A5A05c5dA3D5E8bB003",
    "0x0bF818f3A69485c8B05Cf6292D9A04C6f58ADF08",
    "0x4259D89087b6EBBC8bE38A30393a2F99F798FE2f",
    "0x167360A54746b82e38f700dF0ef812c269c4e565",
    "0x3d25Cb3139811c6AeE9D5ae8a01B2e5824b5dB91",
  ];

  addresses.forEach ((addr) => {
    PackSaleForReferrals.create (Address.fromString (addr));
  });
}
