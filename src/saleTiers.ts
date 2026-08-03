import {
  SharesMinted as SharesMintedEvent,
} from "../generated/ClubMinter/ClubMinter"

import {
  ClubAdded as ClubAddedEvent,
  ClubRemoved as ClubRemovedEvent,
  ClubSalePaused as ClubSalePausedEvent,
  Paused as PausedEvent,
  Unpaused as UnpausedEvent,
  PacksBought as PacksBoughtEvent,
  PricingUpdated as PricingUpdatedEvent,
  SeedUpdated as SeedUpdatedEvent,
  SwappingPackSale,
} from "../generated/templates/PackSaleForShop/SwappingPackSale"

import {
  PacksBought as VoucherPacksBoughtEvent,
  Transfer as VoucherTransferEvent,
} from "../generated/PackVoucher/PackVoucher"

import {
  InfluenceMint,
  Pack,
  PackShareContent,
  PacksBought,
  PricingStep,
  SaleClub,
  SaleTier,
  TxMints,
} from "../generated/schema"

import {
  PackSaleForShop,
} from "../generated/templates"

import {
  PACK_START_HEIGHT,
  SALE_CONTRACTS,
} from "./config"

import {
  Address,
  BigInt,
  Bytes,
  ValueKind,
  ethereum,
  log,
  store,
} from "@graphprotocol/graph-ts"

/* ************************************************************************** */

/**
 * Convert the clubId as i32 to the SaleClub entity ID (which is Bytes).
 */
function clubEntityId (clubId: i32): Bytes
{
  return Bytes.fromI32 (clubId)
}

/**
 * Removes all data stored about a given pack primary club.
 */
function removeClubsPack (clubId: i32): void
{
  const entityId = clubEntityId (clubId)
  const club = SaleClub.load (entityId)
  if (club == null)
    return

  const pack = Pack.load (entityId)
  if (pack == null)
    return

  const shares = pack.shares.load ()
  for (let i = 0; i < shares.length; ++i)
    store.remove ("PackShareContent", shares[i].id.toHexString ())
  store.remove ("Pack", entityId.toHexString ())
}

/**
 * Refreshes the pack data for the given primary club.
 */
function refreshClubsPack (clubId: i32): void
{
  removeClubsPack (clubId)

  const entityId = clubEntityId (clubId)
  const club = SaleClub.load (entityId)
  if (club == null)
    return

  /* This essentially checks if club.tier is null, and if so, returns, otherwise
     continues with the bytes value.  But directly doing that causes an
     internal compiler error with AssemblyScript.  */
  const tierValue = club.get ("tier")
  if (!tierValue || tierValue.kind == ValueKind.NULL)
    return
  const tier = tierValue.toBytes ()

  const contract = SwappingPackSale.bind (Address.fromBytes (tier))
  const maxPacks = contract.getMaxPacks (BigInt.fromI32 (clubId)).toI32 ()
  if (maxPacks <= 0)
    return

  const prev = contract.preview (BigInt.fromI32 (clubId), BigInt.fromI32 (1))

  const pack = new Pack (entityId)
  pack.primaryClub = entityId
  pack.maxPacks = maxPacks
  pack.cost = prev.cost
  pack.save ()

  for (let i = 0; i < prev.shares.length; ++i)
    {
      const thisClubId = clubEntityId (prev.shares[i].clubId.toI32 ())
      const sh = new PackShareContent (entityId.concat (thisClubId))
      sh.pack = entityId
      sh.club = thisClubId
      sh.num = prev.shares[i].numShares.toI32 ()
      sh.save ()
    }
}

/**
 * Returns the tier a club is currently being sold in, or null if it is not
 * for sale at the moment.
 */
function currentTier (club: SaleClub): SaleTier | null
{
  /* Same as in refreshClubsPack, we need to access the tier in this way
     to avoid an internal compiler error.  */
  const tierValue = club.get ("tier")
  if (!tierValue || tierValue.kind == ValueKind.NULL)
    return null
  return SaleTier.load (tierValue.toBytes ())
}

/**
 * Refreshes a club's tranche / remainingInTranche data.
 */
function refreshClubTranche (clubId: i32): void
{
  const club = SaleClub.load (clubEntityId (clubId))
  if (club == null)
    return

  const tier = currentTier (club)
  if (tier == null)
    {
      club.trancheIndex = -1
      club.remainingInTranche = 0
      club.save ()
      return
    }
  const pricing = tier.pricingSteps.load ()

  /* Go through the pricing steps to find which one we are currently in.  Note
     that toTotal is the value at which the tranche is still in effect,
     one less than the total at which the next tranche applies.  */
  for (let i = 0; i < pricing.length; ++i)
    if (club.minted <= pricing[i].toTotal)
      {
        club.trancheIndex = i
        club.remainingInTranche = pricing[i].toTotal + 1 - club.minted
        club.save ()
        return
      }

  /* We didn't find any matching tranche.  */
  club.trancheIndex = -1
  club.remainingInTranche = 0
  club.save ()
}

/**
 * Computes what it costs, in USD base units, to mint "num" shares of a club
 * that already has "mintedBefore" shares minted, walking the given pricing
 * steps the way the sale contract itself does.
 *
 * This is the entire reason a pack's single price can be split across the
 * clubs it contains: the sale does not charge a bundle price, it charges each
 * club's shares at that club's own current tranche.  A mint can span several
 * tranches, so this is never one price times a count.
 *
 * Exported for the tests, which check it against real purchases.
 */
export function costForMint (steps: PricingStep[], mintedBefore: i32,
                             num: i32): BigInt
{
  if (num <= 0)
    return BigInt.fromI32 (0)

  const to = mintedBefore + num
  let cost = BigInt.fromI32 (0)
  let lastTotal = -1
  let lastPrice = BigInt.fromI32 (0)

  /* We do not rely on the order the pricing steps come back in, only on the
     ranges they declare.  */
  for (let i = 0; i < steps.length; ++i)
    {
      const stepFrom = steps[i].fromTotal > mintedBefore
          ? steps[i].fromTotal : mintedBefore
      const stepTo = steps[i].toTotal + 1 < to ? steps[i].toTotal + 1 : to
      if (stepTo > stepFrom)
        cost = cost.plus (BigInt.fromI32 (stepTo - stepFrom).times (steps[i].price))
      if (steps[i].toTotal > lastTotal)
        {
          lastTotal = steps[i].toTotal
          lastPrice = steps[i].price
        }
    }

  /* Shares minted beyond the end of the ladder keep the last tranche's price.
     A handful of clubs have run past their final tranche, and pricing the
     overflow at zero would quietly report those shares as free, which is the
     one thing this must never say by accident.  */
  if (lastTotal >= 0 && to > lastTotal + 1)
    {
      const from = mintedBefore > lastTotal + 1 ? mintedBefore : lastTotal + 1
      cost = cost.plus (BigInt.fromI32 (to - from).times (lastPrice))
    }

  return cost
}

/**
 * Returns the tier whose ladder prices a club's mints right now: the tier
 * the club is actively sold in, or failing that the one that paused it.  A
 * paused club still has its ladder -- the sale pauses a club by removing it
 * from the tier when it sells out, and the premine and later give-aways
 * really did mint shares of sold-out clubs afterwards.  Pricing those at
 * zero would report the most sold-out clubs' shares as free.  This is
 * deliberately NOT used for the tranche/shop data, where "paused" must
 * keep meaning "not for sale".
 */
function pricingTier (club: SaleClub): SaleTier | null
{
  const tier = currentTier (club)
  if (tier != null)
    return tier

  /* Same accessor dance as in currentTier, for the same compiler reason.  */
  const pausedValue = club.get ("pausedInTier")
  if (!pausedValue || pausedValue.kind == ValueKind.NULL)
    return null
  return SaleTier.load (pausedValue.toBytes ())
}

/**
 * Loads or creates the per-transaction bookkeeping row.  Its mints are a
 * derived lookup, so there is nothing to maintain beyond its existence and
 * the voucher-burn counter.
 */
function txMintsRow (txHash: Bytes): TxMints
{
  let row = TxMints.load (txHash)
  if (row == null)
    {
      row = new TxMints (txHash)
      row.voucherBurns = 0
      row.save ()
    }
  return row
}

/**
 * Records one influence mint, priced at the tranches it consumed.  We do this
 * for every mint and not just the paid ones, because the unpaid mints (the
 * premine, admin allocations, referral bonuses) move the sale's tranche
 * counter just as much, and because valuing what someone received for free
 * needs the same number.
 */
function recordInfluenceMint (event: SharesMintedEvent, club: SaleClub): void
{
  const num = event.params.num.toI32 ()
  const queue = txMintsRow (event.transaction.hash)

  const mint = new InfluenceMint (
      event.transaction.hash.concatI32 (event.logIndex.toI32 ()))
  mint.timestamp = event.block.timestamp
  mint.height = event.block.number
  mint.txHash = event.transaction.hash
  mint.tx = queue.id
  mint.voucherInvocation = queue.voucherBurns
  mint.referralBonus = false
  mint.club = club.id
  mint.receiver = event.params.receiver
  mint.num = num
  /* totalMinted is the contract's own counter after this mint.  */
  mint.mintedBefore = event.params.totalMinted.toI32 () - num

  /* The tier is read as it stands right now, which is the point of doing this
     here: the club may be removed from the tier later (the sale removes a club
     in the very transaction whose purchase sold it out), and by then there
     would be no ladder left to price this mint with.  */
  const tier = pricingTier (club)
  if (tier == null)
    {
      mint.usdCost = BigInt.fromI32 (0)
    }
  else
    {
      mint.tier = tier.id
      mint.usdCost = costForMint (tier.pricingSteps.load (),
                                  mint.mintedBefore, num)
    }

  mint.save ()
}

/**
 * Marks the referral-bonus mint that the ReferralBonusGiven event just
 * reported, so that no later purchase in the same transaction can claim it:
 * the bonus goes to the REFERRER, and if a later purchase in the very same
 * transaction buys for that referrer, a plain receiver match would hand the
 * free bonus to it.  Called from the referral tracker's handler, which runs
 * right after the bonus mint (the sale emits the two back to back).
 */
export function markReferralBonusMint (txHash: Bytes, referrer: string,
                                       clubId: BigInt, num: BigInt): void
{
  const queue = TxMints.load (txHash)
  if (queue == null)
    return

  const club = clubId.toI32 ()
  const n = num.toI32 ()
  const mints = queue.mints.load ()
  for (let i = 0; i < mints.length; ++i)
    {
      const mint = mints[i]
      /* Any unclaimed, unmarked mint matching the bonus exactly IS the
         bonus: the referrer's paid mints have been claimed by their own
         purchase by the time the bonus is given, and a later purchase's
         mints do not exist yet.  */
      const prev = mint.get ("purchase")
      const unclaimed = !prev || prev.kind == ValueKind.NULL
      const matches = unclaimed && !mint.referralBonus
          && mint.receiver == referrer
          && mint.club.toI32 () == club
          && mint.num == n
      if (matches)
        {
          mint.referralBonus = true
          mint.save ()
          return
        }
    }
}

/**
 * Handles the voucher token's ERC-20 transfers.  Only the burn matters:
 * batchRedeem burns the invocation's whole cost before it mints anything,
 * so the burn count delimits invocations within one transaction -- and the
 * invocation, not the transaction, is the boundary the voucher validates
 * costs at.
 */
export function handleVoucherTransfer (event: VoucherTransferEvent): void
{
  if (event.params.to.toHexString () != Address.zero ().toHexString ())
    return

  const queue = txMintsRow (event.transaction.hash)
  queue.voucherBurns = queue.voucherBurns + 1
  queue.save ()
}

/**
 * Refreshes the pack data for all clubs in a tier.
 */
function refreshTierPacks (addr: Address): void
{
  const tier = SaleTier.load (addr)!
  const clubs = tier.clubs.load ()

  /* We use warning level here since info is spammed with the batch writes
     that are done per block, so those would just drown in there.  They are not
     really "something going wrong", though.  */
  log.warning ("Starting full refresh of packs in tier: {}", [tier.name])
  for (let i = 0; i < clubs.length; ++i)
    {
      refreshClubsPack (clubs[i].clubId)
      refreshClubTranche (clubs[i].clubId)
    }
  log.warning ("Finished pack refresh for tier: {}", [tier.name])
}

/* ************************************************************************** */

export function handleSharesMinted (event: SharesMintedEvent): void
{
  const id = clubEntityId (event.params.clubId.toI32 ())
  let club = SaleClub.load (id)
  if (club == null)
    {
      club = new SaleClub (id)
      club.clubId = event.params.clubId.toI32 ()
      /* For now, fill in dummy values for the required tranche
         fields.  They will be updated below.  */
      club.trancheIndex = -1
      club.remainingInTranche = 0
    }
  club.minted = event.params.totalMinted.toI32 ()
  club.save ()

  /* Record what this mint cost, while the tranche the sale charged for it is
     still the current one.  */
  recordInfluenceMint (event, club)

  /* Update the tranche information.  */
  refreshClubTranche (event.params.clubId.toI32 ())

  /* All packs that contain the club need to be updated.  */
  const packs = club.containedInPacks.load ()
  for (let i = 0; i < packs.length; ++i)
    {
      const pack = Pack.load (packs[i].pack)!
      const primaryClub = SaleClub.load (pack.primaryClub)!
      refreshClubsPack (primaryClub.clubId)
    }
}

export function handleClubAdded (event: ClubAddedEvent): void
{
  const id = clubEntityId (event.params.clubId.toI32 ())
  let club = SaleClub.load (id)
  if (club == null)
    {
      club = new SaleClub (id)
      club.clubId = event.params.clubId.toI32 ()
      club.minted = 0
      club.trancheIndex = -1
      club.remainingInTranche = 0
    }
  club.tier = event.address
  club.pausedInTier = null
  club.save ()

  if (event.block.number.toI32 () >= PACK_START_HEIGHT)
    refreshTierPacks (event.address)
}

export function handleClubRemoved (event: ClubRemovedEvent): void
{
  removeClubsPack (event.params.clubId.toI32 ())

  const club = SaleClub.load (clubEntityId (event.params.clubId.toI32 ()))!
  club.tier = null
  /* In the contract, ClubSalePaused is emitted after ClubRemoved.  So if the
     club is "removed" because it is paused, this is fine, and we will later
     set "pausedInTier" accordingly.  But the club might also be removed
     entirely.  */
  club.pausedInTier = null
  club.save ()

  if (event.block.number.toI32 () >= PACK_START_HEIGHT)
    refreshTierPacks (event.address)
}

export function handleClubSalePaused (event: ClubSalePausedEvent): void
{
  const club = SaleClub.load (clubEntityId (event.params.clubId.toI32 ()))!
  club.tier = null
  club.pausedInTier = event.address
  club.save ()
}

export function handleSalePaused (event: PausedEvent): void
{
  let tier = SaleTier.load (event.address)
  if (tier != null)
    {
      tier.active = false
      tier.save ()
    }
}

export function handleSaleUnpaused (event: UnpausedEvent): void
{
  let tier = SaleTier.load (event.address)
  if (tier != null)
    {
      tier.active = true
      tier.save ()
    }
}

export function handlePricingUpdated (event: PricingUpdatedEvent): void
{
  const tier = SaleTier.load (event.address)!

  /* Clear out all old pricing steps recorded.  */
  {
    const steps = tier.pricingSteps.load ()
    for (let i = 0; i < steps.length; ++i)
      store.remove ("PricingStep", tier.id.concatI32 (i).toHexString ())
  }

  /* Add the new pricing steps.  */
  const steps = event.params.steps
  let total = 0
  for (let i = 0; i < steps.length; ++i)
    {
      const step = new PricingStep (tier.id.concatI32 (i))
      step.tier = tier.id
      step.index = i
      step.numShares = steps[i].num.toI32 ()
      step.price = steps[i].price

      step.fromTotal = total
      total += steps[i].num.toI32 ()
      step.toTotal = total - 1

      step.save ()
    }

  if (event.block.number.toI32 () >= PACK_START_HEIGHT)
    refreshTierPacks (event.address)
}

export function handleSeedUpdated (event: SeedUpdatedEvent): void
{
  /* If the tier entity is not yet created, do so now.  This is "lazy
     initialisation" of the entity, because we can only initialise it once
     the contract has been deployed (not in the "once" handler).  Upon
     contract deployment, a first SeedUpdated event is emitted.  */

  let tier = SaleTier.load (event.address)
  if (tier == null)
    {
      const contract = SwappingPackSale.bind (event.address)
      tier = new SaleTier (event.address)
      tier.name = contract.tier ()
      tier.active = !contract.paused ()
      tier.save ()
    }

  if (event.block.number.toI32 () >= PACK_START_HEIGHT)
    refreshTierPacks (event.address)
}

/**
 * Records a pack purchase.  The two payment routes emit the very same event
 * with the same USD cost, so they share this; they differ only in whether the
 * emitting contract is one of the sale tiers.
 */
function recordPacksBought (event: ethereum.Event, buyer: Address,
                            receiver: string, primaryClubId: BigInt,
                            numPacks: BigInt, cost: BigInt,
                            tier: Bytes | null, voucher: bool): void
{
  const id = event.transaction.hash.concatI32 (event.logIndex.toI32 ())
  const ev = new PacksBought (id)
  ev.timestamp = event.block.timestamp
  ev.height = event.block.number
  ev.txHash = event.transaction.hash
  ev.buyer = buyer
  ev.receiver = receiver
  ev.primaryClub = clubEntityId (primaryClubId.toI32 ())
  ev.tier = tier
  ev.numPacks = numPacks.toI32 ()
  ev.usdSpent = cost
  ev.save ()

  /* Claim the mints this purchase paid for.  Both sale paths mint an
     operation's shares immediately before emitting its PacksBought, so
     they are all recorded by now; mints claimed by an earlier purchase of
     the same transaction stay claimed, which is what splits a voucher
     batch holding two purchases for one receiver correctly.  The referral
     bonus is minted to the referrer only after the buyer's own PacksBought
     and gets marked before any later purchase's events, so it can never be
     claimed even by a later purchase FOR the referrer.  */
  const queue = TxMints.load (event.transaction.hash)
  if (queue == null)
    return
  const txMints = queue.mints.load ()
  const claimed: InfluenceMint[] = []
  for (let i = 0; i < txMints.length; ++i)
    {
      const mint = txMints[i]
      /* Same accessor dance as in currentTier, for the same compiler
         reason.  */
      const prev = mint.get ("purchase")
      const unclaimed = !prev || prev.kind == ValueKind.NULL
      if (unclaimed && !mint.referralBonus && mint.receiver == receiver)
        {
          mint.purchase = id
          claimed.push (mint)
        }
    }

  /* The voucher's batchRedeem validates every operation's cost before it
     mints anything, so when operations of one invocation contain the same
     club, all of them are charged from the supply the invocation started
     at -- not from the counter their mints then actually moved.  Re-price
     the claimed mints from that invocation-start supply so their sum stays
     exactly what this purchase paid.  The invocation, not the transaction,
     is the boundary: batchRedeem is public, and a second call in the same
     transaction validates against the supply the first one moved.  Without
     an overlap (every invocation on chain so far) the start supply IS the
     mint's own mintedBefore and this recomputes the identical number.  The
     direct sale path re-validates per purchase instead, so its
     running-counter price is already exact and is left alone.  */
  if (voucher)
    for (let i = 0; i < claimed.length; ++i)
      {
        const mint = claimed[i]
        const tierValue = mint.get ("tier")
        if (!tierValue || tierValue.kind == ValueKind.NULL)
          continue
        /* The club IDs are Bytes.fromI32 of the club id, so comparing the
           i32 avoids the Bytes "==" overload, which crashes the compiler
           (same class of problem as the ValueKind dance above).  */
        let base = mint.mintedBefore
        const mintClub = mint.club.toI32 ()
        for (let j = 0; j < txMints.length; ++j)
          if (txMints[j].club.toI32 () == mintClub
                && txMints[j].voucherInvocation == mint.voucherInvocation
                && txMints[j].mintedBefore < base)
            base = txMints[j].mintedBefore
        if (base == mint.mintedBefore)
          continue
        const mintTier = SaleTier.load (tierValue.toBytes ())!
        mint.usdCost = costForMint (mintTier.pricingSteps.load (),
                                    base, mint.num)
      }

  let claimedSum = BigInt.fromI32 (0)
  for (let i = 0; i < claimed.length; ++i)
    {
      claimed[i].save ()
      claimedSum = claimedSum.plus (claimed[i].usdCost)
    }

  /* The exactness invariant this whole entity exists for.  It should never
     fire; if it ever does, the affected purchase is easy to find.  */
  if (!claimedSum.minus (cost).isZero ())
    log.warning ("PacksBought {}: claimed mints sum to {}, usdSpent is {}",
                 [id.toHexString (), claimedSum.toString (),
                  cost.toString ()])
}

export function handlePacksBought (event: PacksBoughtEvent): void
{
  recordPacksBought (event, event.params.buyer, event.params.receiver,
                     event.params.primaryClubId, event.params.numPacks,
                     event.params.cost, event.address, false)
}

export function handleVoucherPacksBought (event: VoucherPacksBoughtEvent): void
{
  /* Packs paid for with SVV are sold by a separate voucher contract, which
     emits the identical event with the identical USD cost (it swaps SVV for
     the pack, it does not price it differently).  Those purchases are
     otherwise invisible here, and some accounts have never bought any other
     way.  The voucher is not a SaleTier, hence the null.  */
  recordPacksBought (event, event.params.buyer, event.params.receiver,
                     event.params.primaryClubId, event.params.numPacks,
                     event.params.cost, null, true)
}

/* ************************************************************************** */

export function createPackSaleTiers (block: ethereum.Block): void
{
  SALE_CONTRACTS.forEach ((addr) => {
    PackSaleForShop.create (Address.fromString (addr));

    /* At this point in time, the contract has not actually been deployed.
       We will initialise the SaleTier instance (with its name from the
       contract) later when the seed-update event is received first.  */
  });
}
