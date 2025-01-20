import {
  SharesMinted as SharesMintedEvent,
} from "../generated/ClubMinter/ClubMinter"

import {
  ClubAdded as ClubAddedEvent,
  ClubRemoved as ClubRemovedEvent,
  ClubSalePaused as ClubSalePausedEvent,
  Paused as PausedEvent,
  Unpaused as UnpausedEvent,
  PricingUpdated as PricingUpdatedEvent,
  SeedUpdated as SeedUpdatedEvent,
  SwappingPackSale,
} from "../generated/templates/PackSaleForShop/SwappingPackSale"

import {
  SaleClub,
  SaleTier,
  PricingStep,
} from "../generated/schema"

import {
  PackSaleForShop,
} from "../generated/templates"

import {
  SALE_CONTRACTS,
} from "./config"

import {
  Address,
  Bytes,
  ethereum,
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

/* ************************************************************************** */

export function handleSharesMinted (event: SharesMintedEvent): void
{
  const id = clubEntityId (event.params.clubId.toI32 ())
  let club = SaleClub.load (id)
  if (club == null)
    {
      club = new SaleClub (id)
      club.clubId = event.params.clubId.toI32 ()
    }
  club.minted = event.params.totalMinted.toI32 ()
  club.save ()
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
    }
  club.tier = event.address
  club.pausedInTier = null
  club.save ()
}

export function handleClubRemoved (event: ClubRemovedEvent): void
{
  const club = SaleClub.load (clubEntityId (event.params.clubId.toI32 ()))!
  club.tier = null
  /* In the contract, ClubSalePaused is emitted after ClubRemoved.  So if the
     club is "removed" because it is paused, this is fine, and we will later
     set "pausedInTier" accordingly.  But the club might also be removed
     entirely.  */
  club.pausedInTier = null
  club.save ()
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
