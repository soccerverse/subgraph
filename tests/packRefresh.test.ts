import {
  assert,
  beforeEach,
  clearStore,
  createMockedFunction,
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
  ClubRemoved,
  PricingUpdated,
  SeedUpdated,
  SwappingPackSale__previewResultResStruct as PackPreview,
} from "../generated/templates/PackSaleForShop/SwappingPackSale"

import {
  SharesMinted,
} from "../generated/ClubMinter/ClubMinter"

import {
  Pack,
  PricingStep,
  SaleClub,
  SaleTier,
} from "../generated/schema"

import { PACK_START_HEIGHT } from "../src/config"
import { readMaxPacks, readPreviews } from "../src/packCalls"
import {
  handleClubRemoved,
  handlePricingUpdated,
  handleSeedUpdated,
  handleSharesMinted,
} from "../src/saleTiers"

const TIER = Address.fromString ("0x8501A9018A5625b720355A5A05c5dA3D5E8bB003")
const MULTICALL = Address.fromString ("0xcA11bde05977b3631167028862bE2a173976CA11")
const AGGREGATE = "aggregate((address,bytes)[]):(uint256,bytes[])"

function uint (n: i32): ethereum.Value
{
  return ethereum.Value.fromUnsignedBigInt (BigInt.fromI32 (n))
}

/* Construct expected calldata independently of the mapping's ABI encoder.  */
function word (n: i32): string
{
  let hex = n.toString (16)
  while (hex.length < 64)
    hex = "0" + hex
  return hex
}

function maxCall (id: i32): Bytes
{
  return Bytes.fromHexString ("0x93c30f9f" + word (id))
}

function previewCall (id: i32): Bytes
{
  return Bytes.fromHexString ("0xf7575a4b" + word (id) + word (1))
}

function preview (id: i32, secondary: i32 = 100, num: i32 = 10): PackPreview
{
  const primary = new ethereum.Tuple ()
  primary.push (uint (id))
  primary.push (uint (num))
  const other = new ethereum.Tuple ()
  other.push (uint (secondary))
  other.push (uint (3))
  const result = new ethereum.Tuple ()
  result.push (uint (id))
  result.push (uint (1))
  result.push (uint (1234 + id))
  result.push (uint (99))
  result.push (ethereum.Value.fromTupleArray ([primary, other]))
  result.push (ethereum.Value.fromUnsignedBigIntArray ([BigInt.fromI32 (200)]))
  return changetype<PackPreview> (result)
}

function mockBatch (data: Bytes[], results: Bytes[], reverts: bool = false): void
{
  const calls: ethereum.Tuple[] = []
  for (let i = 0; i < data.length; ++i)
    {
      const call = new ethereum.Tuple ()
      call.push (ethereum.Value.fromAddress (TIER))
      call.push (ethereum.Value.fromBytes (data[i]))
      calls.push (call)
    }
  const mock = createMockedFunction (MULTICALL, "aggregate", AGGREGATE)
      .withArgs ([ethereum.Value.fromTupleArray (calls)])
  if (reverts)
    mock.reverts ()
  else
    mock.returns ([uint (PACK_START_HEIGHT), ethereum.Value.fromBytesArray (results)])
}

function mockPacks (ids: i32[], max: i32[], secondary: i32 = 100,
                    num: i32 = 10): void
{
  /* Matchstick's derived lookup order is unspecified, just as callers must
     not assume an order for the tier's clubs.  Match responses by club ID.  */
  const clubs = SaleTier.load (TIER)!.clubs.load ()
  for (let start = 0; start < clubs.length; start += 25)
    {
      const maxCalls: Bytes[] = []
      const availability: Bytes[] = []
      const previewCalls: Bytes[] = []
      const previews: Bytes[] = []
      for (let i = start; i < clubs.length && i < start + 25; ++i)
        {
          const id = clubs[i].clubId
          const n = max[ids.indexOf (id)]
          maxCalls.push (maxCall (id))
          availability.push (ethereum.encode (uint (n))!)
          if (n > 0)
            {
              previewCalls.push (previewCall (id))
              previews.push (ethereum.encode (
                  ethereum.Value.fromTuple (preview (id, secondary, num)))!)
            }
        }
      mockBatch (maxCalls, availability)
      if (previewCalls.length > 0)
        mockBatch (previewCalls, previews)
    }
}

function addClub (id: i32): void
{
  const club = new SaleClub (Bytes.fromI32 (id))
  club.clubId = id
  club.tier = TIER
  club.minted = 990
  club.trancheIndex = -1
  club.remainingInTranche = 0
  club.save ()
}

function seedTier (): void
{
  clearStore ()
  const tier = new SaleTier (TIER)
  tier.name = "test"
  tier.active = true
  tier.save ()
  const step = new PricingStep (TIER.concatI32 (0))
  step.tier = TIER
  step.index = 0
  step.numShares = 1000
  step.price = BigInt.fromI32 (10)
  step.fromTotal = 0
  step.toTotal = 999
  step.save ()
}

function refresh (height: i32 = PACK_START_HEIGHT): void
{
  const ev = changetype<SeedUpdated> (newMockEvent ())
  ev.address = TIER
  ev.block.number = BigInt.fromI32 (height)
  handleSeedUpdated (ev)
}

function assertPack (id: i32, max: i32, secondary: i32 = 100,
                     num: i32 = 10): void
{
  const key = Bytes.fromI32 (id)
  assert.fieldEquals ("Pack", key.toHexString (), "primaryClub", key.toHexString ())
  assert.fieldEquals ("Pack", key.toHexString (), "maxPacks", max.toString ())
  assert.fieldEquals ("Pack", key.toHexString (), "cost", (1234 + id).toString ())
  const shares = Pack.load (key)!.shares.load ()
  assert.i32Equals (shares.length, 2)
  for (let i = 0; i < shares.length; ++i)
    {
      const sh = shares[i]
      const clubId = sh.club.toI32 ()
      assert.assertTrue (clubId == id || clubId == secondary)
      assert.bytesEquals (sh.id, key.concat (sh.club))
      assert.bytesEquals (sh.pack, key)
      assert.i32Equals (sh.num, clubId == id ? num : 3)
    }
  assert.i32Equals (SaleClub.load (key)!.containedInPacks.load ().length, 1)
  assert.fieldEquals ("SaleClub", key.toHexString (), "trancheIndex", "0")
  assert.fieldEquals ("SaleClub", key.toHexString (), "remainingInTranche", "10")
}

beforeEach (seedTier)

describe ("full-tier pack refresh", () => {

  test ("does not call contracts for an empty tier or before the start height", () => {
    refresh ()
    addClub (1)
    refresh (PACK_START_HEIGHT - 1)
    assert.entityCount ("Pack", 0)
  })

  test ("initialises a tier without refreshing before the start height", () => {
    clearStore ()
    createMockedFunction (TIER, "tier", "tier():(string)")
        .returns ([ethereum.Value.fromString ("new tier")])
    createMockedFunction (TIER, "paused", "paused():(bool)")
        .returns ([ethereum.Value.fromBoolean (true)])
    refresh (PACK_START_HEIGHT - 1)
    assert.fieldEquals ("SaleTier", TIER.toHexString (), "name", "new tier")
    assert.fieldEquals ("SaleTier", TIER.toHexString (), "active", "false")
  })

  test ("preserves preview alignment across unavailable clubs and partial packs", () => {
    addClub (1)
    addClub (2)
    addClub (3)
    mockPacks ([1, 2, 3], [4, 0, 1], 100, 2)
    refresh ()
    assertPack (1, 4, 100, 2)
    assertPack (3, 1, 100, 2)
    assert.notInStore ("Pack", Bytes.fromI32 (2).toHexString ())
    assert.entityCount ("Pack", 2)
    assert.entityCount ("PackShareContent", 4)
    assert.entityCount ("InfluenceMint", 0)
    assert.entityCount ("PacksBought", 0)
  })

  test ("replaces old share relations and removes unavailable packs", () => {
    addClub (1)
    addClub (2)
    mockPacks ([1, 2], [4, 5])
    refresh ()
    mockPacks ([1, 2], [2, 0], 101)
    refresh (PACK_START_HEIGHT + 1)
    assertPack (1, 2, 101)
    assert.notInStore ("Pack", Bytes.fromI32 (2).toHexString ())
    assert.notInStore ("PackShareContent",
        Bytes.fromI32 (1).concat (Bytes.fromI32 (100)).toHexString ())
    assert.entityCount ("PackShareContent", 2)
  })

  test ("cleans up an entirely unavailable tier and restores it on a later refresh", () => {
    addClub (1)
    mockPacks ([1], [4])
    refresh ()
    mockPacks ([1], [0])
    refresh (PACK_START_HEIGHT + 1)
    assert.entityCount ("Pack", 0)
    assert.entityCount ("PackShareContent", 0)
    mockPacks ([1], [2])
    refresh (PACK_START_HEIGHT + 2)
    assertPack (1, 2)
  })

  test ("bounds reads to 25 clubs and handles the final partial batch", () => {
    const ids: i32[] = []
    const max: i32[] = []
    for (let i = 1; i <= 51; ++i)
      {
        addClub (i)
        ids.push (i)
        max.push (i)
      }
    mockPacks (ids, max)
    refresh ()
    for (let i = 1; i <= 51; ++i)
      assertPack (i, i)
    assert.entityCount ("Pack", 51)
    assert.entityCount ("PackShareContent", 102)
  })

  test ("keeps the individual mint refresh compatible with batched pack writes", () => {
    addClub (1)
    mockPacks ([1], [4])
    refresh ()
    createMockedFunction (TIER, "getMaxPacks", "getMaxPacks(uint256):(uint256)")
        .withArgs ([uint (1)]).returns ([uint (2)])
    createMockedFunction (TIER, "preview",
        "preview(uint256,uint256):((uint256,uint256,uint256,uint256,(uint256,uint256)[],uint256[]))")
        .withArgs ([uint (1), uint (1)])
        .returns ([ethereum.Value.fromTuple (preview (1, 101))])
    const ev = changetype<SharesMinted> (newMockEvent ())
    ev.parameters = [
      new ethereum.EventParam ("clubId", uint (1)),
      new ethereum.EventParam ("num", uint (1)),
      new ethereum.EventParam ("receiver", ethereum.Value.fromString ("buyer")),
      new ethereum.EventParam ("totalMinted", uint (990)),
      new ethereum.EventParam ("remaining", uint (10)),
    ]
    handleSharesMinted (ev)
    assertPack (1, 2, 101)
    assert.entityCount ("PackShareContent", 2)
    assert.entityCount ("InfluenceMint", 1)
  })

  test ("refreshes tranches when the pricing event changes the ladder", () => {
    addClub (1)
    mockPacks ([1], [1])
    const step = new ethereum.Tuple ()
    step.push (uint (1200))
    step.push (uint (20))
    const ev = changetype<PricingUpdated> (newMockEvent ())
    ev.address = TIER
    ev.block.number = BigInt.fromI32 (PACK_START_HEIGHT)
    ev.parameters = [new ethereum.EventParam ("steps",
        ethereum.Value.fromTupleArray ([step]))]
    handlePricingUpdated (ev)
    assert.fieldEquals ("SaleClub", Bytes.fromI32 (1).toHexString (),
                        "trancheIndex", "0")
    assert.fieldEquals ("SaleClub", Bytes.fromI32 (1).toHexString (),
                        "remainingInTranche", "210")
    assert.entityCount ("PricingStep", 1)
    assert.entityCount ("Pack", 1)
  })

  test ("removes a departing club's pack before refreshing the remaining tier", () => {
    addClub (1)
    addClub (2)
    mockPacks ([1, 2], [4, 5])
    refresh ()
    mockBatch ([maxCall (1)], [ethereum.encode (uint (3))!])
    mockBatch ([previewCall (1)], [ethereum.encode (
        ethereum.Value.fromTuple (preview (1, 101)))!])
    const ev = changetype<ClubRemoved> (newMockEvent ())
    ev.address = TIER
    ev.block.number = BigInt.fromI32 (PACK_START_HEIGHT)
    ev.parameters = [new ethereum.EventParam ("clubId", uint (2))]
    handleClubRemoved (ev)
    assertPack (1, 3, 101)
    assert.notInStore ("Pack", Bytes.fromI32 (2).toHexString ())
    assert.entityCount ("PackShareContent", 2)
    assert.i32Equals (SaleTier.load (TIER)!.clubs.load ().length, 1)
  })

})

describe ("batch read failures", () => {

  test ("does not turn a reverted availability read into zero availability", () => {
    mockBatch ([maxCall (1)], [], true)
    readMaxPacks (TIER, [1])
  }, true)

  test ("does not hide a failed preview", () => {
    mockBatch ([previewCall (1)], [], true)
    readPreviews (TIER, [1])
  }, true)

  test ("rejects an incomplete batch", () => {
    mockBatch ([maxCall (1), maxCall (2)], [ethereum.encode (uint (1))!])
    readMaxPacks (TIER, [1, 2])
  }, true)

  test ("rejects malformed availability data", () => {
    mockBatch ([maxCall (1)], [Bytes.fromHexString ("0x1234")])
    readMaxPacks (TIER, [1])
  }, true)

  test ("rejects malformed preview data", () => {
    mockBatch ([previewCall (1)], [Bytes.fromHexString ("0x1234")])
    readPreviews (TIER, [1])
  }, true)

})
