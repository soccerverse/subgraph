import {
  assert,
  beforeEach,
  clearStore,
  describe,
  newMockEvent,
  test,
} from "matchstick-as/assembly/index"

import {
  Address,
  BigInt,
  Bytes,
  ethereum,
} from "@graphprotocol/graph-ts"

import {
  InfluenceMint,
  PricingStep,
  Referrer,
  ReferrerTotal,
  SaleTier,
} from "../generated/schema"

import {
  SharesMinted as SharesMintedEvent,
} from "../generated/ClubMinter/ClubMinter"

import {
  ClubAdded as ClubAddedEvent,
  ClubRemoved as ClubRemovedEvent,
  ClubSalePaused as ClubSalePausedEvent,
  PacksBought as PacksBoughtEvent,
} from "../generated/templates/PackSaleForShop/SwappingPackSale"

import {
  ReferralBonusGiven as ReferralBonusGivenEvent,
} from "../generated/templates/PackSaleForReferrals/SwappingPackSale"

import {
  PacksBought as VoucherPacksBoughtEvent,
  Transfer as VoucherTransferEvent,
} from "../generated/PackVoucher/PackVoucher"

import {
  handleClubAdded,
  handleClubRemoved,
  handleClubSalePaused,
  handlePacksBought,
  handleSharesMinted,
  handleVoucherPacksBought,
  handleVoucherTransfer,
} from "../src/saleTiers"

import {
  accountToBytes,
  handleReferralBonus,
} from "../src/referralTracker"

/* ************************************************************************** */

const TIER = Address.fromString ("0x8501A9018A5625b720355A5A05c5dA3D5E8bB003")
const VOUCHER
    = Address.fromString ("0x9De075D87B812eC647d5541CB50d65Bc06Ec6509")
const BUYER = Address.fromString ("0x0000000000000000000000000000000000000123")

/* One transaction for all events of a test unless it says otherwise.  */
const TX = Bytes.fromI32 (1234)

/**
 * Seeds the tier and a two-step ladder: 500 shares at 10, 500 at 20, so a
 * boundary sits at cumulative position 500 and the ladder ends at 1000.
 */
function seedTier (): void
{
  const tier = new SaleTier (TIER)
  tier.name = "test"
  tier.active = true
  tier.save ()

  const nums: i32[] = [500, 500]
  const prices: i32[] = [10, 20]
  let total = 0
  for (let i = 0; i < nums.length; ++i)
    {
      const step = new PricingStep (TIER.concatI32 (i))
      step.tier = TIER
      step.index = i
      step.numShares = nums[i]
      step.price = BigInt.fromI32 (prices[i])
      step.fromTotal = total
      total += nums[i]
      step.toTotal = total - 1
      step.save ()
    }
}

function clubEvent (clubId: i32): ethereum.Event
{
  const ev = newMockEvent ()
  ev.address = TIER
  ev.parameters = [
    new ethereum.EventParam ("clubId",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (clubId))),
  ]
  return ev
}

function addClub (clubId: i32): void
{
  handleClubAdded (changetype<ClubAddedEvent> (clubEvent (clubId)))
}

function pauseClub (clubId: i32): void
{
  /* The contract emits ClubRemoved first and ClubSalePaused right after
     it, from the same pauseClubSaleInternal call.  */
  handleClubRemoved (changetype<ClubRemovedEvent> (clubEvent (clubId)))
  handleClubSalePaused (changetype<ClubSalePausedEvent> (clubEvent (clubId)))
}

function mintShares (clubId: i32, num: i32, receiver: string,
                     totalAfter: i32, logIndex: i32): Bytes
{
  const ev = newMockEvent ()
  ev.transaction.hash = TX
  ev.logIndex = BigInt.fromI32 (logIndex)
  ev.parameters = [
    new ethereum.EventParam ("clubId",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (clubId))),
    new ethereum.EventParam ("num",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (num))),
    new ethereum.EventParam ("receiver", ethereum.Value.fromString (receiver)),
    new ethereum.EventParam ("totalMinted",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (totalAfter))),
    new ethereum.EventParam ("remaining",
        ethereum.Value.fromUnsignedBigInt (
            BigInt.fromI32 (1000000 - totalAfter))),
  ]
  handleSharesMinted (changetype<SharesMintedEvent> (ev))
  return TX.concatI32 (logIndex)
}

function packsBoughtEvent (receiver: string, primaryClub: i32, cost: i32,
                           logIndex: i32): ethereum.Event
{
  const ev = newMockEvent ()
  ev.transaction.hash = TX
  ev.logIndex = BigInt.fromI32 (logIndex)
  ev.parameters = [
    new ethereum.EventParam ("buyer", ethereum.Value.fromAddress (BUYER)),
    new ethereum.EventParam ("receiver", ethereum.Value.fromString (receiver)),
    new ethereum.EventParam ("primaryClubId",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (primaryClub))),
    new ethereum.EventParam ("numPacks",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (1))),
    new ethereum.EventParam ("cost",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (cost))),
  ]
  return ev
}

function buyPack (receiver: string, primaryClub: i32, cost: i32,
                  logIndex: i32): Bytes
{
  const ev = packsBoughtEvent (receiver, primaryClub, cost, logIndex)
  ev.address = TIER
  handlePacksBought (changetype<PacksBoughtEvent> (ev))
  return TX.concatI32 (logIndex)
}

function redeemVoucher (receiver: string, primaryClub: i32, cost: i32,
                        logIndex: i32): Bytes
{
  const ev = packsBoughtEvent (receiver, primaryClub, cost, logIndex)
  ev.address = VOUCHER
  handleVoucherPacksBought (changetype<VoucherPacksBoughtEvent> (ev))
  return TX.concatI32 (logIndex)
}

/**
 * The voucher burn that batchRedeem does, before any of the invocation's
 * mints, for the invocation's whole cost.
 */
function voucherBurn (cost: i32, logIndex: i32): void
{
  const ev = newMockEvent ()
  ev.address = VOUCHER
  ev.transaction.hash = TX
  ev.logIndex = BigInt.fromI32 (logIndex)
  ev.parameters = [
    new ethereum.EventParam ("from", ethereum.Value.fromAddress (BUYER)),
    new ethereum.EventParam ("to",
        ethereum.Value.fromAddress (Address.zero ())),
    new ethereum.EventParam ("value",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (cost))),
  ]
  handleVoucherTransfer (changetype<VoucherTransferEvent> (ev))
}

/**
 * The ReferralBonusGiven the sale emits right after minting the bonus to
 * the referrer.  The referral tracker's handler needs the Referrer row and
 * its running total to exist, as they would in production.
 */
function giveReferralBonus (buyer: string, referrer: string, clubId: i32,
                            numShares: i32, logIndex: i32): void
{
  const refId = accountToBytes (referrer)
  if (Referrer.load (refId) == null)
    {
      const total = new ReferrerTotal (refId.concatI32 (0))
      total.referrer = refId
      total.timestamp = BigInt.fromI32 (0)
      total.index = BigInt.fromI32 (0)
      total.referrals = BigInt.fromI32 (1)
      total.bonusShares = BigInt.fromI32 (0)
      total.usdSpent = BigInt.fromI32 (0)
      total.save ()

      const ref = new Referrer (refId)
      ref.account = referrer
      ref.currentTotal = total.id
      ref.save ()
    }

  const ev = newMockEvent ()
  ev.address = TIER
  ev.transaction.hash = TX
  ev.logIndex = BigInt.fromI32 (logIndex)
  ev.parameters = [
    new ethereum.EventParam ("buyer", ethereum.Value.fromString (buyer)),
    new ethereum.EventParam ("referrer",
        ethereum.Value.fromString (referrer)),
    new ethereum.EventParam ("clubId",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (clubId))),
    new ethereum.EventParam ("numShares",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (numShares))),
    new ethereum.EventParam ("numPacksBought",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (1))),
    new ethereum.EventParam ("cost",
        ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (0))),
  ]
  handleReferralBonus (changetype<ReferralBonusGivenEvent> (ev))
}

function assertUnclaimed (mint: Bytes): void
{
  const m = InfluenceMint.load (mint)!
  assert.assertNull (m.get ("purchase"))
}

/* ************************************************************************** */

describe ("handleSharesMinted", () => {

  beforeEach (() => {
    clearStore ()
  })

  test ("prices a mint from the club's ladder position", () => {
    seedTier ()
    addClub (7)

    /* 100 already minted, 300 more: all inside the opening step.  */
    const first = mintShares (7, 300, "alice", 400, 1)
    assert.fieldEquals ("InfluenceMint", first.toHexString (),
                        "mintedBefore", "100")
    assert.fieldEquals ("InfluenceMint", first.toHexString (),
                        "usdCost", "3000")
    assert.fieldEquals ("InfluenceMint", first.toHexString (),
                        "tier", TIER.toHexString ())
    assert.fieldEquals ("InfluenceMint", first.toHexString (),
                        "receiver", "alice")
    assertUnclaimed (first)

    /* The next 300 span the boundary at 500: 100 at 10 and 200 at 20.  */
    const second = mintShares (7, 300, "alice", 700, 2)
    assert.fieldEquals ("InfluenceMint", second.toHexString (),
                        "usdCost", "5000")
  })

  test ("prices a mint of a never-tiered club at zero", () => {
    /* No tier, no ladder: there is nothing defensible to price with.  */
    const mint = mintShares (42, 100, "alice", 100, 1)
    assert.fieldEquals ("InfluenceMint", mint.toHexString (), "usdCost", "0")
  })

  test ("keeps the pausing tier's prices after a club sale pause", () => {
    seedTier ()
    addClub (7)
    pauseClub (7)

    /* The premine case: shares minted into a sold-out (paused) club, past
       the end of the ladder, keep the final price instead of becoming
       free.  */
    const mint = mintShares (7, 100, "Reserved", 1100, 1)
    assert.fieldEquals ("InfluenceMint", mint.toHexString (),
                        "usdCost", "2000")
    assert.fieldEquals ("InfluenceMint", mint.toHexString (),
                        "tier", TIER.toHexString ())

    /* The shop's view must still say "not for sale".  */
    assert.fieldEquals ("SaleClub", Bytes.fromI32 (7).toHexString (),
                        "trancheIndex", "-1")
  })
})

/* ************************************************************************** */

describe ("purchase claims", () => {

  beforeEach (() => {
    clearStore ()
  })

  test ("a purchase claims its receiver's mints and leaves others free", () => {
    seedTier ()
    addClub (7)

    const m1 = mintShares (7, 100, "alice", 100, 1)
    const m2 = mintShares (8, 100, "alice", 100, 2)
    const m3 = mintShares (9, 100, "bob", 100, 3)
    const p = buyPack ("alice", 7, 1000, 4)

    assert.fieldEquals ("InfluenceMint", m1.toHexString (),
                        "purchase", p.toHexString ())
    assert.fieldEquals ("InfluenceMint", m2.toHexString (),
                        "purchase", p.toHexString ())
    assertUnclaimed (m3)

    /* The direct sale re-validates its price at execution time, so the
       running-counter price stays untouched by the claim.  */
    assert.fieldEquals ("InfluenceMint", m1.toHexString (),
                        "usdCost", "1000")
  })

  test ("two purchases for one receiver split the transaction's mints", () => {
    seedTier ()
    addClub (7)
    addClub (8)

    /* The shape of the real five-operation voucher batch that holds two
       purchases for one receiver: each operation's mints come right before
       its own PacksBought.  A plain (transaction, receiver) join would
       hand both purchases the union of all four mints.  */
    const m1 = mintShares (7, 100, "alice", 100, 1)
    const p1 = redeemVoucher ("alice", 7, 1000, 2)
    const m2 = mintShares (8, 100, "alice", 100, 3)
    const p2 = redeemVoucher ("alice", 8, 1000, 4)

    assert.fieldEquals ("InfluenceMint", m1.toHexString (),
                        "purchase", p1.toHexString ())
    assert.fieldEquals ("InfluenceMint", m2.toHexString (),
                        "purchase", p2.toHexString ())
  })

  test ("a referral bonus after the purchase stays free", () => {
    seedTier ()
    addClub (7)

    /* The sale mints the referral bonus to the REFERRER after the buyer's
       own PacksBought, inside the same transaction.  */
    const paid = mintShares (7, 100, "alice", 100, 1)
    const p = buyPack ("alice", 7, 1000, 2)
    const bonus = mintShares (7, 10, "referrer", 110, 3)

    assert.fieldEquals ("InfluenceMint", paid.toHexString (),
                        "purchase", p.toHexString ())
    assertUnclaimed (bonus)
  })

  test ("voucher operations overlapping on a club re-price from the "
            + "invocation start", () => {
    seedTier ()
    addClub (7)

    /* One batchRedeem invocation: it burns the whole cost up front and
       validates every operation before minting anything, so both
       operations here were charged from the starting supply of 200:
       300 shares at 10 and 100 at 20 makes 5000 each.  The second
       operation's mints then really happen at 600..999, which the running
       counter would price at 8000; the stored cost must be the 5000 that
       was paid.  */
    voucherBurn (10000, 1)
    const m1 = mintShares (7, 400, "alice", 600, 2)
    const p1 = redeemVoucher ("alice", 7, 5000, 3)
    const m2 = mintShares (7, 400, "bob", 1000, 4)
    const p2 = redeemVoucher ("bob", 7, 5000, 5)

    assert.fieldEquals ("InfluenceMint", m1.toHexString (),
                        "usdCost", "5000")
    assert.fieldEquals ("InfluenceMint", m2.toHexString (),
                        "usdCost", "5000")
    /* The factual ladder position is not rewritten by the re-pricing.  */
    assert.fieldEquals ("InfluenceMint", m2.toHexString (),
                        "mintedBefore", "600")
    assert.fieldEquals ("InfluenceMint", m1.toHexString (),
                        "purchase", p1.toHexString ())
    assert.fieldEquals ("InfluenceMint", m2.toHexString (),
                        "purchase", p2.toHexString ())
  })

  test ("separate batchRedeem invocations in one transaction re-price "
            + "independently", () => {
    seedTier ()
    addClub (7)

    /* Two batchRedeem calls from a wrapper in ONE transaction.  The second
       invocation validates against the supply the first one moved, so its
       400 shares from 600 really cost 8000 -- pulling it back to the first
       invocation's start would store 5000 for an 8000 purchase.  Each
       burn precedes its invocation's mints and is the delimiter.  */
    voucherBurn (5000, 1)
    const m1 = mintShares (7, 400, "alice", 600, 2)
    const p1 = redeemVoucher ("alice", 7, 5000, 3)
    voucherBurn (8000, 4)
    const m2 = mintShares (7, 400, "bob", 1000, 5)
    const p2 = redeemVoucher ("bob", 7, 8000, 6)

    assert.fieldEquals ("InfluenceMint", m1.toHexString (),
                        "usdCost", "5000")
    assert.fieldEquals ("InfluenceMint", m2.toHexString (),
                        "usdCost", "8000")
    assert.fieldEquals ("InfluenceMint", m1.toHexString (),
                        "purchase", p1.toHexString ())
    assert.fieldEquals ("InfluenceMint", m2.toHexString (),
                        "purchase", p2.toHexString ())
  })

  test ("a later purchase for the referrer does not absorb the bonus", () => {
    seedTier ()
    addClub (7)
    addClub (8)

    /* A wrapper calls the public mint twice in one transaction.  Purchase
       1 buys for alice, whose referrer is bob; the sale mints bob's free
       bonus right after alice's PacksBought and reports it with
       ReferralBonusGiven.  Purchase 2 then buys FOR bob: it must claim
       only its own paid mints, not the earlier free bonus, even though
       both are unclaimed rows for the same receiver at that point.  */
    const paid1 = mintShares (7, 100, "alice", 100, 1)
    const p1 = buyPack ("alice", 7, 1000, 2)
    const bonus = mintShares (7, 10, "bob", 110, 3)
    giveReferralBonus ("alice", "bob", 7, 10, 4)
    const paid2 = mintShares (8, 100, "bob", 100, 5)
    const p2 = buyPack ("bob", 8, 1000, 6)

    assert.fieldEquals ("InfluenceMint", paid1.toHexString (),
                        "purchase", p1.toHexString ())
    assert.fieldEquals ("InfluenceMint", bonus.toHexString (),
                        "referralBonus", "true")
    assertUnclaimed (bonus)
    assert.fieldEquals ("InfluenceMint", paid2.toHexString (),
                        "purchase", p2.toHexString ())
  })
})
