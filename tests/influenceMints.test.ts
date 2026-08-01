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
  SaleTier,
} from "../generated/schema"

import {
  SharesMinted as SharesMintedEvent,
} from "../generated/ClubMinter/ClubMinter"

import {
  ClubAdded as ClubAddedEvent,
  ClubRemoved as ClubRemovedEvent,
  ClubSalePaused as ClubSalePausedEvent,
} from "../generated/templates/PackSaleForShop/SwappingPackSale"

import {
  handleClubAdded,
  handleClubRemoved,
  handleClubSalePaused,
  handleSharesMinted,
} from "../src/saleTiers"

/* ************************************************************************** */

const TIER = Address.fromString ("0x8501A9018A5625b720355A5A05c5dA3D5E8bB003")

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
