import {
  ReferrerUpdated as ReferrerUpdatedEvent
} from "../generated/ReferralTracker/ReferralTracker"

import {
  Referral,
  Referrer
} from "../generated/schema"

import { BigInt, ethereum, store } from "@graphprotocol/graph-ts"

export function createPackSaleTiers (block: ethereum.Block): void
{
  /* TODO: Instantiate the pack-sale tier template for each of the
     contracts we have, so we can listen to their events.  */
}

export function handleReferrerUpdated (event: ReferrerUpdatedEvent): void
{

}
