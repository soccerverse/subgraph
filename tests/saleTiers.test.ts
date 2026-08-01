import {
  assert,
  describe,
  test,
} from "matchstick-as/assembly/index"

import {
  BigInt,
  Bytes,
} from "@graphprotocol/graph-ts"

import {
  PricingStep,
} from "../generated/schema"

import {
  costForMint,
} from "../src/saleTiers"

/* ************************************************************************** */

/* The ladder of tier 0x167360a5, exactly as its PricingUpdated event wrote it:
   a 10,000-share opening tranche and then fourteen of 20,000 each, so the last
   one covers cumulative positions 270000..289999.  */
const NUM_SHARES: i32[] = [10000, 20000, 20000, 20000, 20000, 20000, 20000,
                           20000, 20000, 20000, 20000, 20000, 20000, 20000,
                           20000]
const PRICES: i32[] = [6500, 8125, 9750, 13000, 19500, 26000, 32500, 39000,
                       45500, 65000, 78000, 91000, 104000, 117000, 130000]

/**
 * Builds the pricing steps for that ladder.  They are not saved to the store:
 * costForMint reads the ranges off the entities and nothing else.
 */
function ladder (): PricingStep[]
{
  const steps: PricingStep[] = []
  let total = 0
  for (let i = 0; i < NUM_SHARES.length; ++i)
    {
      const step = new PricingStep (Bytes.fromI32 (i))
      step.tier = Bytes.fromI32 (0)
      step.index = i
      step.numShares = NUM_SHARES[i]
      step.price = BigInt.fromI32 (PRICES[i])
      step.fromTotal = total
      total += NUM_SHARES[i]
      step.toTotal = total - 1
      steps.push (step)
    }
  return steps
}

/* ************************************************************************** */

describe ("costForMint", () => {

  /* This is a real purchase, checked against the chain: block 77349411, 90
     packs of club 1687's pack, for which the contract charged 176,962,500.
     Each club in the pack is priced at its own tranche and nothing else, and
     the seven parts add back up to what was actually paid.  That exactness is
     the whole basis for splitting a pack price across its clubs, so if this
     ever goes red the split has stopped matching what the sale charged.  */
  test ("prices a real pack purchase, club by club", () => {
    const steps = ladder ()

    /* club 840, already 9052 minted, 900 more: still inside the opening
       tranche.  */
    assert.bigIntEquals (BigInt.fromI32 (5850000),
                         costForMint (steps, 9052, 900))
    /* club 1687, the primary, eight tranches higher up at 135056.  */
    assert.bigIntEquals (BigInt.fromString ("140400000"),
                         costForMint (steps, 135056, 3600))
    /* club 2738, 3502, 3999 and 4507, all still in the opening tranche.  */
    assert.bigIntEquals (BigInt.fromI32 (5850000),
                         costForMint (steps, 6240, 900))
    assert.bigIntEquals (BigInt.fromI32 (5850000),
                         costForMint (steps, 8410, 900))
    assert.bigIntEquals (BigInt.fromI32 (5850000),
                         costForMint (steps, 760, 900))
    assert.bigIntEquals (BigInt.fromI32 (5850000),
                         costForMint (steps, 3750, 900))
    /* club 14276 has already moved into the second tranche.  */
    assert.bigIntEquals (BigInt.fromI32 (7312500),
                         costForMint (steps, 10890, 900))

    let total = costForMint (steps, 135056, 3600)
    total = total.plus (costForMint (steps, 9052, 900))
    total = total.plus (costForMint (steps, 6240, 900))
    total = total.plus (costForMint (steps, 8410, 900))
    total = total.plus (costForMint (steps, 760, 900))
    total = total.plus (costForMint (steps, 3750, 900))
    total = total.plus (costForMint (steps, 10890, 900))
    assert.bigIntEquals (BigInt.fromString ("176962500"), total)
  })

  test ("splits a mint that spans a tranche boundary", () => {
    /* 500 shares at the opening price and 500 at the next one, not 1000 at
       either.  */
    assert.bigIntEquals (BigInt.fromI32 (500 * 6500 + 500 * 8125),
                         costForMint (ladder (), 9500, 1000))
  })

  test ("keeps the last price for shares past the end of the ladder", () => {
    /* A few clubs have minted past their final tranche.  Charging zero for the
       overflow would report those shares as free.  */
    assert.bigIntEquals (BigInt.fromI32 (1000 * 130000 + 1000 * 130000),
                         costForMint (ladder (), 289000, 2000))
    assert.bigIntEquals (BigInt.fromI32 (100 * 130000),
                         costForMint (ladder (), 300000, 100))
  })

  test ("does not depend on the order of the pricing steps", () => {
    const reversed = ladder ().reverse ()
    assert.bigIntEquals (costForMint (ladder (), 9500, 1000),
                         costForMint (reversed, 9500, 1000))
    assert.bigIntEquals (costForMint (ladder (), 300000, 100),
                         costForMint (reversed, 300000, 100))
  })

  test ("charges nothing for nothing", () => {
    assert.bigIntEquals (BigInt.fromI32 (0), costForMint (ladder (), 0, 0))
    assert.bigIntEquals (BigInt.fromI32 (0), costForMint ([], 0, 500))
  })

})
